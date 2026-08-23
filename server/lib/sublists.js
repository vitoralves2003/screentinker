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
/*
 * A shuffled pass over a sub-list.
 *
 * WHERE THE RANDOMNESS LIVES, and why it is here rather than on the player. The rotation is
 * flattened into the snapshot at publish time — that is the whole reason sub-lists work on a
 * device that knows nothing about them. Sorting at play time would mean changing Android, Tizen
 * and the web player, so instead each of the `rounds` passes baked into the snapshot gets its own
 * permutation. A screen therefore sees N different orders before anything repeats. It is not a
 * fresh draw per play, and the caller was told so; it is the strongest shuffle obtainable without
 * touching a single player.
 *
 * `avoid` is the item that ended the previous pass. Without it, a permutation beginning with the
 * same item the last one ended on plays it twice in a row across the seam — the single artefact
 * that makes a shuffle look broken rather than random. One swap fixes it, and it is skipped for a
 * pool of one, where the repeat is unavoidable and expected.
 */
/*
 * How many complete cycles of a shuffled sub-list to bake into a snapshot. Four is enough that the
 * repeat is not something a person standing in front of the screen notices, and small enough that
 * a twenty-item rotation still fits well inside the snapshot ceiling.
 */
const SHUFFLE_CYCLES = 4;

function shuffledPass(pool, avoid) {
  const out = pool.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length > 1 && avoid && out[0] === avoid) {
    const j = 1 + Math.floor(Math.random() * (out.length - 1));
    [out[0], out[j]] = [out[j], out[0]];
  }
  return out;
}

function expandSnapshot(items, { rounds = 10, maxItems = 2000, startCursors = {} } = {}) {
  const subIds = [...new Set(items.filter((i) => i.sub_playlist_id).map((i) => i.sub_playlist_id))];
  if (subIds.length === 0) return items;

  // Resolve each sub-list once, not once per round.
  const resolved = new Map();
  for (const id of subIds) resolved.set(id, subListItems(id));

  // A sub-list that is empty (or whose every item expired) contributes nothing. Its slot is
  // dropped rather than rendering a blank — a black frame on a screen looks like a fault.
  /*
   * Shuffle is a property of the SLOT, not of the sub-list: the same rotation can be sequential in
   * one playlist and random in another, so the state is keyed by slot rather than by sub-list id.
   */
  const shuffleState = new Map();   // slot key -> { queue, lastPicked }
  const slotKey = (item, i) => `${item.sub_playlist_id}#${item._iid ?? i}`;

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
  /*
   * How wide a window to bake, and this is where a shuffled slot differs sharply.
   *
   * Each pass emits ONE item per slot, so `rounds` picks is rounds/poolSize complete cycles — with
   * the default 10 and a ten-item sub-list that is exactly ONE permutation, shuffled once and then
   * replayed for ever. Which is not what anybody means by random.
   *
   * So a shuffled slot asks for SHUFFLE_CYCLES whole cycles of the largest shuffled pool. The
   * budget is computed UP FRONT rather than left to the truncation guard below, because
   * truncating mid-pass would cut a permutation in half — dropping an item from the last cycle,
   * which is the one failure a shuffle must never have.
   *
   * The LCM shortcut still applies when nothing is shuffled: there, every pass IS the same
   * pattern, and emitting more than lcm() of them is pure duplication.
   */
  const shuffledSizes = items
    .filter((i) => i.sub_playlist_id && i.sub_order === 'random')
    .map((i) => resolved.get(i.sub_playlist_id).length)
    .filter((n) => n > 0);

  let effectiveRounds;
  if (shuffledSizes.length) {
    const widest = Math.max(...shuffledSizes);
    const budget = Math.max(1, Math.floor(maxItems / Math.max(1, items.length)));
    // Whole cycles only: a window ending mid-permutation is a cycle with items missing.
    const wanted = Math.max(rounds, widest * SHUFFLE_CYCLES);
    const affordable = Math.max(widest, Math.floor(budget / widest) * widest) || widest;
    effectiveRounds = Math.max(1, Math.min(wanted, affordable));
  } else {
    effectiveRounds = Math.max(1, Math.min(rounds, lcmCapped(sizes, rounds)));
  }

  const out = [];
  let truncated = false;
  for (let round = 0; round < effectiveRounds && !truncated; round++) {
    for (const [itemIndex, item] of items.entries()) {
      if (!item.sub_playlist_id) {
        // A static item repeats identically each pass. Cloned so a later per-item mutation
        // (e.g. the mute patcher) cannot alter every copy at once through a shared reference.
        out.push({ ...item });
      } else {
        const pool = resolved.get(item.sub_playlist_id);
        if (!pool.length) continue;                       // empty sub-list: slot skipped

        let picked;
        let idx;
        if (item.sub_order === 'random') {
          const key = slotKey(item, itemIndex);
          let st = shuffleState.get(key);
          if (!st || !st.queue.length) {
            st = { queue: shuffledPass(pool, st && st.lastPicked), lastPicked: st && st.lastPicked };
            shuffleState.set(key, st);
          }
          picked = st.queue.shift();
          st.lastPicked = picked;
          /*
           * The cursor a player reports back is a position in a sequence. A shuffled slot has no
           * such position, so it is reported as -1 rather than as a number that would be resumed
           * into the wrong place after a restart.
           */
          idx = -1;
        } else {
          idx = cursors[item.sub_playlist_id] % pool.length;
          cursors[item.sub_playlist_id] = idx + 1;
          picked = pool[idx];
        }
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
  // Editor-only fields, stripped before the wire. sub_order describes how the slot was expanded;
  // the expansion is already done here, so sending it would be telling the player about a
  // decision it has no part in.
  for (const o of out) { delete o._iid; delete o.sub_order; }
  return out;
}

module.exports = {
  SubListError, requireSingleTarget, validateSubList, expandSnapshot,
  subListItems, hasSubListItems, isUsedAsSubList,
};
