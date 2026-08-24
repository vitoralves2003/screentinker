'use strict';

/*
 * One list: which screens run it, what it holds, and what it actually broadcast.
 *
 * The play half of this only exists because play_logs started recording playlist_id. Before that
 * release there was no way to ask "what did this list put on air" at all — the plays knew their
 * screen and their file and nothing about where they came from. Rows from before it stay out of
 * the answer rather than being attributed by guessing what each screen runs today.
 */

const { db } = require('../db/database');
const { usableZone, dayKey, dayRange, shiftDays } = require('./zoned-day');
const { effectiveDeviceTz } = require('./device-timezone');
const { screensRunning } = require('./reach');
const { buildMatrix, columnsFor, columnOf } = require('./report-matrix');

const BUCKET = 900;

const _playlist = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?');

function visiblePlaylist(workspaceId, playlistId) {
  if (!workspaceId) return null;
  const p = _playlist.get(playlistId);
  return p && p.workspace_id === workspaceId ? p : null;
}

/*
 * What the list holds right now: files, widgets, and the sub-lists it rotates through.
 *
 * Structural, so it is true the day the list is built and does not wait for history. A sub-list
 * slot is one item of the parent however many items the sub-list contains, which is why it is
 * named as a sub-list rather than flattened into the count.
 */
function contents(playlistId) {
  return db.prepare(`
    SELECT pi.id,
           pi.content_id,
           pi.widget_id,
           pi.sub_playlist_id,
           COALESCE(c.filename, w.name, sub.name) AS name,
           CASE WHEN pi.sub_playlist_id IS NOT NULL THEN 'sublist'
                WHEN pi.widget_id       IS NOT NULL THEN 'widget'
                ELSE 'file' END AS kind
    FROM playlist_items pi
    LEFT JOIN content   c   ON c.id   = pi.content_id
    LEFT JOIN widgets   w   ON w.id   = pi.widget_id
    LEFT JOIN playlists sub ON sub.id = pi.sub_playlist_id
    WHERE pi.playlist_id = ?
    ORDER BY pi.id
  `).all(playlistId);
}

function playlistSummary({ workspaceId, playlistId, start, end }) {
  const list = visiblePlaylist(workspaceId, playlistId);
  if (!list) return null;

  const screens = screensRunning(workspaceId, [playlistId]);
  const items = contents(playlistId);

  /*
   * The period is resolved in the zone of a screen that runs THIS list, when there is one — the
   * days a list report talks about are the days of the screens showing it. With no screen running
   * it there is no such calendar, and UTC is named as the stand-in rather than silently used.
   */
  const anchorRow = screens.length
    ? db.prepare('SELECT timezone, reported_timezone FROM devices WHERE id = ?').get(screens[0].id)
    : null;
  const anchorTz = usableZone(effectiveDeviceTz(anchorRow || {})) || 'UTC';

  const to = end || dayKey(Math.floor(Date.now() / 1000), anchorTz);
  const from = start || shiftDays(to, -29);

  // A day of slack each side: a screen fourteen hours from the anchor has plays inside the
  // requested local day that fall outside the anchor's. The exact edges are trimmed below.
  const [rawStart] = dayRange(shiftDays(from, -1), anchorTz);
  const [, rawEnd] = dayRange(shiftDays(to, 1), anchorTz);

  const groups = db.prepare(`
    SELECT pl.device_id,
           d.name AS device_name,
           d.timezone,
           d.reported_timezone,
           pl.content_id,
           pl.widget_id,
           pl.content_name,
           (pl.started_at / ${BUCKET}) * ${BUCKET} AS bucket,
           COUNT(*) AS plays,
           COALESCE(SUM(pl.duration_sec), 0) AS seconds
    FROM play_logs pl
    JOIN devices d ON d.id = pl.device_id
    WHERE pl.playlist_id = ? AND d.workspace_id = ?
      AND pl.started_at >= ? AND pl.started_at <= ?
    GROUP BY pl.device_id, pl.content_id, pl.widget_id, pl.content_name, bucket
  `).all(playlistId, workspaceId, rawStart, rawEnd);

  const cols = columnsFor(from, to);
  const byItem = new Map();
  const byScreen = new Map();
  const entries = [];
  let plays = 0;
  let seconds = 0;

  for (const g of groups) {
    // Each play is filed under the day of the screen that made it, not the anchor's — the anchor
    // only decides which days were asked for.
    const tz = usableZone(effectiveDeviceTz(g)) || 'UTC';
    const date = dayKey(g.bucket, tz);
    if (date < from || date > to) continue;

    const key = g.content_id ? `c:${g.content_id}` : (g.widget_id ? `w:${g.widget_id}` : `n:${g.content_name}`);
    let item = byItem.get(key);
    if (!item) {
      item = { key, name: g.content_name || '--', content_id: g.content_id, widget_id: g.widget_id, plays: 0, seconds: 0 };
      byItem.set(key, item);
    }
    item.plays += g.plays;
    item.seconds += g.seconds;

    let scr = byScreen.get(g.device_id);
    if (!scr) {
      scr = { id: g.device_id, name: g.device_name, plays: 0, seconds: 0 };
      byScreen.set(g.device_id, scr);
    }
    scr.plays += g.plays;
    scr.seconds += g.seconds;

    plays += g.plays;
    seconds += g.seconds;
    entries.push({
      key: g.device_id,
      name: g.device_name,
      kind: 'screen',
      col: columnOf(g.bucket, tz, cols.kind),
      plays: g.plays,
    });
  }

  return {
    playlist: { id: list.id, name: list.name },
    window: { start: from, end: to },
    timezone_anchor: anchorTz,
    reach: {
      screens,
      screen_count: screens.length,
      items,
      item_count: items.length,
    },
    totals: {
      plays,
      seconds,
      distinct_items: byItem.size,
      distinct_screens: byScreen.size,
    },
    by_item: [...byItem.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name, 'pt-BR')),
    by_screen: [...byScreen.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name, 'pt-BR')),
    matrix: buildMatrix({ entries, cols }),
  };
}

module.exports = { playlistSummary, visiblePlaylist, contents };
