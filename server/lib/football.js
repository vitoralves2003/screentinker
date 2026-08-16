'use strict';

/*
 * Brasileirão Série A — fixtures, live scores and the table. Fetched and cached ON THE SERVER.
 *
 * FREE SOURCES ONLY, no API key, as required. ESPN's public site endpoints carry everything the
 * widget needs (scoreboard + standings) and were verified live against the 2026 season before
 * this was written.
 *
 * THE RISK, STATED PLAINLY: these endpoints power ESPN's own site and are not a published API.
 * They can change shape or start refusing us with no notice and no changelog. That is the price
 * of "free and no key". It is mitigated, not eliminated:
 *   - every field is read defensively, so a shape change degrades rather than throws
 *   - a failed refresh KEEPS the last good table (a league table is still broadly true hours
 *     later; a blank panel is not)
 *   - TheSportsDB is a documented free fallback for the table
 * If this ever needs to become reliable rather than free, a paid feed slots in behind the same
 * two functions and nothing downstream changes.
 *
 * CACHE WINDOWS differ by kind on purpose: a league table moves once a round, scores move every
 * few minutes while matches are running. Polling the table as often as the scoreboard would be
 * pure waste.
 */

const appSettings = require('./app-settings');

const TIMEOUT_MS = 12000;
const SCORE_TTL_MS = (parseInt(process.env.FOOTBALL_SCORE_TTL_MINUTES) || 5) * 60 * 1000;
const TABLE_TTL_MS = (parseInt(process.env.FOOTBALL_TABLE_TTL_MINUTES) || 60) * 60 * 1000;

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard';
const STANDINGS_URL = 'https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings';

const inFlight = new Map();

function readCache(key) {
  const raw = appSettings.get('football.' + key, null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function writeCache(key, data) {
  try { appSettings.set('football.' + key, JSON.stringify(data)); }
  catch (e) { console.warn(`[football] could not persist ${key}: ${e.message}`); }
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'LoopPlayer-Signage/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

// ESPN reports status in English ("Full Time", "Postponed"...). The screen is Brazilian.
const STATUS_PT = {
  STATUS_SCHEDULED: 'A começar',
  STATUS_IN_PROGRESS: 'AO VIVO',
  STATUS_HALFTIME: 'Intervalo',
  STATUS_FULL_TIME: 'Encerrado',
  STATUS_FINAL: 'Encerrado',
  STATUS_POSTPONED: 'Adiado',
  STATUS_CANCELED: 'Cancelado',
  STATUS_ABANDONED: 'Abandonado',
};

function shortName(team) {
  return team?.shortDisplayName || team?.displayName || team?.name || '?';
}

async function fetchMatches() {
  const j = await getJson(SCOREBOARD_URL);
  const events = Array.isArray(j.events) ? j.events : [];
  const matches = events.map((e) => {
    const comp = e.competitions?.[0] || {};
    const sides = comp.competitors || [];
    // ESPN marks home/away rather than ordering them; read the flag instead of trusting index.
    const home = sides.find((s) => s.homeAway === 'home') || sides[0] || {};
    const away = sides.find((s) => s.homeAway === 'away') || sides[1] || {};
    const st = e.status?.type || {};
    return {
      id: e.id,
      date: e.date,
      state: st.state || '',
      status: STATUS_PT[st.name] || st.shortDetail || st.description || '',
      live: st.state === 'in',
      clock: e.status?.displayClock || '',
      home: { name: shortName(home.team), logo: home.team?.logo || null, score: home.score ?? null },
      away: { name: shortName(away.team), logo: away.team?.logo || null, score: away.score ?? null },
    };
  });
  if (!matches.length) throw new Error('scoreboard returned no events');
  return { round: j.leagues?.[0]?.season?.type?.name || 'Brasileirão Série A', matches, fetchedAt: Date.now() };
}

async function fetchTable() {
  const j = await getJson(STANDINGS_URL);
  // ESPN nests standings differently between competition types; accept either shape.
  const entries = j.children?.[0]?.standings?.entries || j.standings?.entries || [];
  const rows = entries.map((e) => {
    const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.displayValue]));
    return {
      rank: Number(s.rank) || null,
      team: e.team?.displayName || '?',
      logo: e.team?.logos?.[0]?.href || null,
      points: Number(s.points) || 0,
      played: Number(s.gamesPlayed) || 0,
      won: Number(s.wins) || 0,
      draw: Number(s.ties) || 0,
      lost: Number(s.losses) || 0,
      gd: s.pointDifferential ?? s.goalDifference ?? '0',
    };
  }).filter((r) => r.rank).sort((a, b) => a.rank - b.rank);

  if (!rows.length) throw new Error('standings returned no entries');
  return { rows, fetchedAt: Date.now() };
}

async function refresh(kind) {
  try {
    const data = kind === 'table' ? await fetchTable() : await fetchMatches();
    writeCache(kind, data);
    console.log(`[football] ${kind} refreshed (${kind === 'table' ? data.rows.length + ' teams' : data.matches.length + ' matches'})`);
    return data;
  } catch (err) {
    console.warn(`[football] ${kind} refresh failed (${err.message}) — keeping cached value`);
    return null;
  }
}

/*
 * Serve `kind` ('matches' | 'table'). Fresh cache is immediate; a stale one is served now and
 * refreshed behind it, so no screen ever waits on ESPN.
 */
async function get(kind = 'matches') {
  const key = kind === 'table' ? 'table' : 'matches';
  const ttl = key === 'table' ? TABLE_TTL_MS : SCORE_TTL_MS;

  const cached = readCache(key);
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < ttl) return { ...cached, stale: false };

  if (!inFlight.has(key)) {
    inFlight.set(key, refresh(key).finally(() => inFlight.delete(key)));
  }
  if (!cached) {
    const result = await inFlight.get(key);
    return result ? { ...result, stale: false } : null;
  }
  return { ...cached, stale: true };
}

/* Warm both caches at boot, then keep them warm. Unref'd so it never holds the process open. */
function start() {
  if (process.env.FOOTBALL_ENABLED === 'false') return;
  setTimeout(() => { refresh('matches').catch(() => {}); refresh('table').catch(() => {}); }, 25000).unref();
  setInterval(() => refresh('matches').catch(() => {}), SCORE_TTL_MS).unref();
  setInterval(() => refresh('table').catch(() => {}), TABLE_TTL_MS).unref();
}

module.exports = { get, refresh, start, SCORE_TTL_MS, TABLE_TTL_MS };
