'use strict';

/*
 * Loop Player lottery widget data — Caixa results, fetched and cached ON THE SERVER.
 *
 * WHY NOT FROM THE PLAYER. A fleet of screens all polling the same public endpoint is a
 * self-inflicted DDoS on someone else's API, every panel would need to survive its CORS policy,
 * and a TV WebView with no network at boot would render an empty widget. The server fetches once
 * for the whole install and the widget reads /api/widgets/:id/data.json.
 *
 * KEEP-LAST-GOOD IS THE CONTRACT. A draw happens a few times a week; a cached result is correct
 * for days. So a failed refresh NEVER overwrites the cache and never surfaces an error to the
 * screen — the widget keeps showing the last known draw with its date, which is honest and
 * readable, rather than "unavailable" on a wall in a shop.
 *
 * SIX GAMES, ONE SHAPE. Each modality differs in ball count (5 for Quina, 20 for Lotomania) and
 * in what it carries beyond the numbers — Dupla Sena draws TWICE, Timemania adds a football club.
 * normalise() flattens all of that into one payload so the widget has a single contract to
 * render, and adding a seventh game later is a row in GAMES rather than a new code path.
 */

const config = require('../config');
const appSettings = require('./app-settings');

const TIMEOUT_MS = 12000;
const TTL_MS = (parseInt(process.env.LOTTERY_TTL_HOURS) || 6) * 3600 * 1000;

// Caixa's own endpoint is authoritative and fast. The community mirror is the documented
// fallback; note it runs on a free Heroku dyno — a tier Heroku ended in 2022 — so it is the LESS
// durable of the two despite being the better-known one. Both verified live before shipping.
const CAIXA = 'https://servicebus2.caixa.gov.br/portaldeloterias/api';
const MIRROR = 'https://loteriascaixa-api.herokuapp.com/api';

/*
 * `balls` is the count the game actually draws. It is not cosmetic: the widget sizes the balls
 * from it, because 20 Lotomania numbers laid out at Mega-Sena's ball size overflow the screen.
 */
const GAMES = {
  megasena:  { id: 'megasena',  label: 'Mega-Sena',  slug: 'megasena',  mirror: 'megasena',  balls: 6,  accent: '#20DF91' },
  quina:     { id: 'quina',     label: 'Quina',      slug: 'quina',     mirror: 'quina',     balls: 5,  accent: '#5B8DEF' },
  lotofacil: { id: 'lotofacil', label: 'Lotofácil',  slug: 'lotofacil', mirror: 'lotofacil', balls: 15, accent: '#C86DD7' },
  lotomania: { id: 'lotomania', label: 'Lotomania',  slug: 'lotomania', mirror: 'lotomania', balls: 20, accent: '#F5A524' },
  duplasena: { id: 'duplasena', label: 'Dupla Sena', slug: 'duplasena', mirror: 'duplasena', balls: 6,  accent: '#E5484D' },
  timemania: { id: 'timemania', label: 'Timemania',  slug: 'timemania', mirror: 'timemania', balls: 7,  accent: '#00C2B8' },
};

const inFlight = new Map();   // per game, so a fleet asking at once is ONE upstream request

function cacheKey(gameId) { return 'lottery.' + gameId; }

function readCache(gameId) {
  const raw = appSettings.get(cacheKey(gameId), null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeCache(gameId, result) {
  try { appSettings.set(cacheKey(gameId), JSON.stringify(result)); }
  catch (e) { console.warn(`[lottery] could not persist ${gameId}: ${e.message}`); }
}

// Faixa 1 is the top tier — the only one worth the space on a screen.
function topTier(list) {
  return (list || []).find((p) => p.faixa === 1) || null;
}

// Only Timemania draws a club, but Caixa returns the field for EVERY game, padded with NUL
// bytes when there is nothing to report. String.trim() strips whitespace, not NULs, so the
// padding survives as a truthy string and the widget renders an empty "Time do coracao" block
// on Mega-Sena, Quina and the rest. Strip control characters first, then collapse the padding
// Caixa leaves inside the name itself ("BOTAFOGO         /SP" -> "BOTAFOGO/SP").
function cleanClub(value) {
  if (!value) return null;
  const s = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/* Caixa's shape -> ours. */
function fromCaixa(game, d) {
  const t = topTier(d.listaRateioPremio);
  return {
    contest: d.numero,
    date: d.dataApuracao,
    numbers: Array.isArray(d.listaDezenas) ? d.listaDezenas : [],
    // Dupla Sena is the only game with a second draw; empty for everyone else.
    numbers2: Array.isArray(d.listaDezenasSegundoSorteio) ? d.listaDezenasSegundoSorteio : [],
    accumulated: !!d.acumulado,
    nextDate: d.dataProximoConcurso || null,
    nextEstimate: d.valorEstimadoProximoConcurso || null,
    winners: t ? (t.numeroDeGanhadores ?? null) : null,
    prize: t ? (t.valorPremio ?? null) : null,
    extra: cleanClub(d.nomeTimeCoracaoMesSorte),
  };
}

/* The community mirror names its fields differently — verified against the live response. */
function fromMirror(game, d) {
  const t = (d.premiacoes || []).find((p) => p.faixa === 1) || null;
  return {
    contest: d.concurso,
    date: d.data,
    numbers: Array.isArray(d.dezenas) ? d.dezenas : [],
    numbers2: Array.isArray(d.dezenas2) ? d.dezenas2 : [],
    accumulated: !!d.acumulou,
    nextDate: d.dataProximoConcurso || null,
    nextEstimate: d.valorEstimadoProximoConcurso || null,
    winners: t ? (t.ganhadores ?? null) : null,
    prize: t ? (t.valorPremio ?? null) : null,
    extra: cleanClub(d.timeCoracao),
  };
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      // Some government endpoints reject a default/absent agent, and identifying ourselves is
      // simply the polite thing to do against a free public API.
      headers: { 'User-Agent': 'LoopPlayer-Signage/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

/*
 * Refresh one game, trying Caixa then the mirror. Returns the new result, or null when both
 * failed — in which case THE CACHE IS LEFT ALONE and the caller serves the old value.
 */
async function refresh(gameId = 'megasena') {
  const game = GAMES[gameId];
  if (!game) return null;

  // Source names are part of the stored payload (widgets and the cache carry `source`), so they
  // stay exactly as they were before the widget grew past Mega-Sena.
  const sources = [
    { name: 'caixa', url: `${CAIXA}/${game.slug}`, parse: fromCaixa },
    { name: 'loteriascaixa-api', url: `${MIRROR}/${game.mirror}/latest`, parse: fromMirror },
  ];

  const errors = [];
  for (const src of sources) {
    try {
      const parsed = src.parse(game, await getJson(src.url));
      // A response that parsed but carries no draw is a schema change, not a result. Treat it as
      // a failure so the good cache survives instead of being replaced by an empty widget.
      if (!parsed.contest || !parsed.numbers.length) throw new Error('response missing contest/numbers');

      const result = {
        ...parsed,
        game: game.id,
        game_label: game.label,
        accent: game.accent,
        ball_count: game.balls,
        source: src.name,
        fetchedAt: Date.now(),
      };
      writeCache(gameId, result);
      console.log(`[lottery] ${game.label} concurso ${result.contest} (${result.date}) via ${src.name}`);
      return result;
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  // Warn, never throw: the caller's job is to serve a screen, not to propagate this.
  console.warn(`[lottery] ${game.label}: all sources failed (${errors.join('; ')}) — keeping cached result`);
  return null;
}

/*
 * The value to serve. Fresh cache is returned immediately; a stale one is returned NOW and
 * refreshed behind it, so a screen never blocks on someone else's API. Only a game with nothing
 * cached at all has to wait, and only on its first ever render.
 */
async function getLatest(gameId = 'megasena') {
  const game = GAMES[gameId] ? gameId : 'megasena';

  const cached = readCache(game);
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) return { ...cached, stale: false };

  if (!inFlight.has(game)) {
    inFlight.set(game, refresh(game).finally(() => inFlight.delete(game)));
  }
  if (!cached) {
    const result = await inFlight.get(game);
    return result ? { ...result, stale: false } : null;
  }
  return { ...cached, stale: true };
}

/*
 * Warm the caches at boot and keep them warm.
 *
 * Games are refreshed one at a time with a gap rather than all six at once: the same burst that
 * got the weather lookups rate-limited applies here, and six simultaneous requests to a
 * government endpoint is exactly the kind of thing that gets an IP blocked. Unref'd so it never
 * holds the process open.
 */
function start() {
  if (!config.lottery.enabled) return;

  const ids = Object.keys(GAMES);
  const sweep = () => {
    ids.forEach((id, i) => {
      setTimeout(() => { refresh(id).catch(() => { /* refresh() already logged */ }); }, i * 2500).unref();
    });
  };
  setTimeout(sweep, 20000).unref();
  setInterval(sweep, TTL_MS).unref();
}

// CACHE_KEY is Mega-Sena's key, unchanged from when it was the only game — every other game
// gets its own row alongside it, so caches written before this widget grew are still read.
module.exports = { getLatest, refresh, start, GAMES, TTL_MS, CACHE_KEY: cacheKey('megasena') };
