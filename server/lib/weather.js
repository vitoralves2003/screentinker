'use strict';

/*
 * Weather for the widget — fetched and cached ON THE SERVER, per city.
 *
 * The old widget called wttr.in straight from the panel. That was wrong in four ways at once:
 * every screen made its own request (a fleet of 50 panels is 50 calls for one city), a panel with
 * no route to the public internet rendered nothing, the response came back in ENGLISH ("Patchy
 * rain nearby" on a Brazilian screen), and the city was resolved by NAME — which silently picks
 * the wrong place when the name is ambiguous. All four are fixed here: one request per city
 * shared by every screen, `lang=pt`, and coordinates instead of names (see lib/cities-br.js).
 *
 * KEEP-LAST-GOOD, like lib/lottery.js. Weather changes slowly and a cached reading is still
 * broadly true an hour later, so a failed refresh keeps the previous value rather than blanking
 * the panel. A shop wall showing yesterday's "22°C" is fine; a black rectangle is a support call.
 *
 * SOURCE NOTE: wttr.in is a community service with no commercial-use restriction, which is why it
 * is used rather than Open-Meteo — Open-Meteo's free tier is explicitly non-commercial and this
 * is a paid product. If wttr.in ever needs replacing, the shape below is the only contract:
 * swap fetchCity() and nothing downstream changes.
 */

const appSettings = require('./app-settings');
const { findCity } = require('./cities-br');

const TIMEOUT_MS = 12000;
const TTL_MS = (parseInt(process.env.WEATHER_TTL_MINUTES) || 30) * 60 * 1000;
const CACHE_PREFIX = 'weather.';

const inFlight = new Map();   // cityId -> promise, so a fleet asking at once is ONE upstream call

/*
 * Minimum spacing between upstream calls, ACROSS ALL CITIES.
 *
 * wttr.in rate-limits, and it bites: firing several city lookups back to back during testing got
 * a "fetch failed" on the third while the first two succeeded, and the same city worked perfectly
 * on its own moments later. An operator with weather widgets for six cities would hit exactly
 * that burst. Per-city caching alone does not prevent it — the cities are different keys — so the
 * queue below is what keeps us a well-behaved guest on a free community service.
 */
const MIN_GAP_MS = parseInt(process.env.WEATHER_MIN_GAP_MS) || 1500;
let gate = Promise.resolve();
function spaced(fn) {
  const run = gate.then(fn, fn);
  gate = run.then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)),
                  () => new Promise((r) => setTimeout(r, MIN_GAP_MS)));
  return run;
}

function cacheKey(cityId) { return CACHE_PREFIX + cityId; }

function readCache(cityId) {
  const raw = appSettings.get(cacheKey(cityId), null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeCache(cityId, data) {
  try { appSettings.set(cacheKey(cityId), JSON.stringify(data)); }
  catch (e) { console.warn(`[weather] could not persist ${cityId}: ${e.message}`); }
}

/* Normalise wttr.in's shape into the only one the widget knows about. */
function normalise(city, d) {
  const cur = d.current_condition?.[0];
  if (!cur) throw new Error('no current_condition in response');

  // lang_pt is only present when ?lang=pt was accepted; fall back rather than show nothing.
  const desc = cur.lang_pt?.[0]?.value || cur.weatherDesc?.[0]?.value || '';

  const days = (d.weather || []).slice(0, 3).map((w) => ({
    date: w.date,
    min: Math.round(Number(w.mintempC)),
    max: Math.round(Number(w.maxtempC)),
    code: w.hourly?.[4]?.weatherCode || cur.weatherCode,   // midday is more representative than 00:00
  }));

  return {
    city_id: city.id,
    city: city.label,
    uf: city.uf,
    temp: Math.round(Number(cur.temp_C)),
    feels_like: Math.round(Number(cur.FeelsLikeC)),
    humidity: Number(cur.humidity),
    wind_kph: Math.round(Number(cur.windspeedKmph)),
    code: cur.weatherCode,
    description: desc,
    days,
    fetchedAt: Date.now(),
  };
}

async function fetchCity(city) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // Coordinates, not the name — see lib/cities-br.js for why that distinction matters.
    const url = `https://wttr.in/${city.lat},${city.lon}?format=j1&lang=pt`;
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'curl/8 LoopPlayer-Signage', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalise(city, await res.json());
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(cityId) {
  const city = findCity(cityId);
  if (!city) return null;
  try {
    const data = await spaced(() => fetchCity(city));
    writeCache(cityId, data);
    console.log(`[weather] ${city.label}/${city.uf}: ${data.temp}°C ${data.description}`);
    return data;
  } catch (err) {
    console.warn(`[weather] refresh failed for ${cityId} (${err.message}) — keeping cached value`);
    return null;
  }
}

/*
 * The value to serve. Fresh cache is returned immediately; a stale one is returned NOW and
 * refreshed in the background, so a screen never waits on somebody else's API. Only a city with
 * nothing cached at all has to block, and only on its very first render.
 */
async function getWeather(cityId) {
  const city = findCity(cityId);
  if (!city) return null;

  const cached = readCache(cityId);
  const fresh = cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS;
  if (fresh) return { ...cached, stale: false };

  if (!inFlight.has(cityId)) {
    inFlight.set(cityId, refresh(cityId).finally(() => inFlight.delete(cityId)));
  }

  if (!cached) {
    const result = await inFlight.get(cityId);
    return result ? { ...result, stale: false } : null;
  }
  return { ...cached, stale: true };
}

module.exports = { getWeather, refresh, TTL_MS };
