'use strict';

// v4 CORE-PASS liveness helpers — pure, VERSION-AGNOSTIC, mixed-fleet-safe. Dependency-free so they
// are unit-testable and the imperative shells (deviceSocket heartbeat/register handlers, the
// heartbeat offline sweep) stay thin. The server talks to a MIX simultaneously — v4 clients (have a
// watchdog, consume the ack, send an identity block), OLD pre-v4 clients (none of that), and
// genuinely-disconnected devices — and none of these may break the server or each other.

// ── Uniform ack (PRIMARY + FIX 1: reconnect-window gap) ────────────────────────────────────────
// Should THIS device:heartbeat be acked with device:heartbeat-ack? The ack keeps a v4 client's
// watchdog armed; it is emitted from the SHARED heartbeat handler (uniform by construction across
// APK / .wgt / /player) and is HARMLESS to old clients (they don't consume it). We ack a KNOWN
// device — identity-agnostic:
//   - an already-authenticated socket (authedDeviceId set), OR
//   - a heartbeat carrying a device_id that RESOLVES to a real device (a real device mid-reconnect,
//     BEFORE this socket finished re-registering — the deferred ack-gap fix).
// We do NOT ack anonymous / never-authenticated sockets (no device_id, or an unknown id): those are
// covered by degrade-safe — an un-acked client's watchdog simply never arms, so there is no
// false-fire and no storm.
function ackableHeartbeat(authedDeviceId, heartbeatDeviceId, deviceExists) {
  if (authedDeviceId) return true;                    // authenticated socket -> known
  if (!heartbeatDeviceId) return false;               // anonymous heartbeat -> not acked
  return !!deviceExists(heartbeatDeviceId);           // real device mid-reconnect -> ack (window fix)
}

/*
 * DASHBOARD LIVENESS — four states, and the clock decides three of them.
 *
 *   healthy  green    heard from within the last 5 minutes
 *   idle     amber    silent for 5 minutes: something is wrong, the screen may still be playing
 *   offline  red      silent for 10 minutes: treat it as down
 *   awaiting blue     communicating fine, but has no content to show
 *
 * WHAT CHANGED, AND THE TRADE-OFF THAT WAS ACCEPTED WITH IT.
 *
 * This used to key on socket PRESENCE: no live socket meant offline, immediately (after a 5s
 * debounce). That is a strong, fast signal — a panel unplugged at 14:00 went red at 14:00. The
 * operator asked for the clock instead, so a panel that drops now shows amber for five minutes
 * and red only after ten. The cost is real and is the point of writing it down here: a screen
 * that dies is not called dead for ten minutes, which is exactly the window in which someone
 * could have rung the shop before a customer noticed. The gain is that a flaky connection stops
 * painting the fleet red several times a day, and amber says the true thing in between.
 *
 * AGE COMES FROM devices.last_heartbeat, not from the in-memory connection. The connection entry
 * is deleted on disconnect, so age would jump to Infinity the moment the socket closed and every
 * disconnect would be instantly red again — the old behaviour wearing new labels. The column
 * also survives a server restart, which the map does not.
 *
 * `status` IS NOT TOUCHED. Billing, the status log and access checks all read devices.status and
 * keep their own meaning; this governs what the dashboard SHOWS.
 */
const IDLE_AFTER_MS = 5 * 60 * 1000;
const OFFLINE_AFTER_MS = 10 * 60 * 1000;
const DEGRADED_RECONNECTS = 3;        // >=3 (re)registers within the reconnect window => churn

function deriveLiveness({ lastHeartbeatAgeMs, recentReconnects, hasContent } = {}, opts = {}) {
  const idleMs = opts.idleAfterMs != null ? opts.idleAfterMs : IDLE_AFTER_MS;
  const offMs = opts.offlineAfterMs != null ? opts.offlineAfterMs : OFFLINE_AFTER_MS;
  const churn = opts.degradedReconnects != null ? opts.degradedReconnects : DEGRADED_RECONNECTS;

  const age = lastHeartbeatAgeMs == null ? Infinity : lastHeartbeatAgeMs;
  if (age >= offMs) return 'offline';
  if (age >= idleMs) return 'idle';

  /*
   * Churn is amber, not green. A panel re-registering three times a minute is answering, so the
   * clock alone would call it healthy — and it is the single loudest sign of a screen about to
   * go down. Amber is what amber is for.
   */
  if ((recentReconnects || 0) >= churn) return 'idle';

  /*
   * Communicating but with nothing to show. Ordered BELOW the two fault states deliberately: a
   * screen that is both silent and empty has a connection problem, and saying "waiting for
   * content" about a panel nobody can reach sends someone to fix the wrong thing.
   */
  if (hasContent === false) return 'awaiting';
  return 'healthy';
}

// ── Identity capture (FIX 3: capture-don't-act, DEGRADES on missing) ────────────────────────────
// Capture the v4 identity block when present; when absent/partial (an OLD client), fill
// "legacy"/"unknown" — NEVER fail on a missing field. No logic is built on this yet.
function captureIdentity(data) {
  const d = data || {};
  return {
    client_type: d.client_type || 'legacy',
    client_version: d.client_version || 'unknown',
    platform: d.platform || 'unknown',
    contract_version: d.contract_version || 'legacy',
  };
}

/*
 * Absent is not a statement — the same rule applyCapabilities() enforces for the capability column.
 *
 * captureIdentity above coerces a MISSING platform to the literal 'unknown', and persistIdentity
 * used to write that straight over the stored value. One register from a client that doesn't send
 * the field — an older build after an OTA, a downgrade, anything pre-v4 — permanently erased the
 * panel's platform.
 *
 * That column is load-bearing, not decorative: player-capabilities.platformFamily() reads it to
 * pick a baseline. An erased Tizen panel falls through to the WEB baseline and is offered a volume
 * slider the .wgt has no handler for — the exact control BASELINE.tizen exists to hide — while an
 * erased BrightSign loses screen power and reboot and gains screenshots it cannot take.
 *
 * platform and client_type are preserved; client_version and contract_version are NOT. The split is
 * "physical fact" vs "property of the build currently installed": a panel does not stop being a
 * Tizen TV or a .wgt player, but its version and protocol level change with every OTA, and there
 * "we no longer know" is the truthful answer rather than a stale number.
 *
 * client_type earns its place because it is the SECOND signal platformFamily() reads ('wgt' => a
 * Tizen TV): preserving platform while letting client_type decay to 'legacy' would leave a panel
 * with no identifying signal at all.
 *
 * @param {object|null} stored    the identity row currently in the DB
 * @param {object} incoming       the freshly captured identity (mutated in place and returned)
 */
const IDENTITY_PLACEHOLDER = { platform: 'unknown', client_type: 'legacy' };
function preserveKnownIdentity(stored, incoming) {
  if (!incoming || !stored) return incoming;
  for (const [field, placeholder] of Object.entries(IDENTITY_PLACEHOLDER)) {
    if (incoming[field] === placeholder && stored[field] && stored[field] !== placeholder) {
      incoming[field] = stored[field];
    }
  }
  return incoming;
}

// A1 change-detection: has the (already-captured) identity changed vs what's stored? A genuine
// reconnect with an unchanged identity (the common case) then does NO write. A never-stored device
// (current null / all-NULL columns) or a real change (e.g. new client_version after an OTA) writes.
function identityChanged(current, incoming) {
  if (!current) return true;
  return current.client_type !== incoming.client_type
    || current.client_version !== incoming.client_version
    || current.platform !== incoming.platform
    || current.contract_version !== incoming.contract_version;
}

// Exit-signal contract v1 — manner-of-death. A client may ONLY announce 'crashed' (its uncaught-
// exception handler fired) or 'clean_exit' (a confident lifecycle-end). 'silent' is server-inferred by
// ABSENCE and is NEVER accepted from a client. Honesty by construction: an unknown/uncertain value is
// rejected (-> null), so the device falls to server-inferred 'silent' rather than being coerced into a
// wrong category. detail is optional (crash message / lifecycle-hook name), sanitized + length-capped.
const CLIENT_EXIT_REASONS = ['crashed', 'clean_exit'];
function sanitizeExitReason(reason, detail) {
  if (!CLIENT_EXIT_REASONS.includes(reason)) return null;
  const d = (typeof detail === 'string' && detail.trim()) ? detail.trim().slice(0, 200) : null;
  return { reason, detail: d };
}

module.exports = { ackableHeartbeat, deriveLiveness, captureIdentity, identityChanged, preserveKnownIdentity, sanitizeExitReason, CLIENT_EXIT_REASONS, IDLE_AFTER_MS, OFFLINE_AFTER_MS, DEGRADED_RECONNECTS };
