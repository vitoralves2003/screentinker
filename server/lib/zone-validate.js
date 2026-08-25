const { db } = require('../db/database');

// Single source of truth for the "orphaned zone" definition used across the server:
// assignment validation (routes/assignments.js validZoneForLayout), the device payload
// orphan flags/counts (routes/devices.js), and — by the SAME rule, mirrored in their own
// languages — the player fallback (server/player/index.html, ZoneManager.kt) and the
// find-orphan-zone-items.js sweep.
//
// Rule: an item's zone_id is VALID only if it is a zone in the device's ACTIVE layout.
// A null/empty zone_id is "unassigned" (not an orphan). A zone_id on a device with no
// active layout can never be valid -> orphan.

/** True if zoneId belongs to layoutId (or zoneId is empty = unassigned). */
function zoneInLayout(zoneId, layoutId) {
  if (!zoneId) return true;
  if (!layoutId) return false;
  return !!db.prepare('SELECT 1 FROM layout_zones WHERE id = ? AND layout_id = ?').get(zoneId, layoutId);
}

/** True when zoneId is set but NOT a zone in the device's active layout. */
function isOrphanZone(zoneId, layoutId) {
  return !!zoneId && !zoneInLayout(zoneId, layoutId);
}

/** Zones (id+name) of a layout, for populating reassign dropdowns. [] if none. */
function layoutZones(layoutId) {
  if (!layoutId) return [];
  return db.prepare('SELECT id, name FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
}

/**
 * Bulk: map of device_id -> count of its playlist_items whose zone_id is NOT in the
 * device's active layout. Same rule as isOrphanZone, computed in one query for the
 * dashboard device list. Devices with zero orphans are omitted from the map.
 */
function orphanCountsByDevice(deviceIds) {
  const rows = db.prepare(`
    SELECT d.id AS device_id, COUNT(*) AS n
    FROM devices d
    JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
    LEFT JOIN layout_zones lz ON lz.id = pi.zone_id AND lz.layout_id = d.layout_id
    WHERE pi.zone_id IS NOT NULL AND lz.id IS NULL
    GROUP BY d.id
  `).all();
  const map = {};
  const want = deviceIds && deviceIds.length ? new Set(deviceIds) : null;
  for (const r of rows) { if (!want || want.has(r.device_id)) map[r.device_id] = r.n; }
  return map;
}

/*
 * WHAT EACH SCREEN IS ACTUALLY RUNNING — one row per zone of its CURRENT layout.
 *
 * THE BUG THIS REPLACES. The fleet list showed devices.playlist_id, which is the full-screen
 * playlist. A screen using a zoned layout does not have one of those: it has one list per zone, in
 * device_zone_playlists. So a screen split into three zones showed its stale full-screen list — or
 * "sem playlist" — while three different lists were on the air.
 *
 * THE JOIN DIRECTION IS THE WHOLE TRICK. It starts from layout_zones of the device's current
 * layout and LEFT JOINs the assignment onto it, not the other way round. That gives:
 *
 *   - every zone that exists, WITH or WITHOUT a list — which is what the warning needs;
 *   - immunity to phantom zones, by construction. device_zone_playlists rows outlive the layout
 *     that created them (the trap already documented in lib/reach.js), and a row whose zone is no
 *     longer in the layout simply has nothing to join to.
 *
 * zone_type separates a zone that is MISSING a list from one that was never meant to have one: a
 * 'widget' zone shows a clock or the weather. Warning about those would be a permanent false
 * alarm, which is how a warning list stops being read.
 */
function zoneListsByDevice(deviceIds) {
  if (!deviceIds || !deviceIds.length) return {};
  const ph = deviceIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT d.id           AS device_id,
           lz.id          AS zone_id,
           lz.name        AS zone_name,
           lz.zone_type   AS zone_type,
           z.playlist_id  AS playlist_id,
           p.name         AS playlist_name
      FROM devices d
      JOIN layout_zones lz ON lz.layout_id = d.layout_id
      LEFT JOIN device_zone_playlists z ON z.device_id = d.id AND z.zone_id = lz.id
      LEFT JOIN playlists p ON p.id = z.playlist_id
     WHERE d.id IN (${ph})
     ORDER BY lz.sort_order ASC, lz.id ASC
  `).all(...deviceIds);

  const map = {};
  for (const r of rows) {
    (map[r.device_id] ||= []).push({
      zone_id: r.zone_id,
      zone_name: r.zone_name,
      zone_type: r.zone_type,
      playlist_id: r.playlist_id || null,
      playlist_name: r.playlist_name || null,
    });
  }
  return map;
}

module.exports = { zoneInLayout, isOrphanZone, layoutZones, orphanCountsByDevice, zoneListsByDevice };
