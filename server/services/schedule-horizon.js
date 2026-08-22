'use strict';

/*
 * Keep date-based schedules from running off the end of their expansion.
 *
 * lib/schedule-compile.js turns "the 1st of the month" into a list of dates, so it needs a
 * horizon — 18 months. The expansion is computed on READ, which means every push already carries
 * a window measured from that moment, and in normal use nothing here is needed: publishing,
 * editing or a device reconnecting all refresh it.
 *
 * The gap is a screen that keeps playing the same published playlist, untouched, for well over a
 * year. Its cached blocks stop at the horizon that was current when it last received them, and
 * after that a monthly campaign simply stops appearing. Nothing errors. Nothing is logged. The
 * file is still in the list, still scheduled, and just never plays — which is precisely the kind
 * of silent wrong this whole design is meant to rule out.
 *
 * So: once a day, look at what the fleet's published playlists currently compile to, and if any
 * of them is within REPUSH_WHEN_UNDER of running out, republish that one. In practice that fires
 * about once a year per playlist and pushes nothing else.
 */

const { db } = require('../db/database');
const { compileRules, HORIZON_MONTHS } = require('../lib/schedule-compile');

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Republish when under six months of expansion remains. Far enough ahead that a screen which is
 * offline for a season still comes back to a valid window, and late enough that a playlist is
 * touched roughly once a year rather than every sweep.
 */
const REPUSH_WHEN_UNDER_DAYS = 183;

let io = null;

function startScheduleHorizon(socketIo) {
  io = socketIo;
  // Once a day, and once shortly after boot so a server that is restarted often still sweeps.
  setTimeout(() => { try { sweepHorizon(io); } catch (e) { console.error('[schedule-horizon] sweep error', e); } }, 60000);
  setInterval(() => { try { sweepHorizon(io); } catch (e) { console.error('[schedule-horizon] sweep error', e); } }, DAY_MS);
  console.log('Schedule-horizon sweep started');
}

function todayYmd(now = Date.now()) {
  const d = new Date(now);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/*
 * The furthest date a rule set currently reaches, or null when it reaches forever.
 *
 * A rule with no date dimension compiles to blocks with no date bounds at all, and those never
 * expire — most schedules are of that kind, which is why this returns null rather than a date and
 * the sweep skips them entirely.
 */
function horizonEndOf(rules, today) {
  const blocks = compileRules(rules, today);
  if (!blocks.length) return null;
  let furthest = null;
  for (const b of blocks) {
    if (!b.end_date) return null; // an unbounded block: this schedule cannot run out
    if (furthest === null || b.end_date > furthest) furthest = b.end_date;
  }
  return furthest;
}

const _rulesFor = db.prepare(`
  SELECT type, params FROM content_schedule_rules
   WHERE content_id = ? ORDER BY sort_order ASC, created_at ASC`);

function rulesFor(contentId) {
  return _rulesFor.all(contentId).map((r) => {
    let params = {};
    try { params = JSON.parse(r.params); } catch (e) { /* a corrupt row degrades to its type alone */ }
    return { type: r.type, ...params };
  });
}

/*
 * Returns { checked, republished: [playlistIds] }. Side effects are DB writes plus a device push,
 * so tests drive it directly; without `socketIo` the republish still happens and only the push is
 * skipped, matching services/content-expiry.js.
 */
function sweepHorizon(socketIo = io, now = Date.now()) {
  const today = todayYmd(now);

  /*
   * AGE OF THE PUBLISH, not a recompile.
   *
   * The first version of this asked the compiler how far the rules reach — and the compiler always
   * answers from today, so the horizon always looked full and the sweep would never have fired
   * once. What actually goes stale is the expansion a DEVICE is holding, and that was frozen when
   * the playlist was last published. So the question is how old the publish is: a snapshot older
   * than the horizon minus the safety margin is one whose cached window is running out.
   *
   * For a published playlist, updated_at is that publish (any edit moves it back to draft).
   */
  const staleAfterMs = (HORIZON_MONTHS * 30.44 - REPUSH_WHEN_UNDER_DAYS) * DAY_MS;
  const publishedBefore = Math.floor((now - staleAfterMs) / 1000);

  /*
   * Only published playlists matter: a draft is not serving anyone, and its next publish compiles
   * fresh. Only content that actually has rules is considered.
   */
  const rows = db.prepare(`
    SELECT DISTINCT p.id AS playlist_id, pi.content_id
      FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
     WHERE p.status = 'published'
       AND p.updated_at < ?
       AND pi.content_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM content_schedule_rules r WHERE r.content_id = pi.content_id)`).all(publishedBefore);

  /*
   * An old publish is only a problem if the schedule has a horizon at all. A weekly rule compiles
   * to blocks with no date bounds, which never expire however old the snapshot is.
   */
  const stale = new Set();
  const cache = new Map();
  for (const row of rows) {
    if (!cache.has(row.content_id)) cache.set(row.content_id, horizonEndOf(rulesFor(row.content_id), today));
    if (cache.get(row.content_id) !== null) stale.add(row.playlist_id);
  }

  if (!stale.size) return { checked: rows.length, republished: [] };

  const republished = [];
  for (const playlistId of stale) {
    try {
      // Republishing regenerates the snapshot, which is what re-runs the compiler and widens the
      // window; the push is what gets it onto the screen.
      const { publishPlaylist } = require('../routes/playlists');
      publishPlaylist(playlistId, socketIo);
      republished.push(playlistId);
    } catch (e) {
      console.error('[schedule-horizon] republish failed for', playlistId, e);
    }
  }
  console.log(`[schedule-horizon] refreshed ${republished.length} playlist(s) nearing the expansion horizon`);
  return { checked: rows.length, republished };
}

module.exports = { startScheduleHorizon, sweepHorizon, horizonEndOf, REPUSH_WHEN_UNDER_DAYS, __test: { todayYmd } };
