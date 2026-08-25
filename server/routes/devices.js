const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES, isPlatformStaff } = require('../middleware/auth');
// Phase 2.2a: workspace-aware access. accessContext returns { workspaceRole, actingAs }
// or null based on the caller's reach into a specific workspace.
const { accessContext } = require('../lib/tenancy');
const { stripDeviceSecrets, stripDeviceSecretsForList } = require('../lib/device-sanitize');
const { layoutZones, orphanCountsByDevice } = require('../lib/zone-validate');
const deviceSettings = require('../lib/device-settings'); // #150 delete+re-pair settings preservation
const playerCapabilities = require('../lib/player-capabilities');

// List devices in the caller's current workspace.
// Phase 2.2a: filter by workspace_id instead of user_id. The caller's current
// workspace is resolved by resolveTenancy middleware from JWT or query/header
// override. Platform_admin and org_owner/admin see whichever workspace they
// are currently switched into (cross-workspace visibility comes from
// switch-workspace, not from a special list filter).
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const devices = db.prepare(`
    SELECT d.*,
      t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
      t.ram_free_mb, t.ram_total_mb, t.wifi_ssid, t.wifi_rssi, t.uptime_seconds, t.local_ip, t.local_ip6, t.attached_display, t.video_mode,
      t.cpu_usage,
      s.filepath as screenshot_path, s.captured_at as screenshot_at,
      u.email as owner_email, u.name as owner_name,
      -- The fleet list shows WHICH playlist a screen runs, not just that it has one. Joined here
      -- rather than resolved in the browser: the page already has the playlist list, but matching
      -- ids client-side breaks the moment a screen points at a playlist the viewer cannot see.
      pl.name as playlist_name
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN playlists pl ON d.playlist_id = pl.id
    LEFT JOIN (
      SELECT dt.* FROM device_telemetry dt
      INNER JOIN (SELECT device_id, MAX(reported_at) as max_at FROM device_telemetry GROUP BY device_id) latest
      ON dt.device_id = latest.device_id AND dt.reported_at = latest.max_at
    ) t ON d.id = t.device_id
    LEFT JOIN (
      SELECT sc.* FROM screenshots sc
      INNER JOIN (SELECT device_id, MAX(captured_at) as max_at FROM screenshots GROUP BY device_id) latest
      ON sc.device_id = latest.device_id AND sc.captured_at = latest.max_at
    ) s ON d.id = s.device_id
    WHERE d.workspace_id = ?
    ORDER BY d.sort_order ASC, d.created_at ASC
    LIMIT ? OFFSET ?
  `).all(req.workspaceId, limit, offset);
  // #zone-orphan: lightweight per-device count of playlist items whose zone_id isn't in
  // the device's active layout, so the dashboard can flag screens that need attention.
  const orphanCounts = orphanCountsByDevice(devices.map(d => d.id));
  // The RESOLVED capability set, the same shape GET /:id returns. The raw column shipped here
  // before: a JSON *string* ('[]') or null, which every consumer would have had to parse — and
  // `Array.isArray("[]")` is false, so the dashboard's `can()` helper reads a device that declared
  // "I can do nothing" as "pre-capability server, show everything". Resolving it here means the
  // fleet views (device cards, the wall panel list) can hide a control the panel cannot honour
  // instead of offering it and having the socket drop it.
  /*
   * LIVENESS TRAVELS WITH THE LIST, which it did not before.
   *
   * The rows carried only devices.status, so a freshly loaded page derived its badge from a
   * binary column and showed "Saudável" for a panel whose player was not running at all. The
   * four-state liveness only reached the screen through socket events AFTER the page was open,
   * which meant the first thing an operator saw was the least accurate thing on the page.
   *
   * Cost: a few indexed primary-key lookups per device. Fine at this size; if a workspace ever
   * holds thousands of screens this wants folding into the list query rather than a call per
   * row.
   */
  const heartbeat = require('../services/heartbeat');
  res.json(devices.map(d => {
    let live = { state: null, reason: null };
    try { live = heartbeat.livenessDetail(d.id); } catch (e) { /* fall back to status */ }
    return {
      ...stripDeviceSecretsForList(d),
      capabilities: playerCapabilities.capabilitiesFor(d),
      orphan_count: orphanCounts[d.id] || 0,
      ...(d.status === 'provisioning' ? {} : { liveness: live.state || undefined }),
      ...(live.reason ? { offline_reason: live.reason } : {}),
    };
  }));
});

// #106: reorder display tiles (cosmetic, within-section). Writes devices.sort_order
// = position in the given id array. Workspace-scoped: the UPDATE matches WHERE
// workspace_id = the caller's current workspace, so a forged id from another
// workspace is silently a no-op (can't reorder or probe devices you can't see).
// Write-gated: workspace_viewer (non-acting) is read-only. Ordering affects ONLY the
// dashboard listing — nothing the device/player reads (grouping/pairing/playback
// are independent). Mirrors the playlist items reorder.
router.post('/reorder', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace' });
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of device IDs' });
  const stmt = db.prepare("UPDATE devices SET sort_order = ?, updated_at = strftime('%s','now') WHERE id = ? AND workspace_id = ?");
  const tx = db.transaction(() => {
    order.forEach((id, index) => stmt.run(index, id, req.workspaceId));
  });
  tx();
  res.json({ success: true });
});

// List unclaimed provisioning devices (admin only).
// #13: read-only, so platform_operator may view the pool too (cross-org staff
// troubleshooting). Claiming a device is a separate workspace-scoped mutation.
router.get('/unassigned', (req, res) => {
  if (!ELEVATED_ROLES.includes(req.user.role) && !isPlatformStaff(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const devices = db.prepare(`
    SELECT id, pairing_code, status, ip_address, android_version, app_version,
      screen_width, screen_height, render_width, render_height, created_at, last_heartbeat
    FROM devices WHERE user_id IS NULL
    ORDER BY created_at DESC
  `).all();
  res.json(devices);
});

// #150: "previously removed devices" — fingerprint-keyed settings snapshots for the caller's
// current workspace, for the operator re-adopt flow (changed-fingerprint case). MUST be
// declared before GET '/:id' or Express matches 'removed' as an :id. Read-scoped to workspace.
router.get('/removed', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  res.json(deviceSettings.listRemoved(req.workspaceId));
});

// Get single device with telemetry history
/*
 * BEFORE router.get('/:id'), and it has to be.
 *
 * Express matches in declaration order, so with this below the id route a request for
 * /api/devices/overview is read as a device whose id is the word "overview" and answered with
 * 404 Device not found — on the page the app opens on.
 */
/*
 * The operation overview — the page the app opens on.
 *
 * Everything here is a count the dashboard could assemble from endpoints it already calls, and
 * that is exactly why it is one endpoint instead: the landing page must not fan out into five
 * requests before it shows a number, and it must not pull the whole content library across the
 * wire to find out how many files there are.
 */
router.get('/overview', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });

  const ws = req.workspaceId;

  /*
   * Screens are counted by the SAME liveness the fleet list shows. Reading devices.status
   * straight from the table would be cheaper and would disagree with the list two lines below
   * it — a screen mid-reconnect is online in the column and offline in the row, and the operator
   * is left to decide which page is lying.
   */
  const devices = db.prepare(`
    SELECT id, name, status, offline_reason, timezone, reported_timezone FROM devices
     WHERE workspace_id = ? AND status != 'provisioning'`).all(ws);
  const heartbeat = require('../services/heartbeat');
  let online = 0;
  const offlineRows = [];
  for (const d of devices) {
    let live;
    try { live = heartbeat.livenessFor(d.id); } catch (e) { live = null; }
    const state = live || (d.status === 'online' ? 'healthy' : 'offline');
    if (state !== 'offline') online += 1; else offlineRows.push(d);
  }

  /*
   * STORAGE IS THE TENANT'S CONTRACT, not the server's disk.
   *
   * Showing free space on the host would be answering a question the customer never asked: what
   * they can upload is bounded by the plan, and until now they discovered that bound at the
   * moment an upload was refused — with the file already chosen. The same numbers
   * checkStorageLimit enforces are simply shown before they bite.
   *
   * Summed for THIS WORKSPACE, which is the tenant. The plan is resolved through
   * lib/tenant-plan.js — the one place allowed to answer "which plan" — because reading
   * organizations.plan_id here is exactly what made this page print "Premium" for a customer the
   * invoice was charging Corporativo.
   */
  const plan = require('../lib/tenant-plan').planRowFor(ws);
  const usedBytes = db.prepare(
    'SELECT COALESCE(SUM(file_size), 0) AS b FROM content WHERE workspace_id = ?').get(ws).b;

  /*
   * NEEDS ATTENTION — offline screens, filtered by whether anyone is there to care.
   *
   * A bakery that closes at 19:00 has its panel offline every night. Listing that every night is
   * how a warning list becomes wallpaper, and the night the panel actually dies its warning sits
   * among twelve identical ones. So a screen appears here only if it is offline DURING ITS OWN
   * OPENING HOURS, evaluated in its own timezone.
   *
   * A screen with no hours configured is NOT listed, and is counted separately instead. Guessing
   * the hours from when it usually drops would be right most of the time and would silence the
   * one alert that mattered the rest of it.
   */
  const { isItemActiveNow } = require('../lib/schedule-eval');
  const { effectiveDeviceTz } = require('../lib/device-timezone');
  const nowUtc = Date.now();
  const attention = [];
  let unconfigured = 0;
  for (const d of offlineRows) {
    const blocks = readHours(d.id);
    if (!blocks.length) { unconfigured += 1; continue; }
    let tz = null;
    try { tz = effectiveDeviceTz(d); } catch (e) { tz = null; }
    if (!isItemActiveNow(blocks, nowUtc, tz)) continue;   // shut right now — not a fault
    attention.push({ id: d.id, name: d.name, offline_reason: d.offline_reason || null });
  }

  res.json({
    screens: { total: devices.length, online, offline: devices.length - online },
    attention,
    // Shown as a nudge rather than hidden: with nothing configured the list is empty for a
    // reason the reader would otherwise have to guess at.
    hours_unconfigured: unconfigured,
    library: {
      playlists: db.prepare('SELECT COUNT(*) c FROM playlists WHERE workspace_id = ?').get(ws).c,
      files: db.prepare('SELECT COUNT(*) c FROM content WHERE workspace_id = ?').get(ws).c,
    },
    storage: {
      used_bytes: usedBytes,
      // -1 is the plan's own way of saying unlimited; passed through rather than turned into a
      // number, so the page can say "sem limite" instead of drawing a bar against a fiction.
      limit_mb: plan ? plan.max_storage_mb : null,
      plan: plan ? plan.display_name : null,
    },
  });
});

router.get('/:id', (req, res) => {
  const device = db.prepare('SELECT d.*, u.email as owner_email, u.name as owner_name FROM devices d LEFT JOIN users u ON d.user_id = u.id WHERE d.id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Phase 2.2a: workspace-aware read check. accessContext returns null when
  // the caller has no path (direct member, org-level acting-as, or platform_admin)
  // to the device's workspace.
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (ctx.workspaceRole) device._workspaceRole = ctx.workspaceRole; // Pass to frontend
  if (ctx.actingAs) device._actingAs = true;

  const telemetry = db.prepare(
    'SELECT * FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 20'
  ).all(req.params.id);

  const screenshot = db.prepare(
    'SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1'
  ).get(req.params.id);

  // Get playlist items and status if device has an assigned playlist
  let assignments = [];
  let playlist_status = null;
  let playlist_has_published = false;
  if (device.playlist_id) {
    assignments = db.prepare(`
      SELECT pi.id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
             pi.created_at, pi.updated_at,
             COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      WHERE pi.playlist_id = ?
      ORDER BY pi.sort_order ASC
    `).all(device.playlist_id);
    const pl = db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (pl) {
      playlist_status = pl.status;
      playlist_has_published = pl.published_snapshot !== null;
    }
  }

  // #zone-orphan: flag any item whose zone_id isn't a zone in the device's ACTIVE layout
  // (same rule as lib/zone-validate). The dashboard shows a per-item "reassign" warning;
  // active_layout_zones ships the zone list here too so the inline reassign dropdown needs
  // no separate /api/layouts round-trip. Informational only — playback uses the fallback.
  const active_layout_zones = layoutZones(device.layout_id);
  const activeZoneIdSet = new Set(active_layout_zones.map(z => z.id));
  for (const a of assignments) a.orphan = !!a.zone_id && !activeZoneIdSet.has(a.zone_id);

  // Uptime timeline: get status change events for last 24 hours
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let statusLog = [];
  try {
    statusLog = db.prepare(
      'SELECT status, reason, detail, timestamp FROM device_status_log WHERE device_id = ? AND timestamp > ? ORDER BY timestamp ASC'
    ).all(req.params.id, dayAgo);
  } catch (_) {}

  // Offline-cause log: the unified incident feed (offline-cause + display/sleep + crash +
  // reboot), most-recent first. Best-effort — an old DB without the table just yields [].
  let deviceEvents = [];
  try {
    deviceEvents = db.prepare(
      'SELECT id, type, reason, detail, timestamp FROM device_events WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT 50'
    ).all(req.params.id);
  } catch (_) {}

  // Also get telemetry timestamps as heartbeat proof (fills gaps between status events)
  const uptimeData = db.prepare(
    'SELECT reported_at FROM device_telemetry WHERE device_id = ? AND reported_at > ? ORDER BY reported_at ASC'
  ).all(req.params.id, dayAgo).map(r => r.reported_at);

  // The RESOLVED capability set, not the raw column. The dashboard hides controls a panel cannot
  // honour, and it must not have to know about the baseline fallback — a legacy device declaring
  // nothing has to arrive at the dashboard looking exactly like one that declared its baseline,
  // or ~440 existing displays lose their controls the moment this ships.
  const capabilities = playerCapabilities.capabilitiesFor(device);

  res.json({ ...stripDeviceSecrets(device), capabilities, telemetry, screenshot, assignments, active_layout_zones, playlist_status, playlist_has_published, uptimeData, statusLog, deviceEvents });
});

// Helper: check device write access via the workspace the device belongs to.
// Phase 2.2a: replaces user_id + team_members check. Allows: platform_admin,
// org_owner/admin of the device's org (acting-as), workspace_admin/editor of
// the device's workspace. Denies workspace_viewer and non-members.
function checkDeviceOwnership(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  // ctx.actingAs covers platform_admin and org_owner/admin paths (always writable).
  // Direct workspace members: workspace_viewer is read-only.
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return device;
}

// #104: device-manager preview payload. Returns the device's CURRENT payload exactly
// as the device renders it — its OWN layout/orientation/wall from the device row and
// its published items — built by the same buildPlaylistPayload the device socket uses.
// Device-bound layout (the correct side of the layout seam); derivePreviewLayout is
// playlist-only and never touches this path. wall_config is forced null in v1: a wall
// FOLLOWER would otherwise freeze waiting for leader wall:sync that a socket-free
// preview can't deliver, so wall members preview full-frame. Device-READ gated
// (mirrors GET /:id — viewers allowed); NOT requirePlaylistRead, NOT the write gate.
router.get('/:id/preview-payload', (req, res) => {
  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  const { buildPlaylistPayload } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayload(req.params.id);
  payload.wall_config = null; // v1: wall members preview full-frame (no socket-free follower freeze)
  res.json(payload);
});

// Update device
// Clear a device's playlist — the "No playlist" option in the dashboard picker.
//
// There was no way to do this. PUT /devices/:id ignores playlist_id (it always has), and
// POST /playlists/:id/assign can only ever SET one, so the picker carried a guard that
// silently discarded the selection: `if (!newPlaylistId) return; // Don't allow deselecting`.
// The option was offered, selecting it did nothing, and no error said so — reported on #234
// as "I selected No playlist and it still showed the same video". It did.
//
// Device-scoped rather than playlist-scoped because there is no playlist to authorize
// against when clearing; ownership is checked the same way every other device mutation
// checks it. Clearing an already-clear device is a no-op success, so the button is safe to
// press twice.
router.delete('/:id/playlist', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  db.prepare('UPDATE devices SET playlist_id = NULL, updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), req.params.id);

  // Push the now-empty playlist so the screen stops, rather than leaving the old content up
  // until something else happens to update it.
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), req.params.id, buildPlaylistPayload);
    }
  } catch (e) { /* silent — the DB is the source of truth, the push is best-effort */ }

  res.json({ success: true });
});

router.put('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const { name, notes, timezone, orientation, default_content_id, layout_id, ota_enabled, ota_beta, reboot_schedule, audio_enabled } = req.body;
  // #150: validate orientation against the known enum (previously accepted any string, which
  // let a bad value reach the player -> unknown rotation falls back to landscape silently).
  if (orientation !== undefined && !deviceSettings.ORIENTATIONS.has(orientation)) {
    return res.status(400).json({ error: `Invalid orientation. Allowed: ${[...deviceSettings.ORIENTATIONS].join(', ')}` });
  }
  // Whitelist allowed fields to prevent SQL injection via field names
  const ALLOWED_FIELDS = ['name', 'notes', 'timezone', 'orientation', 'default_content_id'];
  const updates = [];
  const values = [];
  Object.entries({ name, notes, timezone, orientation, default_content_id }).forEach(([key, val]) => {
    if (val !== undefined && ALLOWED_FIELDS.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  });
  // #public-api: allow setting the device's layout here too (symmetry with
  // PUT /api/layouts/device/:id). Validate it's a template or in the device's
  // workspace; null clears it (fullscreen).
  if (layout_id !== undefined) {
    if (layout_id !== null) {
      const layout = db.prepare('SELECT id FROM layouts WHERE id = ? AND (is_template = 1 OR workspace_id = ?)').get(layout_id, device.workspace_id);
      if (!layout) return res.status(400).json({ error: 'layout_id not found in this workspace' });
    }
    updates.push('layout_id = ?'); values.push(layout_id || null);
  }
  /*
   * May this screen make a sound at all. Replaces the volume and brightness sliders.
   *
   * Re-pushes the playlist, unlike the fields above. Those reach the panel on its next
   * register, up to a minute away, and for orientation or notes that is fine. This one is
   * pressed BECAUSE a screen is making noise it should not be making, usually with someone
   * standing in front of it, and a minute of "did that work?" is the difference between a
   * control that works and a control that gets pressed four more times.
   */
  let audioChanged = false;
  if (audio_enabled !== undefined) {
    updates.push('audio_enabled = ?'); values.push(audio_enabled ? 1 : 0);
    audioChanged = true;
  }
  // #155/#161: per-device self-update (OTA) toggle. Coerce to 0/1.
  if (ota_enabled !== undefined) {
    updates.push('ota_enabled = ?'); values.push(ota_enabled ? 1 : 0);
  }
  if (ota_beta !== undefined) {
    // Per-display pre-release opt-in (#234 follow-up). Stops a test build being reverted by the
    // next OTA check, which is what a prerelease version sorting below its own release causes.
    updates.push('ota_beta = ?'); values.push(ota_beta ? 1 : 0);
  }
  // #12 scheduled reboot: device-local "HH:MM" (null/'' clears -> off). Reset the
  // once-per-day guard on any change so a newly-set time can still fire later today.
  if (reboot_schedule !== undefined) {
    let val = null;
    if (reboot_schedule !== null && reboot_schedule !== '') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(reboot_schedule))) {
        return res.status(400).json({ error: 'reboot_schedule must be "HH:MM" (24h) or null' });
      }
      val = String(reboot_schedule);
    }
    updates.push('reboot_schedule = ?'); values.push(val);
    updates.push('reboot_last_date = ?'); values.push(null);
  }
  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE devices SET ${updates.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`).run(...values);
  }

  if (audioChanged) {
    try {
      const io = req.app.get('io');
      if (io) {
        const { buildPlaylistPayload } = require('../ws/deviceSocket');
        require('../lib/command-queue')
          .queueOrEmitPlaylistUpdate(io.of('/device'), req.params.id, buildPlaylistPayload);
      }
    } catch (e) { /* best-effort; the next register carries it anyway */ }
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  res.json(stripDeviceSecrets(updated));
});

/*
 * SUBSTITUIR TELA - point an existing screen at different hardware.
 *
 * The problem it exists for, measured in production: the device fingerprint is a SHA-256 of
 * ANDROID_ID plus Build fields, and ANDROID_ID is regenerated by a factory reset. Reinstalling
 * the app keeps the fingerprint, so the socket recognises the panel and reuses its row.
 * RESETTING changes it, so the panel arrives as a stranger and gets a brand-new row - and the
 * screen the customer had configured sits offline forever beside its replacement. A duplicate in
 * the dashboard and a duplicate on the invoice, for what the customer experienced as swapping a
 * box.
 *
 * So the operator says which screen this is. The row is REUSED and the new hardware adopts its
 * identity, which is the whole point: the id, the name, the playlist, the layout, the groups, the
 * history and - the part that costs money - THE LICENCE all stay put. An implementation that
 * created a fresh row and deleted the old one would look identical in the dashboard and bill the
 * customer twice.
 *
 * Why this is not the thing we deliberately stopped doing in server.js (pairing clears the
 * playlist): that was a panel silently inheriting content nobody had chosen for it. This is an
 * operator naming a screen and asking for its content back. Automatic and silent is the defect;
 * explicit and asked-for is the feature.
 */
/*
 * WHEN THE PLACE IS OPEN — this screen's operating hours.
 *
 * Blocks are OR, exactly like a content schedule, and are validated the same way: Mon-Fri
 * 08:00-19:00 plus Sat 08:00-13:00 is two blocks, and Sunday closed is simply no block covering
 * it. NO blocks at all means "not configured", which the alert treats differently from "never
 * open" — it skips the screen rather than reporting it every night.
 */
const HOURS_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readHours(deviceId) {
  return db.prepare(
    'SELECT active_days, start_time, end_time FROM device_hours WHERE device_id = ? ORDER BY sort_order ASC')
    .all(deviceId).map((r) => ({
      days: String(r.active_days || '').split(',').filter((x) => x !== '').map(Number),
      start: r.start_time,
      end: r.end_time,
    }));
}

router.get('/:id/hours', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  res.json(readHours(req.params.id));
});

router.put('/:id/hours', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : null;
  if (!blocks) return res.status(400).json({ error: 'blocks array required' });

  const rows = [];
  for (const b of blocks) {
    const days = Array.isArray(b?.days) ? b.days.map(Number) : [];
    if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return res.status(400).json({ error: 'days must be a non-empty list of integers 0-6' });
    }
    const start = b.start || '00:00';
    const end = b.end || '24:00';
    if (!HOURS_TIME.test(start)) return res.status(400).json({ error: 'start must be HH:MM' });
    if (!(HOURS_TIME.test(end) || end === '24:00')) return res.status(400).json({ error: 'end must be HH:MM or 24:00' });
    rows.push({ days: [...new Set(days)].sort((x, y) => x - y).join(','), start, end });
  }

  const save = db.transaction(() => {
    db.prepare('DELETE FROM device_hours WHERE device_id = ?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO device_hours (id, device_id, active_days, start_time, end_time, sort_order) VALUES (?,?,?,?,?,?)');
    rows.forEach((r, i) => ins.run(require('uuid').v4(), req.params.id, r.days, r.start, r.end, i));
  });
  save();

  res.json({ blocks: readHours(req.params.id) });
});

router.post('/:id/replace', (req, res) => {
  const target = checkDeviceOwnership(req, res);
  if (!target) return;

  const { pairing_code } = req.body || {};
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });

  const pairLockout = require('../lib/pair-lockout');
  const { getClientIp } = require('../services/activity');
  const ip = getClientIp(req);
  if (pairLockout.isLocked(ip)) {
    return res.status(429).json({ error: 'Too many failed pairing attempts. Try again in a few minutes.' });
  }

  // A claimed screen is what gets replaced. An unclaimed row has nothing worth carrying across,
  // and "replace" on it would just be a confusing way to pair.
  if (!target.user_id) {
    return res.status(409).json({ error: 'This screen has never been paired - use Add screen instead' });
  }

  const source = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(String(pairing_code));
  if (!source) {
    pairLockout.recordFailure(ip);   // an unknown code is a guess, exactly as in pairing
    return res.status(404).json({ error: 'No device found with that pairing code' });
  }
  if (source.id === target.id) {
    return res.status(400).json({ error: 'That code belongs to this same screen' });
  }
  /*
   * THE GUARD THAT MATTERS. A claimed code names hardware that is already somebody else's screen;
   * accepting it here would silently swallow that screen - its content gone, its row deleted - to
   * feed this one. Refuse, and name the screen, because the usual cause is a typo that happens to
   * hit a real code.
   */
  if (source.user_id) {
    return res.status(409).json({
      error: `That code belongs to "${source.name || source.id}", which is already paired. `
        + 'Remove that screen first if you meant to reuse its hardware.',
    });
  }
  const lastSeen = source.last_heartbeat || source.created_at;
  if (pairLockout.isCodeExpired(lastSeen)) {
    return res.status(410).json({ error: 'Pairing code expired - restart the display to get a new code' });
  }
  pairLockout.reset(ip);

  const deviceNs = req.app.get('io')?.of('/device');

  /*
   * One transaction. A half-applied swap is the worst outcome available here: the target row
   * carrying a token the new panel does not have, or two rows both claiming the same hardware.
   */
  const swap = db.transaction(() => {
    // The target adopts the new hardware's credentials and reported identity. Everything the
    // operator configured is simply not in this list, which is how it survives.
    db.prepare(`UPDATE devices
                   SET device_token = ?, pairing_code = NULL, status = 'online',
                       ip_address = ?, last_heartbeat = strftime('%s','now'),
                       platform = COALESCE(?, platform), android_version = COALESCE(?, android_version),
                       app_version = COALESCE(?, app_version), client_type = COALESCE(?, client_type),
                       screen_width = COALESCE(?, screen_width), screen_height = COALESCE(?, screen_height),
                       capabilities = COALESCE(?, capabilities),
                       offline_reason = NULL, offline_reason_at = NULL, offline_detail = NULL,
                       updated_at = strftime('%s','now')
                 WHERE id = ?`)
      .run(source.device_token, source.ip_address, source.platform, source.android_version,
           source.app_version, source.client_type, source.screen_width, source.screen_height,
           source.capabilities, target.id);

    // The hardware's fingerprint now names the target row, so the NEXT reconnect - and any future
    // reinstall - lands on this screen instead of provisioning a third one.
    db.prepare('UPDATE device_fingerprints SET device_id = ?, user_id = ? WHERE device_id = ?')
      .run(target.id, target.user_id, source.id);

    // The placeholder row the new hardware provisioned for itself goes away. It was never claimed,
    // so nothing references it and no licence was ever recorded against it.
    db.prepare('DELETE FROM devices WHERE id = ?').run(source.id);
  });

  try { swap(); }
  catch (e) {
    console.error(`[replace] ${target.id} <- ${source.id} failed: ${e.message}`);
    return res.status(500).json({ error: 'Replace failed - nothing was changed' });
  }
  console.log(`[replace] screen ${target.id} now runs the hardware that was ${source.id}`);

  if (deviceNs) {
    /*
     * Order is load-bearing. The OLD panel is told first, while target.id still means it; once the
     * new hardware joins that room a broadcast would reach both, and "you are unpaired" is the one
     * message the incoming panel must never see.
     */
    deviceNs.to(target.id).emit('device:unpaired', { reason: 'replaced' });
    // The new panel adopts the identity. device:registered is what makes the app persist a new
    // device_id (config.deviceId = newDeviceId); device:paired is what takes it off the pairing
    // screen. Both are needed, in that order.
    deviceNs.to(source.id).emit('device:registered', {
      device_id: target.id, device_token: source.device_token, status: 'online',
    });
    deviceNs.to(source.id).emit('device:paired', {
      device_id: target.id, name: target.name, settings_pin: target.settings_pin,
    });
    // And its content, so the swap ends with the screen playing rather than waiting up to a minute
    // for the next register to carry it.
    try {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      deviceNs.to(source.id).emit('device:playlist-update', buildPlaylistPayload(target.id));
    } catch (e) { /* best-effort; the next register carries it */ }
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(target.id);
  const dashboardNs = req.app.get('io')?.of('/dashboard');
  if (dashboardNs) {
    const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');
    emitToWorkspace(dashboardNs, workspaceRoom(updated.workspace_id), 'dashboard:device-status',
      { device_id: updated.id, status: 'online' });
  }
  res.json(stripDeviceSecrets(updated));
});

// #146 Item D: operator BLOCK / UNBLOCK toggle. Writes devices.blocked; the device
// socket re-reads `blocked` on every register, so the block takes effect on the
// device's NEXT register with NO server restart (and, via the #146 identity chain, is
// enforced even if that reconnect arrives without a device_id). Write-gated + workspace-
// scoped by checkDeviceOwnership. OUTAGE PROCEDURE (dashboard down): set it by hand via
// direct SQLite — `UPDATE devices SET blocked = 1 WHERE id = '<device_id>';` (0 to
// unblock) — same column, same next-register effect.
/*
 * Set or rotate the on-device settings PIN.
 *
 * Body: { pin: "123456" } to set explicitly, or { rotate: true } for a fresh random one.
 *
 * Was provisioned once at pairing and never changeable, which made it a shared secret with no
 * expiry: anyone who watched it typed kept it for the life of the panel, and revoking it meant
 * unpairing and re-pairing. Now it can be rotated the moment an installer leaves.
 *
 * Pushed to the panel immediately over its socket. Without that the new PIN would only take effect
 * at the next pairing — so the operator would believe they had revoked access while the old PIN
 * still opened the menu, which is worse than not offering the feature.
 */
router.post('/:id/settings-pin', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  const pinLib = require('../lib/settings-pin');
  let pin;
  if (req.body && req.body.rotate) {
    pin = pinLib.generatePin();
  } else {
    const v = pinLib.validatePin(req.body && req.body.pin);
    if (!v.ok) return res.status(400).json({ error: v.error });
    pin = v.pin;
  }

  db.prepare("UPDATE devices SET settings_pin = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(pin, req.params.id);

  // Live push. A panel that is offline picks it up on its next pair/reconnect; the response says
  // which happened so the dashboard can tell the operator whether it is in force yet.
  let delivered = false;
  try {
    const io = req.app.get('io');
    if (io) {
      const ns = io.of('/device');
      const room = ns.adapter.rooms.get(req.params.id);
      if (room && room.size > 0) {
        ns.to(req.params.id).emit('device:settings-pin', { settings_pin: pin });
        delivered = true;
      }
    }
  } catch (e) { console.warn(`[settings-pin] push failed: ${e.message}`); }

  // Deliberately NOT logging the PIN itself.
  console.log(`[settings-pin] device ${req.params.id} pin ${req.body && req.body.rotate ? 'rotated' : 'set'} by user ${req.user.id} (delivered=${delivered})`);
  res.json({ success: true, settings_pin: pin, delivered });
});

router.post('/:id/block', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET blocked = 1, updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  // Mirror onto the saved settings so the block survives a delete + re-pair on purpose rather than
  // by accident of whatever the saved copy happened to hold.
  try { deviceSettings.setBlockedByDevice(req.params.id, true); } catch (e) { console.warn(`[blocked] save mirror failed: ${e.message}`); }
  console.warn(`[blocked] device ${req.params.id} blocked via dashboard (user ${req.user.id})`);
  res.json({ success: true, id: req.params.id, blocked: true });
});
router.post('/:id/unblock', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET blocked = 0, updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  // MUST clear the saved copy too. applyToDevice() restores `blocked` on re-pair, so leaving the
  // saved 1 in place made unblock temporary: the next delete + re-pair silently re-blocked the
  // device, with nothing in the dashboard to explain it and no way for the operator to escape.
  try { deviceSettings.setBlockedByDevice(req.params.id, false); } catch (e) { console.warn(`[blocked] save mirror failed: ${e.message}`); }
  console.log(`[blocked] device ${req.params.id} unblocked via dashboard (user ${req.user.id})`);
  res.json({ success: true, id: req.params.id, blocked: false });
});

// #150: re-adopt — apply a removed device's saved settings onto device :id. For the case the
// fingerprint did NOT auto-match (factory reset / new hardware), so the automatic re-pair
// restore couldn't fire. Auth: caller can write device :id (checkDeviceOwnership) AND the
// snapshot belongs to the SAME workspace as the device (no cross-tenant apply).
router.post('/:id/re-adopt', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;
  const { fingerprint } = req.body || {};
  if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' });
  const snap = deviceSettings.getByFingerprint(fingerprint);
  if (!snap) return res.status(404).json({ error: 'No saved settings for that fingerprint' });
  if (snap.workspace_id !== device.workspace_id) {
    return res.status(403).json({ error: 'Saved settings belong to a different workspace' });
  }
  deviceSettings.applyToDevice(req.params.id, fingerprint);
  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  console.log(`[#150] re-adopted settings (fp ${fingerprint.slice(0, 8)}…) onto device ${req.params.id} by user ${req.user.id}`);
  res.json(stripDeviceSecrets(updated));
});

// Delete device
router.delete('/:id', (req, res) => {
  const device = checkDeviceOwnership(req, res);
  if (!device) return;

  // #150: snapshot this device's settings (keyed by its fingerprint) BEFORE the row dies,
  // so a re-pair of the SAME physical device restores orientation/name/playlist/etc instead
  // of silently resetting to defaults. No-op if the device has no fingerprint link yet.
  try { deviceSettings.snapshot(req.params.id); } catch (e) { console.warn(`[#150] settings snapshot failed for ${req.params.id}: ${e.message}`); }

  // Clean up related data (playlist is NOT deleted — may be shared with other devices)
  db.prepare('DELETE FROM schedules WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM screenshots WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM device_telemetry WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM video_wall_devices WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);

  // Notify dashboard in real-time. Phase 2.3: scope to the device's
  // (now-deleted but still-known) workspace room. `device.workspace_id`
  // came from checkDeviceOwnership() above.
  const io = req.app.get('io');
  if (io) {
    const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');
    emitToWorkspace(io.of('/dashboard'), workspaceRoom(device.workspace_id), 'dashboard:device-removed', { device_id: req.params.id });
  }

  // Nothing to re-price here any more. Billing is per licence-DAY, closed monthly, so removing
  // a screen simply means the remaining days of the month cost less — recorded by the sampler
  // in lib/tenant-billing.js, not by a hook on this path.

  res.json({ success: true });
});

module.exports = router;
