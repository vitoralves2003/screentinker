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

/*
 * One side of a fixture. `crest` is ESPN's numeric team id, NOT a URL — the widget asks this
 * server for /api/widgets/crest/<id>.png and the server is the only thing that ever talks to
 * ESPN's CDN. Passing the URL through instead would mean every panel fetches a third-party host
 * directly, which fails behind the restricted networks these screens usually sit on, and would
 * turn the proxy into an open redirect for whatever URL the upstream decided to send.
 */
function side(s) {
  return {
    name: shortName(s.team),
    crest: s.team?.id ? String(s.team.id) : null,
    score: s.score ?? null,
  };
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
      home: side(home),
      away: side(away),
    };
  });
  if (!matches.length) throw new Error('scoreboard returned no events');
  return { competition: j.leagues?.[0]?.season?.type?.name || 'Brasileirão Série A', matches, fetchedAt: Date.now() };
}

async function fetchTable() {
  const j = await getJson(STANDINGS_URL);
  // ESPN nests standings differently between competition types; accept either shape.
  const entries = j.children?.[0]?.standings?.entries || j.standings?.entries || [];
  const rows = entries.map((e) => {
    const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.displayValue]));
    return {
      rank: Number(s.rank) || null,
      // shortDisplayName, same as the fixtures view: "Athletico Paranaense" wraps to two lines in
      // a table column and "Athletico-PR" does not.
      team: shortName(e.team),
      crest: e.team?.id ? String(e.team.id) : null,
      points: Number(s.points) || 0,
      played: Number(s.gamesPlayed) || 0,
      won: Number(s.wins) || 0,
      draw: Number(s.ties) || 0,
      lost: Number(s.losses) || 0,
      gd: s.pointDifferential ?? s.goalDifference ?? '0',
    };
  }).filter((r) => r.rank).sort((a, b) => a.rank - b.rank);

  if (!rows.length) throw new Error('standings returned no entries');

  /*
   * ESPN publishes no round number for this competition — scoreboard events carry week: null and
   * the competition notes are empty, both verified live. The round is therefore DERIVED from how
   * many matches the league has actually played. Sides are never all level mid-round (fixtures get
   * moved for cup ties and TV), so the highest count is the round currently being played, and once
   * a round finishes it is the round just completed — which is what a results widget should be
   * naming anyway.
   */
  const round = Math.max(0, ...rows.map((r) => r.played)) || null;
  return { rows, round, fetchedAt: Date.now() };
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

  // The round lives in the standings, which refresh once an hour, while scores refresh every few
  // minutes. Reading it across from the table cache is what lets the fixtures view be labelled
  // with the round without hitting the standings endpoint twelve times an hour for one integer.
  const withRound = (data) => {
    if (key !== 'matches') return data;
    const round = readCache('table')?.round || null;
    // Cold start: the fixtures view can be asked for before the standings have ever been fetched,
    // and then it has no round to show. Warm the table behind the response rather than blocking
    // on it — the label fills in on the next poll a couple of minutes later.
    if (!round && !inFlight.has('table')) {
      inFlight.set('table', refresh('table').finally(() => inFlight.delete('table')));
    }
    return { ...data, round, round_label: round ? `Série A · ${round}ª rodada` : 'Série A' };
  };

  const cached = readCache(key);
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < ttl) return withRound({ ...cached, stale: false });

  if (!inFlight.has(key)) {
    inFlight.set(key, refresh(key).finally(() => inFlight.delete(key)));
  }
  if (!cached) {
    const result = await inFlight.get(key);
    return result ? withRound({ ...result, stale: false }) : null;
  }
  return withRound({ ...cached, stale: true });
}

/* Warm both caches at boot, then keep them warm. Unref'd so it never holds the process open. */
function start() {
  if (process.env.FOOTBALL_ENABLED === 'false') return;
  setTimeout(() => { refresh('matches').catch(() => {}); refresh('table').catch(() => {}); }, 25000).unref();
  setInterval(() => refresh('matches').catch(() => {}), SCORE_TTL_MS).unref();
  setInterval(() => refresh('table').catch(() => {}), TABLE_TTL_MS).unref();
}

/*
 * Club crests, mirrored onto this server.
 *
 * WHY MIRROR AT ALL. A crest is the one thing on this widget that a passer-by recognises before
 * reading anything, and the panels showing it sit on shop and clinic networks that routinely
 * block everything except the signage host. Pointing a fleet of screens at a third-party CDN also
 * repeats the mistake this whole file exists to avoid: the fetch happens once here, not once per
 * panel per poll.
 *
 * WHY ONLY A NUMERIC ID. The obvious shape for this is /crest?url=..., and that is an open proxy:
 * anything that can reach this endpoint can make the server fetch an arbitrary address, including
 * ones only the server can reach. The id is checked to be digits and the host is a constant here,
 * so the worst a caller can do is ask ESPN for a crest that does not exist.
 *
 * Crests essentially never change, so a cached file is never revalidated — only re-fetched if it
 * was never stored.
 */
const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');

// ESPN's image combiner, which resizes server-side. The raw 500px crest is 124KB; the same crest
// at 240px is 38KB, and 240 covers the largest size this widget draws (the featured crest is about
// a third of the shorter screen edge). On a table view showing twenty clubs that is the difference
// between 2.5MB and 760KB over whatever connection the panel has.
const CREST_SIZE = 240;
const CREST_URL = (id) =>
  `https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/${id}.png&w=${CREST_SIZE}&h=${CREST_SIZE}`;
const CREST_DIR = path.join(config.paths?.dataDir || process.env.DATA_DIR || '.', 'cache', 'crests');
const crestInFlight = new Map();

async function crestFile(id) {
  if (!/^\d{1,8}$/.test(String(id))) return null;      // digits only — see above
  const file = path.join(CREST_DIR, `${id}.png`);
  if (fs.existsSync(file)) return file;

  if (!crestInFlight.has(id)) {
    crestInFlight.set(id, (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(CREST_URL(id), {
          signal: ctl.signal,
          headers: { 'User-Agent': 'LoopPlayer-Signage/1.0' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // A crest is a few tens of KB. Anything far larger is not a crest, and writing it would
        // let a bad upstream response fill the disk on a device with very little of it.
        if (!buf.length || buf.length > 512 * 1024) throw new Error(`unexpected size ${buf.length}`);
        fs.mkdirSync(CREST_DIR, { recursive: true });
        // Write then rename, so a crash mid-download cannot leave a truncated PNG cached forever.
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, file);
        return file;
      } catch (err) {
        console.warn(`[football] crest ${id} unavailable (${err.message})`);
        return null;
      } finally {
        clearTimeout(timer);
        crestInFlight.delete(id);
      }
    })());
  }
  return crestInFlight.get(id);
}

module.exports = { get, refresh, start, crestFile, SCORE_TTL_MS, TABLE_TTL_MS };
