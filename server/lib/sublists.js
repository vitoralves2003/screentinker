'use strict';

/*
 * Loop OS sub-lists — a playlist item that points at ANOTHER playlist and contributes one of
 * that playlist's items each time the parent comes around. "Rotating slot" is the mental model:
 * a parent [Ad, News, Ad, Promos] where News and Promos are sub-lists plays a different news
 * item and a different promo on every pass.
 *
 * THE CENTRAL DESIGN CHOICE: the rotation is RESOLVED AT PUBLISH TIME, not on the player.
 *
 * expandSnapshot() below flattens N future passes into the ordinary flat item array that
 * published_snapshot has always been. So a player receives a longer plain playlist and plays it
 * top to bottom — no sub-list logic on the device at all, and every player already in the field
 * (Android, Tizen, webOS, BrightSign, the web player) supports sub-lists the day this ships,
 * with no client update.
 *
 * WHY NOT LCM. The obvious way to make the pattern repeat exactly is to expand
 * lcm(size(sub1), size(sub2), ...) passes. For the real playlists this is aimed at — ~40 items,
 * ~12 sub-lists — that is catastrophic: twelve co-prime-ish lists of 3-9 items each reach an LCM
 * in the millions, so the "snapshot" becomes hundreds of megabytes of JSON pushed over a socket
 * to a TV. Each sub-list therefore advances its OWN cursor independently and the window is a
 * fixed N passes. The sequence is not perfectly periodic at the seam after N passes — a sub-list
 * whose size does not divide N restarts its cycle there — which is the deliberate trade: a
 * slightly imperfect rotation nobody can perceive, instead of a payload nobody can deliver.
 */

const { db } = require('../db/database');

// --- validation ---------------------------------------------------------------------------

class SubListError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SubListError'; this.status = status; }
}

// Exactly one target. Returns which one, or throws with the reason.
function requireSingleTarget({ content_id, widget_id, sub_playlist_id }) {
  const set = [
    content_id ? 'content_id' : null,
    widget_id ? 'widget_id' : null,
    sub_playlist_id ? 'sub_playlist_id' : null,
  ].filter(Boolean);

  if (set.length === 0) throw new SubListError('content_id, widget_id or sub_playlist_id required');
  if (set.length > 1) throw new SubListError(`an item may reference only one of content_id, widget_id or sub_playlist_id (got ${set.join(' + ')})`);
  return set[0];
}

function isUsedAsSubList(playlistId) {
  return !!db.prepare('SELECT 1 FROM playlist_items WHERE sub_playlist_id = ? LIMIT 1').get(playlistId);
}

function hasSubListItems(playlistId) {
  return !!db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND sub_playlist_id IS NOT NULL LIMIT 1').get(playlistId);
}

/*
 * Validate adding `subPlaylistId` as a sub-list of `parentId`. Throws SubListError.
 *
 * Nesting is capped at ONE level, and that needs BOTH directions checked:
 *   - the child must not already contain sub-lists of its own (would make the parent 2 deep)
 *   - the parent must not already be someone else's sub-list (same, from the other side)
 * Checking only the first is the easy mistake: A->B is fine and B->C is fine in isolation, but
 * together they are A->B->C. Depth is a property of the whole chain, not of one edge.
 *
 * A one-level cap also means a cycle is impossible by construction, but self-reference is
 * rejected explicitly because it is the one a user can reach by accident.
 */
function validateSubList(parentId, subPlaylistId, workspaceId) {
  if (subPlaylistId === parentId) throw new SubListError('a playlist cannot contain itself');

  const sub = db.prepare('SELECT id, workspace_id, name FROM playlists WHERE id = ?').get(subPlaylistId);
  if (!sub) throw new SubListError('sub_playlist_id not found', 404);
  if (sub.workspace_id && workspaceId && sub.workspace_id !== workspaceId) {
    throw new SubListError('sub-playlist is not in this playlist\'s workspace', 403);
  }

  if (hasSubListItems(subPlaylistId)) {
    throw new SubListError(`"${sub.name}" already contains sub-lists of its own — nesting is limited to one level`);
  }
  if (isUsedAsSubList(parentId)) {
    throw new SubListError('this playlist is already used as a sub-list, so it cannot contain sub-lists itself — nesting is limited to one level');
  }
  return sub;
}

// --- expansion ----------------------------------------------------------------------------

/*
 * Resolve one sub-list's items into snapshot rows, ordered. Mirrors the parent query's live
 * filters — an expired or deactivated asset must not sneak in through a sub-list when it would
 * have been dropped from the parent (that was the whole point of #157's LIVE check).
 */
function subListItems(subPlaylistId) {
  return db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.duration_sec, pi.muted,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url, c.unstable_connection,
           c.captions_enabled, c.captions_lang, c.subtitle_url, c.subtitle_lang,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
      AND pi.sub_playlist_id IS NULL
      AND (
        pi.content_id IS NULL
        OR (COALESCE(c.is_active, 1) = 1 AND (c.expires_at IS NULL OR c.expires_at > strftime('%s','now')))
      )
    ORDER BY pi.sort_order ASC
  `).all(subPlaylistId);
}

// LCM of the sub-list sizes, abandoned as soon as it passes `cap`. Used only to shorten the
// expansion window when the pattern repeats sooner than `rounds`; the caller clamps to `cap`
// anyway, so bailing out early is free and keeps this O(number of sub-lists).
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function lcmCapped(sizes, cap) {
  let acc = 1;
  for (const n of sizes) {
    acc = (acc / gcd(acc, n)) * n;
    if (acc >= cap) return cap;
  }
  return acc;
}

/*
 * Flatten a parent item list into `rounds` passes, advancing each sub-list's own cursor.
 *
 * `items` is what buildSnapshotItems produced: ordinary rows, plus rows carrying sub_playlist_id.
 * The output is the same flat array shape, so every existing consumer of published_snapshot
 * (deviceSocket, the service worker, the mute patcher, the content-deletion filter) is unchanged.
 *
 * Returns the ORIGINAL array untouched when there are no sub-lists — a plain playlist must never
 * be multiplied by N.
 *
 * `startCursors` lets a caller resume rotation from where a device left off ({subId: index}).
 * Unused by the publish path (which always starts at 0, per "no saved state -> start at 0") and
 * present for the per-device resume path.
 */
function expandSnapshot(items, { rounds = 10, maxItems = 2000, startCursors = {} } = {}) {
  const subIds = [...new Set(items.filter((i) => i.sub_playlist_id).map((i) => i.sub_playlist_id))];
  if (subIds.length === 0) return items;

  // Resolve each sub-list once, not once per round.
  const resolved = new Map();
  for (const id of subIds) resolved.set(id, subListItems(id));

  // A sub-list that is empty (or whose every item expired) contributes nothing. Its slot is
  // dropped rather than rendering a blank — a black frame on a screen looks like a fault.
  const cursors = {};
  for (const id of subIds) {
    const size = resolved.get(id).length;
    // Normalise a resumed cursor against the CURRENT size: a sub-list edited since the device
    // saved its position would otherwise resume out of range (or off the end).
    cursors[id] = size ? (Math.max(0, Number(startCursors[id]) || 0) % size) : 0;
  }

  // How many passes are actually useful.
  //
  // The pattern repeats exactly at lcm(sizes), so emitting more than that is pure duplication —
  // with every sub-list one item long, lcm is 1 and a single pass says everything. Below that
  // ceiling the window is whatever `rounds` asks for.
  //
  // Computing the LCM here does NOT reintroduce the blow-up this design exists to avoid: it is
  // only used to SHORTEN the window, and the loop abandons it the moment it exceeds `rounds`,
  // so twelve co-prime sub-lists cost twelve multiplications and then fall back to `rounds`.
  // Expanding TO the LCM is what would be catastrophic, and that never happens.
  //
  // NB capping at the LONGEST sub-list instead would be a subtle downgrade: with a 3-item and a
  // 2-item list, 3 rounds leaves the 2-item list mid-cycle, so it restarts at its first item on
  // the loop seam and that item plays twice running. lcm(3,2)=6 ends both lists cleanly.
  const sizes = subIds.map((id) => resolved.get(id).length).filter((n) => n > 0);
  const effectiveRounds = Math.max(1, Math.min(rounds, lcmCapped(sizes, rounds)));

  const out = [];
  let truncated = false;
  for (let round = 0; round < effectiveRounds && !truncated; round++) {
    for (const item of items) {
      if (!item.sub_playlist_id) {
        // A static item repeats identically each pass. Cloned so a later per-item mutation
        // (e.g. the mute patcher) cannot alter every copy at once through a shared reference.
        out.push({ ...item });
      } else {
        const pool = resolved.get(item.sub_playlist_id);
        if (!pool.length) continue;                       // empty sub-list: slot skipped
        const idx = cursors[item.sub_playlist_id] % pool.length;
        cursors[item.sub_playlist_id] = idx + 1;
        const picked = pool[idx];
        out.push({
          ...picked,
          _iid: undefined,
          // The slot's placement wins (a sub-list dropped into a zone plays in that zone), but
          // the DURATION comes from the sub-item itself — it describes the asset actually on
          // screen, and a video's own length is what item-duration.js resolved for it.
          zone_id: item.zone_id ?? null,
          schedules: item.schedules,
          // Per-item provenance, so a player CAN persist "where is this sub-list up to" across a
          // restart and report it back. Purely additive: a player that ignores it still plays the
          // resolved sequence correctly, which is why sub-lists need no client update to work.
          _sub: { playlist_id: item.sub_playlist_id, cursor: idx, size: pool.length, round },
        });
      }
      // Hard ceiling. A wide playlist with many long sub-lists could otherwise produce a
      // snapshot too large to push over a socket to a TV; better a shorter rotation window than
      // an undeliverable payload.
      if (out.length >= maxItems) { truncated = true; break; }
    }
  }

  if (truncated) {
    console.warn(`[sublists] snapshot truncated at ${maxItems} items (${items.length} slots x ${effectiveRounds} rounds requested)`);
  }
  for (const o of out) delete o._iid;
  return out;
}

module.exports = {
  SubListError, requireSingleTarget, validateSubList, expandSnapshot,
  subListItems, hasSubListItems, isUsedAsSubList,
};
