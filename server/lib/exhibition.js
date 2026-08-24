'use strict';

/*
 * What a screen actually put on air, in the order it happened.
 *
 * The global reports answer "how much" — this answers "what, and when". They are different
 * questions, and the second is the one an operator gets asked by a customer: prove my
 * advertisement ran on Tuesday afternoon.
 *
 * Two things this must never do:
 *
 *   INVENT A LIST. play_logs only carries playlist_id from the release that added it. Older rows
 *   have NULL and stay NULL — the caller renders "not recorded" rather than attributing them to
 *   whatever list the screen runs today, which would be a confident wrong answer on any screen
 *   that has since been reassigned.
 *
 *   USE THE SERVER'S CALENDAR. Days belong to the screen's timezone; see lib/zoned-day.js.
 */

const { db } = require('../db/database');
const { usableZone, dayKey, hhmm, dayRange, today } = require('./zoned-day');
const { effectiveDeviceTz } = require('./device-timezone');

/*
 * The cap exists because one screen is a lot of rows. A fifteen-second clip on a loop is 5,760
 * plays a day, so a month of one panel is comfortably past a hundred thousand — enough to freeze
 * the tab that asked for it. The response says when it truncated, so the page can say so too; it
 * is never silently presented as the whole answer.
 */
const MAX_ROWS = 5000;
const MAX_EXPORT_ROWS = 200000;

const _device = db.prepare(`
  SELECT d.id, d.name, d.timezone, d.reported_timezone, d.workspace_id, d.playlist_id
  FROM devices d WHERE d.id = ?
`);

/*
 * The screen, if this workspace may see it.
 *
 * Scoped here rather than in the route: every entry point in this file needs the same check, and a
 * report is the easiest place for one of them to end up written without it.
 */
function visibleDevice(workspaceId, deviceId) {
  if (!workspaceId) return null;
  const d = _device.get(deviceId);
  return d && d.workspace_id === workspaceId ? d : null;
}

/* The zone the timeline is told in, and whether it is the screen's own or a stand-in. */
function zoneFor(device) {
  const own = usableZone(effectiveDeviceTz(device));
  // A screen that has never reported a zone still has to render somewhere. UTC is the stand-in,
  // and `assumed` tells the page to say so — an unlabelled wrong clock is worse than a labelled one.
  return own ? { tz: own, assumed: false } : { tz: 'UTC', assumed: true };
}

/*
 * The window, resolved in the screen's own days.
 *
 * `start`/`end` are 'YYYY-MM-DD' as the operator picked them; absent, the default is the screen's
 * today. Not the server's today: at 22:00 in São Paulo it is already tomorrow in Lisbon, and an
 * operator there opening "hoje" would get an empty page for a screen that has played all day.
 */
function resolveWindow({ start, end }, tz) {
  const from = start || today(tz);
  const to = end || from;
  const [startEpoch] = dayRange(from, tz);
  const [, endEpoch] = dayRange(to, tz);
  return { from, to, startEpoch, endEpoch };
}

const ROW_COLUMNS = `
  SELECT pl.id,
         pl.started_at,
         pl.ended_at,
         pl.duration_sec,
         pl.completed,
         pl.content_id,
         pl.widget_id,
         pl.zone_id,
         pl.content_name,
         pl.playlist_id,
         pl.playlist_name AS logged_playlist_name,
         p.name AS playlist_name
  FROM play_logs pl
  LEFT JOIN playlists p ON p.id = pl.playlist_id
  WHERE pl.device_id = ? AND pl.started_at >= ? AND pl.started_at <= ?
`;

// Two statements rather than one with an interpolated direction: the page wants the most recent
// rows and the export wants the window in the order it happened, and building the sort order by
// string surgery is how a report ends up ordered by whatever the last caller asked for.
const _newestFirst = db.prepare(`${ROW_COLUMNS} ORDER BY pl.started_at DESC LIMIT ?`);
const _oldestFirst = db.prepare(`${ROW_COLUMNS} ORDER BY pl.started_at ASC LIMIT ?`);

/*
 * What to group a play under.
 *
 * Not the id: a deleted list keeps its name and loses its id (SET NULL), so keying on the id
 * alone would pour every deleted list in the window into one nameless bucket together with the
 * plays that never recorded a list at all — three different situations reported as one.
 */
function listKey(it) {
  if (it.playlist_id) return 'id:' + it.playlist_id;
  if (it.playlist_name) return 'name:' + it.playlist_name;
  return 'none';
}

/* Null both ways is not the same thing twice, and the page says each differently. */
function decorate(r, tz) {
  return {
    id: r.id,
    at: r.started_at,
    date: dayKey(r.started_at, tz),
    time: hhmm(r.started_at, tz),
    content_id: r.content_id,
    widget_id: r.widget_id,
    content_name: r.content_name,
    zone_id: r.zone_id,
    /*
     * NULL stays NULL. A play that is still on screen has no duration yet, and rendering that as
     * "0s" says the opposite of what is true — that it appeared and vanished. The page shows a
     * dash; the sums below treat it as nothing, which it is so far.
     */
    duration_sec: r.duration_sec == null ? null : r.duration_sec,
    completed: !!r.completed,
    playlist_id: r.playlist_id,
    /*
     * The CURRENT name wins, falling back to the one stored at play time.
     *
     * That order round: a list renamed since is still the same list, and an operator looking for
     * it will search the name it has now. The stored name is what remains once the list is gone —
     * and it is the only thing that can tell "deleted" apart from "never recorded", because the
     * foreign key is SET NULL and takes the id with it.
     */
    playlist_name: r.playlist_name || r.logged_playlist_name || null,
    playlist_deleted: !r.playlist_id && !!r.logged_playlist_name,
  };
}

/*
 * The timeline, newest first, grouped into the screen's days.
 *
 * Grouped here rather than in SQL because SQLite cannot do IANA zones — strftime takes a fixed
 * offset, which is right until the day a zone changes one, and quietly wrong after.
 */
function deviceTimeline({ workspaceId, deviceId, start, end, limit = MAX_ROWS }) {
  const device = visibleDevice(workspaceId, deviceId);
  if (!device) return null;

  const { tz, assumed } = zoneFor(device);
  const win = resolveWindow({ start, end }, tz);
  const cap = Math.max(1, Math.min(Number(limit) || MAX_ROWS, MAX_ROWS));

  // One more than the cap, purely to learn whether there was more. Counting separately would be a
  // second full scan to answer a yes/no question.
  const raw = _newestFirst.all(deviceId, win.startEpoch, win.endEpoch, cap + 1);
  const truncated = raw.length > cap;
  if (truncated) raw.length = cap;

  const days = [];
  const byDay = new Map();
  const files = new Set();
  const widgets = new Set();
  const lists = new Set();
  let seconds = 0;
  let unattributed = 0;

  for (const r of raw) {
    const it = decorate(r, tz);
    let day = byDay.get(it.date);
    if (!day) {
      day = { date: it.date, plays: 0, seconds: 0, lists: [], items: [] };
      byDay.set(it.date, day);
      days.push(day);
    }

    day.plays += 1;
    day.seconds += it.duration_sec || 0;
    seconds += it.duration_sec || 0;
    if (it.content_id) files.add(it.content_id);
    // Counted separately, not merged. "Arquivos distintos: 1" on a screen with 739 plays reads as
    // a fault; the other 738 were the clock, the news, the weather and the football — widgets,
    // which carry a widget_id and no content_id.
    if (it.widget_id) widgets.add(it.widget_id);
    // A deleted list is still a list that was counted — it has a name, it just no longer has a
    // row. Only a play that can name nothing is unattributed.
    const key = listKey(it);
    if (key === 'none') unattributed += 1;
    else lists.add(key);

    day.items.push(it);
  }

  // Per-day totals by list, built from what the day already holds rather than from another query.
  for (const day of days) {
    const acc = new Map();
    for (const it of day.items) {
      const k = listKey(it);
      let e = acc.get(k);
      if (!e) {
        e = {
          playlist_id: it.playlist_id,
          playlist_name: it.playlist_name,
          playlist_deleted: it.playlist_deleted,
          plays: 0,
          seconds: 0,
        };
        acc.set(k, e);
      }
      e.plays += 1;
      e.seconds += it.duration_sec || 0;
    }
    day.lists = [...acc.values()].sort((a, b) => b.plays - a.plays);
  }

  return {
    device: { id: device.id, name: device.name },
    timezone: tz,
    timezone_assumed: assumed,
    window: { start: win.from, end: win.to },
    totals: {
      plays: raw.length,
      seconds,
      distinct_files: files.size,
      distinct_widgets: widgets.size,
      distinct_lists: lists.size,
      // How many of these plays cannot say which list they came from. Reported rather than hidden:
      // it is the honest size of the gap, and it shrinks on its own as new history accrues.
      unattributed,
    },
    truncated,
    limit: cap,
    days,
  };
}

/*
 * The same window, flat and in the order it happened, for CSV.
 *
 * A separate path because the page and the file want different things: the page wants the most
 * recent N and says that it truncated; the export wants the window whole.
 */
function deviceTimelineRows({ workspaceId, deviceId, start, end }) {
  const device = visibleDevice(workspaceId, deviceId);
  if (!device) return null;

  const { tz, assumed } = zoneFor(device);
  const win = resolveWindow({ start, end }, tz);

  const raw = _oldestFirst.all(deviceId, win.startEpoch, win.endEpoch, MAX_EXPORT_ROWS + 1);
  const truncated = raw.length > MAX_EXPORT_ROWS;
  if (truncated) raw.length = MAX_EXPORT_ROWS;

  return {
    device: { id: device.id, name: device.name },
    timezone: tz,
    timezone_assumed: assumed,
    window: { start: win.from, end: win.to },
    truncated,
    rows: raw.map((r) => decorate(r, tz)),
  };
}

module.exports = {
  deviceTimeline,
  deviceTimelineRows,
  visibleDevice,
  zoneFor,
  resolveWindow,
  MAX_ROWS,
  MAX_EXPORT_ROWS,
};
