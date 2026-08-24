'use strict';

/*
 * One screen, aggregated: what it put on air over a period, and when.
 *
 * The counterpart of lib/exhibition.js, which returns the plays one by one. That shape belongs in
 * a CSV — an operator asking "what did this screen do last week" is not going to read forty
 * thousand rows, and putting them on a page is what made the screen's own page unreadable.
 *
 * Everything here is derived from ONE query, for the reason spelled out in lib/file-report.js: the
 * tiles, the grid and the ranking that disagree with each other are all individually plausible,
 * and nobody notices until they add them up.
 */

const { db } = require('../db/database');
const { usableZone, dayRange } = require('./zoned-day');
const { effectiveDeviceTz } = require('./device-timezone');
const { buildMatrix, columnsFor, columnOf } = require('./report-matrix');

// Same reasoning as lib/file-report.js: every real UTC offset is a whole number of quarter hours,
// so a quarter-hour bucket never straddles a local hour or a local midnight.
const BUCKET = 900;

const _device = db.prepare(`
  SELECT id, name, timezone, reported_timezone, workspace_id, status, playlist_id
  FROM devices WHERE id = ?
`);

function visibleDevice(workspaceId, deviceId) {
  if (!workspaceId) return null;
  const d = _device.get(deviceId);
  return d && d.workspace_id === workspaceId ? d : null;
}

/*
 * What kind of thing a play was.
 *
 * A screen looping two files between a clock, the news, the weather and the football looks, to any
 * count keyed on content_id, like a screen playing one thing. The kind comes from the widget when
 * there is one and is 'file' otherwise, so the breakdown says where the time actually went.
 */
function kindOf(row) {
  if (row.widget_id) return row.widget_type || 'widget';
  return 'file';
}

function deviceSummary({ workspaceId, deviceId, start, end }) {
  const device = visibleDevice(workspaceId, deviceId);
  if (!device) return null;

  const own = usableZone(effectiveDeviceTz(device));
  const tz = own || 'UTC';
  const from = start;
  const to = end || start;

  const [startEpoch] = dayRange(from, tz);
  const [, endEpoch] = dayRange(to, tz);

  /*
   * Grouped to (item, quarter-hour). Fine enough to rebuild the grid, the ranking and the totals
   * from; coarse enough that a month of a busy screen arrives as thousands of rows rather than
   * hundreds of thousands.
   */
  const groups = db.prepare(`
    SELECT pl.content_id,
           pl.widget_id,
           w.widget_type,
           pl.content_name,
           pl.playlist_id,
           COALESCE(p.name, NULLIF(pl.playlist_name, '')) AS list_name,
           (pl.started_at / ${BUCKET}) * ${BUCKET} AS bucket,
           COUNT(*) AS plays,
           COALESCE(SUM(pl.duration_sec), 0) AS seconds
    FROM play_logs pl
    LEFT JOIN widgets   w ON w.id = pl.widget_id
    LEFT JOIN playlists p ON p.id = pl.playlist_id
    WHERE pl.device_id = ? AND pl.started_at >= ? AND pl.started_at <= ?
    GROUP BY pl.content_id, pl.widget_id, pl.content_name, pl.playlist_id, list_name, bucket
  `).all(deviceId, startEpoch, endEpoch);

  // Decided before the loop, because each play has to be placed in a column as it is read.
  const cols = columnsFor(from, to);

  const byItem = new Map();
  const byKind = new Map();
  const byList = new Map();
  const entries = [];
  const files = new Set();
  const widgets = new Set();
  let plays = 0;
  let seconds = 0;
  let unattributed = 0;

  for (const g of groups) {
    /*
     * Identity for an item, in the order it can be trusted. A file keeps its identity across a
     * rename; a play whose file has since been deleted has only the name it was recorded under,
     * and merging every such play into one nameless row would hide exactly the content an
     * advertiser is asking about.
     */
    const key = g.content_id ? `c:${g.content_id}` : (g.widget_id ? `w:${g.widget_id}` : `n:${g.content_name}`);
    const kind = kindOf(g);

    let item = byItem.get(key);
    if (!item) {
      item = {
        key,
        name: g.content_name || '--',
        kind,
        content_id: g.content_id,
        widget_id: g.widget_id,
        plays: 0,
        seconds: 0,
      };
      byItem.set(key, item);
    }
    item.plays += g.plays;
    item.seconds += g.seconds;

    byKind.set(kind, (byKind.get(kind) || 0) + g.plays);

    // Keyed by name as well as id: a deleted list keeps its name and loses its id (SET NULL), so
    // two deleted lists would otherwise merge with each other and with the unrecorded plays.
    const lk = g.playlist_id ? `id:${g.playlist_id}` : (g.list_name ? `name:${g.list_name}` : 'none');
    let list = byList.get(lk);
    if (!list) {
      list = { playlist_id: g.playlist_id, name: g.list_name || null, plays: 0, seconds: 0 };
      byList.set(lk, list);
    }
    list.plays += g.plays;
    list.seconds += g.seconds;
    if (lk === 'none') unattributed += g.plays;

    if (g.content_id) files.add(g.content_id);
    if (g.widget_id) widgets.add(g.widget_id);
    plays += g.plays;
    seconds += g.seconds;

    entries.push({ key, name: g.content_name || '--', kind, col: columnOf(g.bucket, tz, cols), plays: g.plays });
  }

  const items = [...byItem.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name, 'pt-BR'));

  return {
    device: { id: device.id, name: device.name, status: device.status },
    timezone: tz,
    timezone_assumed: !own,
    window: { start: from, end: to },
    totals: {
      plays,
      seconds,
      distinct_files: files.size,
      distinct_widgets: widgets.size,
      distinct_lists: [...byList.keys()].filter((k) => k !== 'none').length,
      unattributed,
    },
    by_item: items,
    // Percentages are computed here, not on the page: two places dividing by the same total is how
    // a set of percentages ends up summing to 99.
    by_kind: [...byKind.entries()]
      .map(([kind, n]) => ({ kind, plays: n, pct: plays ? Math.round((n / plays) * 1000) / 10 : 0 }))
      .sort((a, b) => b.plays - a.plays),
    by_list: [...byList.values()].sort((a, b) => b.plays - a.plays),
    matrix: buildMatrix({ entries, cols }),
  };
}

module.exports = { deviceSummary, visibleDevice, kindOf };
