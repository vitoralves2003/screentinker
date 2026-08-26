'use strict';

/*
 * WHAT COUNTS AS A SCREEN NEEDING ATTENTION — the only place that decides.
 *
 * THE FALSE ALARM THIS EXISTS TO END. The sidebar badge and the Operação list answered the same
 * question in two different places and disagreed. The server asked "is this screen offline while
 * its own opening hours say it should be on"; the browser fetched the fleet and counted anything
 * offline or degraded, knowing nothing about opening hours at all.
 *
 * So a shop that closes at 19:00 had its badge lit every night, pointing at a page that then
 * listed nothing. That is worse than a wrong number: the badge is a LINK, and a link that leads to
 * an empty page teaches the reader it lies — right before the night a screen actually dies.
 *
 * The browser's version was also wrong in the other direction. A screen that is online, healthy
 * and has no playlist shows a black window and answers every ping; the server catches it, the
 * badge never did. Over-counting shut shops and under-counting dark ones, from the same code.
 *
 * ── THE TWO RULES, AND WHY THEY DIFFER ───────────────────────────────────────────────────────
 * OFFLINE is filtered by opening hours. A bakery's panel is off every night and listing it every
 * night is how a warning list becomes wallpaper.
 *
 * NO LIST is not filtered by anything. A screen with no playlist is misconfigured at 3am exactly
 * as much as at noon, and unlike a dropped connection it will not fix itself when the shop opens.
 *
 * A screen with NO HOURS CONFIGURED is never an alert. It is counted separately, as a nudge,
 * because guessing its hours from when it usually drops would be right most nights and would
 * silence the one alert that mattered on the other one.
 */

const { db } = require('../db/database');

/* A screen's opening hours as the schedule evaluator wants them. */
function readHours(deviceId) {
  return db.prepare(
    'SELECT active_days, start_time, end_time FROM device_hours WHERE device_id = ? ORDER BY sort_order ASC')
    .all(deviceId).map((r) => ({
      days: String(r.active_days || '').split(',').filter((x) => x !== '').map(Number),
      start: r.start_time,
      end: r.end_time,
    }));
}

/*
 * WHICH SCREENS ARE UP, decided once.
 *
 * Extracted because the first version of this module took `offlineRows` from its caller, and the
 * two callers derived them differently — one through heartbeat.livenessFor, the other from
 * devices.status. That is the same bug this whole module exists to end, one layer down: the alert
 * rule agreed while the input to it did not, so the badge and the page still reported different
 * numbers of screens with no opening hours.
 *
 * heartbeat.livenessFor is the source, because a screen mid-reconnect must not read offline in one
 * place and online in another. devices.status is the fallback for when the heartbeat service has
 * nothing to say — at boot, mostly.
 */
function livenessPass(devices) {
  const heartbeat = require('../services/heartbeat');
  let online = 0;
  const offlineRows = [];

  for (const d of devices) {
    let live;
    try { live = heartbeat.livenessFor(d.id); } catch (e) { live = null; }
    const state = live || (d.status === 'online' ? 'healthy' : 'offline');
    if (state !== 'offline') online += 1; else offlineRows.push(d);
  }

  return { online, offlineRows };
}

/* Every screen of a workspace, minus the ones still pairing — the fleet both readouts judge. */
function fleetOf(workspaceId) {
  return db.prepare(`
    SELECT id, name, status, offline_reason, timezone, reported_timezone, playlist_id, layout_id
      FROM devices
     WHERE workspace_id = ? AND status != 'provisioning'`).all(workspaceId);
}

/*
 * Every screen in a workspace that wants somebody's attention, and how many are merely missing
 * their opening hours.
 *
 * @param {string} workspaceId
 * @param {Array}  devices     rows already loaded by the caller, each with a resolved liveness
 * @param {Array}  offlineRows the subset livenessPass() judged offline. Passed in rather than
 *                             derived here because /devices/overview needs the online count from
 *                             the same pass — but it must come FROM livenessPass, never from a
 *                             second reading of devices.status. Deriving it twice is how the two
 *                             readouts still disagreed after the alert rule was already shared.
 * @param {number} [nowUtc]
 * @returns {{ attention: Array, hours_unconfigured: number }}
 */
function attentionFor(workspaceId, devices, offlineRows, nowUtc = Date.now()) {
  const { isItemActiveNow } = require('./schedule-eval');
  const { effectiveDeviceTz } = require('./device-timezone');

  const attention = [];
  let unconfigured = 0;

  for (const d of offlineRows) {
    const blocks = readHours(d.id);
    if (!blocks.length) { unconfigured += 1; continue; }
    let tz = null;
    try { tz = effectiveDeviceTz(d); } catch (e) { tz = null; }
    if (!isItemActiveNow(blocks, nowUtc, tz)) continue;   // shut right now — not a fault
    attention.push({ id: d.id, name: d.name, kind: 'offline', offline_reason: d.offline_reason || null });
  }

  /*
   * Screens that are fine and showing nothing. Everything above asks whether a screen is
   * REACHABLE, so one with no playlist never qualified: it is online, it answers, its state reads
   * healthy — and the shop window is black.
   */
  const { zoneListsByDevice } = require('./zone-validate');
  const allZones = zoneListsByDevice(devices.map((d) => d.id));

  for (const d of devices) {
    const zones = allZones[d.id] || [];
    if (!zones.length) {
      if (!d.playlist_id) attention.push({ id: d.id, name: d.name, kind: 'no_playlist' });
      continue;
    }
    const content = zones.filter((z) => z.zone_type === 'content');
    const starved = content.filter((z) => !z.playlist_id);
    if (!starved.length) continue;
    attention.push({
      id: d.id,
      name: d.name,
      kind: starved.length === content.length ? 'no_playlist' : 'zone_without_list',
      zones: starved.map((z) => z.zone_name),
    });
  }

  return { attention, hours_unconfigured: unconfigured };
}

/*
 * The same answer, for a caller that only wants the number — the sidebar badge.
 *
 * It loads and judges the fleet ITSELF rather than taking rows from the caller, because the badge
 * is rendered on every page and must not depend on whichever view happens to be open. The liveness
 * source is heartbeat.livenessFor, exactly as /devices/overview uses: a screen mid-reconnect must
 * not be offline in the badge and online in the list.
 */
function attentionCount(workspaceId, nowUtc = Date.now()) {
  if (!workspaceId) return { count: 0, hours_unconfigured: 0 };

  const devices = fleetOf(workspaceId);
  const { offlineRows } = livenessPass(devices);
  const r = attentionFor(workspaceId, devices, offlineRows, nowUtc);
  return { count: r.attention.length, hours_unconfigured: r.hours_unconfigured };
}

module.exports = { attentionFor, attentionCount, livenessPass, fleetOf, readHours };
