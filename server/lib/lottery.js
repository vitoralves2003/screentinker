'use strict';

/*
 * Loop OS lottery widget data — Mega-Sena results, fetched and cached ON THE SERVER.
 *
 * WHY NOT FROM THE PLAYER. The clock and weather widgets fetch from the device, which is fine
 * for those. It is not fine here: a fleet of screens all polling the same public endpoint is a
 * self-inflicted DDoS on someone else's API, every panel would need to survive its CORS policy,
 * and a TV WebView with no network at boot would render an empty widget. The server fetches once
 * for the whole install and the widget reads /api/widgets/:id/data.json — the same shape the
 * directory-board widget already uses.
 *
 * KEEP-LAST-GOOD IS THE CONTRACT. A draw happens twice a week; a cached result is correct for
 * days. So a failed refresh NEVER overwrites the cache and never surfaces an error to the screen
 * — the widget keeps showing the last known draw with its date, which is honest and readable,
 * rather than "unavailable" on a wall in a shop. Same best-effort discipline as thumbnails and
 * media compression elsewhere in this codebase.
 *
 * TWO SOURCES, deliberately. The primary is Caixa's own endpoint — authoritative and fast. The
 * fallback is the community mirror the brief suggested; it is a free Heroku dyno, and Heroku
 * ended free dynos in 2022, so it is the LESS durable of the two despite being the one named.
 * Both were verified live and agreed on the same draw before this was written.
 */

const config = require('../config');
const appSettings = require('./app-settings');

const TIMEOUT_MS = 12000;
const CACHE_KEY = 'lottery.megasena';

// A draw is Wednesday and Saturday evening, so anything under a few hours is generous. The
// refresh is also lazy (see getLatest) — nothing polls on a schedule if no screen is asking.
const TTL_MS = (parseInt(process.env.LOTTERY_TTL_HOURS) || 6) * 3600 * 1000;

const SOURCES = [
  {
    name: 'caixa',
    url: 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena',
    parse: (d) => ({
      contest: d.numero,
      date: d.dataApuracao,
      numbers: Array.isArray(d.listaDezenas) ? d.listaDezenas : [],
      accumulated: !!d.acumulado,
      nextDate: d.dataProximoConcurso || null,
      nextEstimate: d.valorEstimadoProximoConcurso || null,
      // Faixa 1 is the six-number tier — the only one worth the space on a screen.
      winners: d.listaRateioPremio?.find((p) => p.faixa === 1)?.numeroDeGanhadores ?? null,
      prize: d.listaRateioPremio?.find((p) => p.faixa === 1)?.valorPremio ?? null,
    }),
  },
  {
    name: 'loteriascaixa-api',
    url: 'https://loteriascaixa-api.herokuapp.com/api/megasena/latest',
    parse: (d) => ({
      contest: d.concurso,
      date: d.data,
      numbers: Array.isArray(d.dezenas) ? d.dezenas : [],
      accumulated: !!d.acumulou,
      nextDate: d.dataProximoConcurso || null,
      nextEstimate: d.valorEstimadoProximoConcurso || null,
      // This mirror names the tier fields differently from Caixa's own: faixa 1 carries
      // `ganhadores`, not `numeroDeGanhadores`. Verified against the live response.
      winners: d.premiacoes?.find((p) => p.faixa === 1)?.ganhadores ?? null,
      prize: d.premiacoes?.find((p) => p.faixa === 1)?.valorPremio ?? null,
    }),
  },
];

let inFlight = null;   // dedupes concurrent refreshes — a fleet hitting data.json at once must
                       // produce ONE upstream request, not one per device.

function readCache() {
  const raw = appSettings.get(CACHE_KEY, null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeCache(result) {
  try { appSettings.set(CACHE_KEY, JSON.stringify(result)); } catch (e) {
    console.warn(`[lottery] could not persist cache: ${e.message}`);
  }
}

async function fetchFrom(source) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: ctl.signal,
      headers: {
        // Some government endpoints reject a default/absent agent. Identifying ourselves is also
        // simply the polite thing to do against a free public API.
        'User-Agent': 'LoopOS-Signage/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = source.parse(await res.json());
    // A response that parsed but carries no draw is a schema change, not a result. Treat it as a
    // failure so the good cache survives instead of being replaced by an empty widget.
    if (!parsed.contest || !parsed.numbers.length) throw new Error('response missing contest/numbers');
    return { ...parsed, game: 'megasena', source: source.name, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Refresh from upstream, trying each source in order. Returns the new result, or null when every
 * source failed — in which case the CACHE IS LEFT ALONE and the caller serves the old value.
 */
async function refresh() {
  const errors = [];
  for (const source of SOURCES) {
    try {
      const result = await fetchFrom(source);
      writeCache(result);
      console.log(`[lottery] megasena concurso ${result.contest} (${result.date}) via ${source.name}`);
      return result;
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }
  // Warn, never throw: the caller's job is to serve a screen, not to propagate this.
  console.warn(`[lottery] all sources failed (${errors.join('; ')}) — keeping cached result`);
  return null;
}

/*
 * The value to serve. Returns the cache immediately when fresh; when stale it triggers a refresh
 * and — importantly — still returns the STALE value if the refresh fails.
 *
 * `stale` is reported so the widget can caption honestly rather than implying the number is live.
 */
async function getLatest() {
  const cached = readCache();
  const fresh = cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS;
  if (fresh) return { ...cached, stale: false };

  // One refresh at a time regardless of how many screens ask simultaneously.
  if (!inFlight) {
    inFlight = refresh().finally(() => { inFlight = null; });
  }

  // With nothing cached at all there is no choice but to wait — a first-ever render has nothing
  // to fall back on. With a stale value in hand, serve it NOW and let the refresh land for the
  // next poll; a screen must never block on someone else's API.
  if (!cached) {
    const result = await inFlight;
    return result ? { ...result, stale: false } : null;
  }
  return { ...cached, stale: true };
}

/*
 * Warm the cache at boot and keep it warm. Called from server.js. The interval is unref'd so it
 * never holds the process open, and the first fetch is delayed past startup so it does not
 * compete with boot work.
 */
function start() {
  if (!config.lottery.enabled) return;
  setTimeout(() => { refresh().catch(() => { /* refresh() already logged */ }); }, 20000).unref();
  setInterval(() => { refresh().catch(() => { /* refresh() already logged */ }); }, TTL_MS).unref();
}

module.exports = { getLatest, refresh, start, CACHE_KEY, SOURCES, TTL_MS };
