'use strict';

/*
 * Everything about ONE file: where it is, where it reaches, and what it has actually done.
 *
 * Two halves that fail in completely different ways, and the page has to keep them apart:
 *
 *   STRUCTURAL — "in how many lists is this file, and on how many screens does it appear". Read
 *   from the current shape of things, so it is true the day the product is installed and it does
 *   not decay. This is most of what was asked for.
 *
 *   PLAY-BASED — "how many times did it play". Counted from play_logs, which is pruned at 90 days.
 *   An empty answer means "not in the window", never "never".
 *
 * The structural half is the one that is easy to get quietly wrong, because a wrong number here
 * looks exactly like a right one. See reach() below.
 */

const { db } = require('../db/database');
const { usableZone, dayKey, shiftDays } = require('./zoned-day');
const { effectiveDeviceTz } = require('./device-timezone');
const { buildMatrix, columnsFor, columnOf } = require('./report-matrix');
const { screensRunning, withParents } = require('./reach');

/*
 * Buckets for the daily series.
 *
 * Rows are grouped into quarter-hours in SQL before they reach JS. A busy file across a fleet is
 * hundreds of thousands of plays, and turning each one into a local date individually is work
 * proportional to plays rather than to days.
 *
 * A quarter hour is the largest bucket that is safe: every real UTC offset is a whole number of
 * fifteen minutes (Kathmandu is +05:45, the Chathams +12:45), so a bucket can never straddle
 * local midnight and be counted under the wrong date.
 */
const BUCKET = 900;

/*
 * The period as DATES, resolving the defaults.
 *
 * The grid below is columns of days, so "no period given" cannot stay implicit: it has to become
 * the thirty days it means, or the grid comes back with no columns and an empty body while the
 * totals beside it are full.
 */
function datesOf({ start, end }, tz) {
  const today = dayKey(Math.floor(Date.now() / 1000), tz);
  const to = end || today;
  const from = start || shiftDays(to, -29);
  return { from, to };
}

function windowOf({ start, end }) {
  const startEpoch = start
    ? Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000) - 86400 // a day of slack each side,
    : Math.floor(Date.now() / 1000) - 30 * 86400;                        // because the day belongs to
  const endEpoch = end                                                   // the screen, not to UTC — the
    ? Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000) + 86400   // exact edges are trimmed in JS
    : Math.floor(Date.now() / 1000);
  return { startEpoch, endEpoch };
}

const _file = db.prepare(`
  SELECT id, filename, mime_type, workspace_id, created_at, duration_sec, file_size
  FROM content WHERE id = ?
`);

function visibleFile(workspaceId, contentId) {
  if (!workspaceId) return null;
  const f = _file.get(contentId);
  return f && f.workspace_id === workspaceId ? f : null;
}

/*
 * Where this file REACHES — the number the operator is really asking for.
 *
 * Three ways a screen can be showing a file, and counting only the first is the trap:
 *
 *   1. the screen's main list contains it
 *   2. a ZONE of the screen's layout points at a list that contains it (multi-zone layouts assign
 *      a whole list per zone — device_zone_playlists)
 *   3. the file is in a list used as a SUB-LIST by a list one of the above runs
 *
 * The existing fleet-wide files report counts only (1), so it under-reports every file used in a
 * zone or a rotation — and an under-report is indistinguishable from a file that is simply used
 * less. Nesting is capped at one level by lib/sublists.js, so the parent lookup is a single step
 * rather than a walk; it is written as one step deliberately, because a recursive version would
 * silently paper over a nesting bug instead of the constraint holding.
 */
function reach(file) {
  const ws = file.workspace_id;

  const direct = db.prepare(`
    SELECT DISTINCT p.id, p.name
    FROM playlist_items pi
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE pi.content_id = ? AND p.workspace_id = ?
  `).all(file.id, ws);

  // The lists an operator would say the file "is in": the ones holding it, plus the ones that
  // rotate through those. Marked so the page can show the difference rather than implying the file
  // was added to a list nobody added it to.
  const playlists = [
    ...direct.map((x) => ({ id: x.id, name: x.name, via: null })),
    ...withParents(ws, direct.map((x) => x.id)).map((x) => ({ id: x.id, name: x.name, via: x.via_name })),
  ];

  return { playlists, screens: screensRunning(ws, playlists.map((x) => x.id)) };
}

/*
 * What it has actually played, by screen, by list and by day.
 *
 * ONE query, and every figure on the page derived from its result. The first version ran four —
 * totals, by screen, by list, by day — and only the last of them trimmed the window to the
 * screens' own days, so the tiles counted plays from a day the operator had not asked for while
 * the chart below them did not. Four queries is four chances for the same window to be read four
 * ways, and the disagreement is invisible: every number looks plausible on its own.
 *
 * Every day is the day the SCREEN was having. A file on a fleet spanning three timezones has no
 * single calendar, and picking the server's would file plays under dates on which the screens that
 * made them were not yet in that day.
 */
function activity(file, range) {
  const { startEpoch, endEpoch } = windowOf(range);
  const ws = file.workspace_id;
  const cols = columnsFor(range.from, range.to);

  /*
   * Grouped down to (screen, list, quarter-hour) in SQL. That is fine enough to rebuild every
   * breakdown from, and coarse enough that a file playing every fifteen seconds across a fleet
   * arrives as thousands of rows rather than hundreds of thousands.
   */
  const groups = db.prepare(`
    SELECT pl.device_id,
           d.name   AS device_name,
           d.status AS device_status,
           pl.playlist_id,
           COALESCE(p.name, NULLIF(pl.playlist_name, '')) AS list_name,
           (p.id IS NULL AND NULLIF(pl.playlist_name, '') IS NOT NULL) AS list_deleted,
           (pl.started_at / ${BUCKET}) * ${BUCKET} AS bucket,
           COUNT(*) AS plays,
           COALESCE(SUM(pl.duration_sec), 0) AS seconds,
           MIN(pl.started_at) AS first_at,
           MAX(pl.started_at) AS last_at
    FROM play_logs pl
    JOIN devices d ON d.id = pl.device_id
    LEFT JOIN playlists p ON p.id = pl.playlist_id
    WHERE pl.content_id = ? AND d.workspace_id = ?
      AND pl.started_at >= ? AND pl.started_at <= ?
    GROUP BY pl.device_id, pl.playlist_id, list_name, bucket
  `).all(file.id, ws, startEpoch, endEpoch);

  const zones = new Map();
  for (const d of db.prepare('SELECT id, timezone, reported_timezone FROM devices WHERE workspace_id = ?').all(ws)) {
    zones.set(d.id, usableZone(effectiveDeviceTz(d)) || 'UTC');
  }

  const perDay = new Map();
  const perScreen = new Map();
  const perList = new Map();
  let plays = 0;
  let seconds = 0;
  let firstPlay = null;
  let lastPlay = null;

  for (const g of groups) {
    const date = dayKey(g.bucket, zones.get(g.device_id) || 'UTC');
    /*
     * The trim, applied ONCE and to everything. windowOf() deliberately over-fetches a day on each
     * side: a screen fourteen hours ahead has plays inside the requested local day that fall
     * outside the UTC day of the same name, and a screen fourteen hours behind has the reverse.
     */
    if (date < range.from || date > range.to) continue;

    plays += g.plays;
    seconds += g.seconds;
    if (firstPlay === null || g.first_at < firstPlay) firstPlay = g.first_at;
    if (lastPlay === null || g.last_at > lastPlay) lastPlay = g.last_at;

    perDay.set(date, (perDay.get(date) || 0) + g.plays);

    let scr = perScreen.get(g.device_id);
    if (!scr) {
      scr = { id: g.device_id, name: g.device_name, status: g.device_status, plays: 0, seconds: 0, last_play: null };
      perScreen.set(g.device_id, scr);
    }
    scr.plays += g.plays;
    scr.seconds += g.seconds;
    if (scr.last_play === null || g.last_at > scr.last_play) scr.last_play = g.last_at;

    // Keyed by name as well as id, so two deleted lists — both stripped of their id by SET NULL —
    // do not merge into one row, and neither swallows the plays that recorded no list at all.
    const key = g.playlist_id ? `id:${g.playlist_id}` : (g.list_name ? `name:${g.list_name}` : 'none');
    let lst = perList.get(key);
    if (!lst) {
      lst = { playlist_id: g.playlist_id, name: g.list_name || null, deleted: !!g.list_deleted, plays: 0, seconds: 0 };
      perList.set(key, lst);
    }
    lst.plays += g.plays;
    lst.seconds += g.seconds;
  }

  const byDay = [...perDay.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([date, n]) => ({ date, plays: n }));

  /*
   * Screens down the side, hours or days across the top — the shape the competitor's per-file
   * report gets right, and the one that says the same thing in one page whatever the volume.
   *
   * Each play is placed in ITS OWN screen's column: a file on a screen in São Paulo and one in
   * Manaus plays at 11h on both, an hour apart in real time, and the hour an advertiser asks about
   * is the hour on the screen in front of the customer.
   */
  const entries = [];
  for (const g of groups) {
    const ztz = zones.get(g.device_id) || 'UTC';
    const date = dayKey(g.bucket, ztz);
    if (range.from && date < range.from) continue;
    if (range.to && date > range.to) continue;
    entries.push({
      key: g.device_id,
      name: g.device_name,
      kind: 'screen',
      col: columnOf(g.bucket, ztz, cols.kind),
      plays: g.plays,
    });
  }

  return {
    totals: {
      plays,
      seconds,
      first_play: firstPlay,
      last_play: lastPlay,
      // "Days on air" is days on which it played at all, not the span between the first and the
      // last — a file that ran twice a month apart has two days on air, not thirty-one.
      days_on_air: byDay.length,
    },
    by_screen: [...perScreen.values()].sort((x, y) => y.plays - x.plays || x.name.localeCompare(y.name, 'pt-BR')),
    by_list: [...perList.values()].sort((x, y) => y.plays - x.plays),
    by_day: byDay,
    matrix: buildMatrix({ entries, cols }),
  };
}

function fileReport({ workspaceId, contentId, start, end }) {
  const file = visibleFile(workspaceId, contentId);
  if (!file) return null;

  const structure = reach(file);

  /*
   * The period is resolved against the WORKSPACE's screens, not against one of them: a file report
   * spans a fleet that may sit in several zones, and there is no single "today" for it. The first
   * screen's zone is as good an anchor as any and is stated in the response, so a reader can see
   * which calendar the day boundaries came from.
   */
  const anchorTz = usableZone(effectiveDeviceTz(
    db.prepare('SELECT timezone, reported_timezone FROM devices WHERE workspace_id = ? ORDER BY created_at LIMIT 1')
      .get(file.workspace_id) || {}
  )) || 'UTC';
  const dates = datesOf({ start, end }, anchorTz);
  const played = activity(file, { start, end, ...dates });

  return {
    file: {
      id: file.id,
      filename: file.filename,
      mime_type: file.mime_type,
      duration_sec: file.duration_sec,
      file_size: file.file_size,
      created_at: file.created_at,
    },
    window: { start: dates.from, end: dates.to },
    timezone_anchor: anchorTz,
    reach: {
      playlists: structure.playlists,
      screens: structure.screens,
      // Counted here rather than in the page, so the tile and the list it expands into can never
      // disagree — which is what happens when two places count the same thing.
      playlist_count: structure.playlists.length,
      screen_count: structure.screens.length,
    },
    ...played,
  };
}

module.exports = { fileReport, reach, visibleFile, BUCKET };
