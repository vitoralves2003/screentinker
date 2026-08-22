const { db, pruneStatusLog, pruneTelemetryRetention } = require('../db/database');
const config = require('../config');
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');
const statusLogWriter = require('../lib/status-log-writer');
const { chunkedDelete, currentBand, yieldTick } = require('../lib/chunked-prune'); // #146 non-blocking sweeps

const liveness = require('../lib/liveness'); // v4 core pass: server-derived 3-state liveness

// Track connected device sockets: deviceId -> { socketId, lastHeartbeat }
const deviceConnections = new Map();

// FIX 2: version-agnostic reconnect-frequency signal (every client reconnects the same way). A
// rolling window of recent (re)register timestamps per device -> "degraded-reconnecting" when it churns.
let _io = null; // captured in startHeartbeatChecker so livenessFor() can check namespace presence
const RECONNECT_WINDOW_MS = 60000;
const reconnectTimes = new Map(); // deviceId -> [timestamps within the window]
function recordReconnect(deviceId, now = Date.now()) {
  const arr = (reconnectTimes.get(deviceId) || []).filter(t => now - t < RECONNECT_WINDOW_MS);
  arr.push(now);
  reconnectTimes.set(deviceId, arr);
}
function recentReconnects(deviceId, now = Date.now()) {
  const arr = (reconnectTimes.get(deviceId) || []).filter(t => now - t < RECONNECT_WINDOW_MS);
  if (arr.length) reconnectTimes.set(deviceId, arr); else reconnectTimes.delete(deviceId);
  return arr.length;
}
// Server-derived liveness for a device — from socket presence + heartbeat age + reconnect churn ONLY
// (all version-agnostic). A disconnected device is a clean 'offline' (normal state, not an error).
/*
 * The four-state liveness the dashboard shows. See lib/liveness for what the states mean and
 * what was traded to make them time-based.
 *
 * AGE comes from the live connection when there is one and from devices.last_heartbeat when
 * there is not. That fallback is the whole mechanism: the in-memory entry is deleted on
 * disconnect, so without it age would jump to Infinity the instant a socket closed and a dropped
 * panel would be red immediately — which is precisely the behaviour the amber window replaced.
 * The column also survives a server restart; the map does not.
 */
function livenessDetail(deviceId) {
  const conn = deviceConnections.get(deviceId);
  const deviceNs = _io ? _io.of('/device') : null;
  const connected = !!(conn && deviceNs && deviceNs.sockets.has(conn.socketId));

  let lastHeartbeatAgeMs;
  if (connected && conn) {
    lastHeartbeatAgeMs = Date.now() - conn.lastHeartbeat;
  } else {
    let row = null;
    try {
      row = db.prepare('SELECT last_heartbeat, playlist_id, layout_id FROM devices WHERE id = ?').get(deviceId);
    } catch (e) { row = null; }
    lastHeartbeatAgeMs = row && row.last_heartbeat
      ? Date.now() - (row.last_heartbeat * 1000)
      : Infinity;
  }

  /*
   * "Waiting for content" is only asked about a screen we can still hear from. Resolving it for
   * an offline one would cost a query per device on every overview render to answer a question
   * nobody has about a panel they cannot reach.
   */
  let hasContent;
  if (lastHeartbeatAgeMs < liveness.IDLE_AFTER_MS) {
    try {
      const d = db.prepare('SELECT playlist_id, layout_id FROM devices WHERE id = ?').get(deviceId);
      hasContent = !!(d && (d.playlist_id
        || (d.layout_id && db.prepare('SELECT COUNT(*) c FROM device_zone_playlists WHERE device_id = ? AND playlist_id IS NOT NULL').get(deviceId).c > 0)));
    } catch (e) { hasContent = undefined; }   // unknown -> never claims "waiting"
  }

  /*
   * Is the PLAYER running, as opposed to the service that talks for it?
   *
   * Only asked of a screen that is answering and has content — the two cases where "nothing is
   * playing" is a fault rather than the expected state.
   *
   * THE THRESHOLD IS DERIVED, NOT FIXED. playback-state is sent once per item, so a screen
   * showing a fifteen-minute video legitimately says nothing for fifteen minutes. A flat five
   * or ten minutes would call that panel dead every time it played its longest clip. Twice the
   * longest item, floored at ten minutes, adapts to the actual playlist.
   */
  let notPlaying;
  if (hasContent === true) {
    try {
      const row = db.prepare('SELECT last_playback_at, playlist_id FROM devices WHERE id = ?').get(deviceId);
      const longest = row && row.playlist_id
        ? (db.prepare('SELECT MAX(duration_sec) m FROM playlist_items WHERE playlist_id = ?').get(row.playlist_id).m || 0)
        : 0;
      const graceMs = Math.max(10 * 60 * 1000, longest * 2 * 1000);
      /*
       * A screen that has NEVER reported is left alone. It may have paired a moment ago, and
       * accusing it of not playing before it has had the chance is worse than saying nothing.
       */
      if (row && row.last_playback_at) {
        notPlaying = (Date.now() - row.last_playback_at * 1000) > graceMs;
      }
    } catch (e) { notPlaying = undefined; }
  }

  const state = liveness.deriveLiveness({
    lastHeartbeatAgeMs,
    recentReconnects: recentReconnects(deviceId),
    hasContent,
    notPlaying,
  });

  /*
   * "Offline" and "offline because the player is not running" look identical in a list and mean
   * very different things to whoever has to fix it: one is a trip to the site, the other is a
   * permission on a settings screen. The reason rides along so the row can say which.
   */
  const reason = (state === 'offline' && notPlaying === true) ? 'not_playing' : null;
  return { state, reason };
}

/* The state alone, for the many callers that only ever wanted that. */
function livenessFor(deviceId) { return livenessDetail(deviceId).state; }

function startHeartbeatChecker(io) {
  _io = io; // FIX 2: for livenessFor() namespace-presence checks
  // #146: startup sweep is chunked + async + fire-and-forget + NOT band-gated, so a
  // bloated device_status_log self-heals on next deploy WITHOUT freezing boot (the old
  // whole-table sort froze boot 40-48s -> healthcheck fail -> restart loop). It
  // trickles in bounded batches while the server comes up and serves.
  pruneStatusLog({ bandGate: false }).catch(() => {});

  // #146: start the batched device_status_log flush loop.
  statusLogWriter.start();

  const deviceNs = io.of('/device');

  setInterval(() => {
    const now = Date.now();
    const dashboardNs = io.of('/dashboard');

    // #146 BILLING: credit currently-connected devices' usage for this interval.
    // Fire-and-forget + never throws into the interval (billing must not perturb the
    // heartbeat). Reads the same live presence map as the offline check below.
    accrueUsage(now).catch(() => {});

    // Check database for devices that should be offline
    const onlineDevices = db.prepare("SELECT id, last_heartbeat FROM devices WHERE status = 'online'").all();

    for (const device of onlineDevices) {
      const conn = deviceConnections.get(device.id);

      // #146: a device with a live, still-connected socket is UP, even if its last
      // heartbeat event is stuck behind a lagged event loop. Marking it offline on a
      // stale in-memory lastHeartbeat was the second false-offline cause (the screen
      // is online and playing, the CMS says offline). The socket still being in the
      // /device namespace is the authoritative liveness signal — trust it over the
      // (possibly queued) heartbeat clock. If the socket is genuinely gone, conn is
      // either absent or points at a socket no longer in the namespace, and we fall
      // through to the timeout below.
      if (conn && deviceNs.sockets.has(conn.socketId)) continue;

      const lastBeat = conn ? conn.lastHeartbeat : (device.last_heartbeat ? device.last_heartbeat * 1000 : 0);

      if (now - lastBeat > config.heartbeatTimeout) {
        // #148 Item 2: marking a device offline MUST also close any socket we still hold for
        // it, so DB-offline can never diverge from socket-state into a silent half-open the
        // client is never told about. The live-socket guard above already `continue`d for a
        // genuinely-live socket, so this only reaps a stale/half-open one (Engine.IO's
        // ping-timeout also reaps it, but this makes offline<=>closed explicit + immediate).
        if (conn) {
          const sock = deviceNs.sockets.get(conn.socketId);
          if (sock) { try { sock.disconnect(true); } catch (_) { /* already gone */ } }
        }
        // Exit-signal contract: this timeout path is the classic 'silent' case (froze, no clean
        // disconnect, no signal) — COALESCE annotates 'silent' unless a device:exit reason arrived
        // this session (e.g. a crash emit that beat the freeze). Pure annotation; detection unchanged.
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now'), offline_reason = COALESCE(offline_reason, 'silent'), offline_reason_at = COALESCE(offline_reason_at, strftime('%s','now')) WHERE id = ?")
          .run(device.id);
        deviceConnections.delete(device.id);

        const _off = db.prepare("SELECT offline_reason, offline_detail, client_type FROM devices WHERE id = ?").get(device.id) || {};
        // Notify dashboard (workspace-scoped via the device's room).
        emitToWorkspace(dashboardNs, deviceRoom(device.id), 'dashboard:device-status', {
          device_id: device.id,
          status: 'offline',
          liveness: 'offline', // FIX 2: derived — no live socket => offline (a normal state, not an error)
          offline_reason: _off.offline_reason || 'silent', // exit-signal contract: manner-of-death
          offline_detail: _off.offline_detail || null,
          client_type: _off.client_type || null,
          telemetry: null
        });
        reconnectTimes.delete(device.id); // clear churn history on a clean offline

        console.log(`Device ${device.id} marked offline (heartbeat timeout)`);
        // #146: batch through the coalescing writer (was an immediate INSERT here).
        // Offline-cause log: this liveness-timeout path is the "stopped reporting" case —
        // annotate reason/detail and record it in the unified incident feed too.
        statusLogWriter.record(device.id, 'offline_timeout', 'heartbeat_timeout', 'Stopped sending heartbeats');
        try {
          db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, 'offline', 'heartbeat_timeout', 'Stopped sending heartbeats')")
            .run(device.id);
        } catch (_) { /* incident feed is best-effort; never perturb the heartbeat loop */ }
      }
    }

    // #146: all table-growth maintenance runs OFF the interval body — async, chunked,
    // band-gated, re-entrancy-guarded — so a sweep can never block the loop or stack.
    // The offline-marking above stays synchronous (it's the core heartbeat function).
    runMaintenance();

  }, config.heartbeatInterval);
}

// #146: batched play-log prune (idx_play_logs_time), chunked so a 90-day backlog
// trims across many bounded DELETEs instead of one large statement.
const _delPlayLogs = db.prepare('DELETE FROM play_logs WHERE rowid IN (SELECT rowid FROM play_logs WHERE started_at < ? LIMIT ?)');
async function prunePlayLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - (90 * 86400);
  return (await chunkedDelete((lim) => _delPlayLogs.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// Offline-cause log: retention sweep for the unified incident feed, mirroring the
// device_status_log age prune (same retention window + chunked so a backlog trims across
// many bounded DELETEs, never one blocking statement). Rides idx_device_events_device_time
// only loosely (timestamp filter); bounded batches keep it off the loop regardless.
const _delDeviceEvents = db.prepare('DELETE FROM device_events WHERE rowid IN (SELECT rowid FROM device_events WHERE timestamp < ? LIMIT ?)');
async function pruneDeviceEvents() {
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.statusLogRetentionDays * 86400);
  return (await chunkedDelete((lim) => _delDeviceEvents.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// Per-device row cap: even within the retention window a chatty device (display on/off
// flapping, reconnect churn) shouldn't accumulate unbounded incident rows. Trim any
// device over the cap down to its most-recent DEVICE_EVENTS_PER_DEVICE_CAP rows. Only
// touches devices actually over the cap (cheap HAVING scan on the index), yielding between.
const DEVICE_EVENTS_PER_DEVICE_CAP = 500;
const _capDeviceEvents = db.prepare(`
  DELETE FROM device_events WHERE device_id = ? AND id NOT IN (
    SELECT id FROM device_events WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?
  )`);
async function capDeviceEvents() {
  const over = db.prepare('SELECT device_id FROM device_events GROUP BY device_id HAVING COUNT(*) > ?').all(DEVICE_EVENTS_PER_DEVICE_CAP);
  let trimmed = 0;
  for (const row of over) {
    trimmed += _capDeviceEvents.run(row.device_id, row.device_id, DEVICE_EVENTS_PER_DEVICE_CAP).changes;
    await yieldTick();
  }
  return trimmed;
}

// #146 interval maintenance — band-gated (skip while loaded; runs next tick) and
// re-entrancy-guarded (a long run never stacks with the next interval). Never throws
// into the interval. NOT for startup (see the un-gated startup prune above).
let _maintRunning = false;
async function runMaintenance() {
  if (_maintRunning) return;
  if (config.maintenanceBandGateEnabled && currentBand() !== 'normal') return;   // #146 P1.3 kill switch
  _maintRunning = true;
  try {
    await pruneProvisioningDevices();
    await prunePlayLogs();
    await pruneStatusLog({ bandGate: true });   // per-device chunked; own re-entrancy
    await pruneTelemetryRetention({ bandGate: true });   // #240 device_telemetry age sweep (per-device chunked)
    await pruneDeviceEvents();                   // offline-cause log: incident-feed age retention (chunked)
    await capDeviceEvents();                     // offline-cause log: per-device incident row cap
    await pruneUsageDaily();                     // #146 BILLING rollup retention (chunked)
    // Expiry sweeps on small tables — single cheap statements, bounded by table size.
    db.prepare("DELETE FROM team_invites WHERE expires_at < strftime('%s','now')").run();
    db.prepare("DELETE FROM workspace_invites WHERE expires_at < strftime('%s','now')").run();
  } catch (_) { /* maintenance must never crash the interval */ } finally { _maintRunning = false; }
}

function registerConnection(deviceId, socketId) {
  deviceConnections.set(deviceId, { socketId, lastHeartbeat: Date.now() });
}

function updateHeartbeat(deviceId) {
  const conn = deviceConnections.get(deviceId);
  if (conn) conn.lastHeartbeat = Date.now();
}

function removeConnection(deviceId) {
  deviceConnections.delete(deviceId);
}

function getConnection(deviceId) {
  return deviceConnections.get(deviceId);
}

function getAllConnections() {
  return deviceConnections;
}

// #146: LIVE connected-device count — the set with a live socket THIS INSTANT. Cheap
// in-memory read. Distinct from devices.status='online' (persisted, lags by the
// offline-timeout). Surfaced as /api/status.devices_connected.
function getConnectedCount() {
  return deviceConnections.size;
}

// #146 BILLING accumulator — credit each currently-connected device's today-row with the
// seconds elapsed since the last accrual. Retention-INDEPENDENT: it reuses the SAME live
// presence map as devices_connected (never reconstructs online time from status_log,
// which is only 3-day). Cheap + non-blocking: chunked UPSERTs, one bounded transaction
// per chunk, yielding between chunks. The per-accrual credit is CAPPED (accrualCapSeconds)
// so a stalled loop or restart gap can't inject a bogus large credit; the DAILY total is
// capped at 86400 in the UPSERT itself. Day is the UTC calendar day of the tick.
const _usageUpsert = db.prepare(`
  INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)
  ON CONFLICT(device_id, day) DO UPDATE SET online_seconds = MIN(86400, online_seconds + excluded.online_seconds)
`);
let _lastAccrue = 0;
let _accrualRunning = false;
async function accrueUsage(now = Date.now()) {
  if (_accrualRunning) return 0;                        // never stack; elapsed-based credit self-heals a skipped tick
  if (_lastAccrue === 0) { _lastAccrue = now; return 0; } // first tick establishes the baseline; credit nothing
  const credit = Math.min(Math.floor((now - _lastAccrue) / 1000), config.billing.accrualCapSeconds);
  _lastAccrue = now;
  if (credit <= 0) return 0;
  const ids = Array.from(deviceConnections.keys());
  if (!ids.length) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  _accrualRunning = true;
  try {
    const upsertMany = db.transaction((slice) => { for (const id of slice) _usageUpsert.run(id, day, credit); });
    const batch = config.billing.accrualBatch;
    for (let i = 0; i < ids.length; i += batch) {
      upsertMany(ids.slice(i, i + batch));
      if (i + batch < ids.length) await yieldTick();     // keep a huge fleet's accrual off the event loop
    }
  } finally { _accrualRunning = false; }
  return ids.length;
}

// #146 BILLING: prune the daily rollup beyond retention (chunked, so it can never
// bloat-then-freeze). `day` is a sortable 'YYYY-MM-DD' string → lexical < is a date <.
const _delUsage = db.prepare('DELETE FROM device_usage_daily WHERE rowid IN (SELECT rowid FROM device_usage_daily WHERE day < ? LIMIT ?)');
async function pruneUsageDaily() {
  const cutoff = new Date(Date.now() - config.billing.usageRetentionDays * 86400 * 1000).toISOString().slice(0, 10);
  return (await chunkedDelete((lim) => _delUsage.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// #142: sweep unclaimed provisioning devices older than 24h (imported devices keep a
// user_id and are preserved). #146: now async + CHUNKED (rides idx_devices_provisioning)
// so a provisioning-junk flood can't delete-cascade a huge batch in one synchronous
// statement. Returns rows deleted. NOTE: async now — callers must await.
const _delProvisioning = db.prepare(`
  DELETE FROM devices WHERE rowid IN (
    SELECT rowid FROM devices
    WHERE status = 'provisioning' AND user_id IS NULL AND created_at < ?
    LIMIT ?
  )
`);
async function pruneProvisioningDevices() {
  const cutoff = Math.floor(Date.now() / 1000) - (24 * 3600);
  return (await chunkedDelete((lim) => _delProvisioning.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

module.exports = {
  livenessDetail,
  startHeartbeatChecker,
  registerConnection,
  updateHeartbeat,
  removeConnection,
  getConnection,
  getAllConnections,
  getConnectedCount,
  recordReconnect,      // FIX 2
  recentReconnects,     // FIX 2
  livenessFor,          // FIX 2
  pruneProvisioningDevices,
  pruneDeviceEvents,   // offline-cause log: incident-feed retention
  capDeviceEvents,     // offline-cause log: per-device incident cap
  accrueUsage,
  pruneUsageDaily,
  __resetAccrual: () => { _lastAccrue = 0; },   // #146 test hook: reset the accrual baseline
};
