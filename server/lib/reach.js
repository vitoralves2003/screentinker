'use strict';

/*
 * Which screens are running a set of lists — the one definition of it.
 *
 * Extracted because it was about to exist twice, once for "where does this file reach" and once
 * for "which screens run this list", and the two copies would have had to agree about three
 * separate traps:
 *
 *   THE SUB-LIST. A screen running "Principal" is showing "Promoções" if Principal rotates
 *   through it. Matching only devices.playlist_id reports that screen as not showing the content,
 *   and an under-count is indistinguishable from content that is simply used less.
 *
 *   THE ZONE. Multi-zone layouts assign a whole list per zone, so a screen can be showing a list
 *   that is not its main one at all.
 *
 *   THE PHANTOM ZONE. device_zone_playlists rows OUTLIVE the layout that created them. A screen
 *   switched back to fullscreen keeps them, pointing at zones that are nowhere on it — one panel
 *   in production has layout_id NULL and two such rows. Counting those is an over-count, and
 *   "reaches 12 screens" is the number a customer is quoted. The zone must still belong to the
 *   layout the screen is actually running.
 */

const { db } = require('../db/database');

/*
 * The lists that REACH a set of lists: the ones given, plus any list that rotates through one of
 * them as a sub-list.
 *
 * One step, not a walk. lib/sublists.js caps nesting at one level, and writing this recursively
 * would quietly paper over a nesting bug instead of the constraint holding.
 */
function withParents(workspaceId, playlistIds) {
  if (!playlistIds.length) return [];
  const marks = playlistIds.map(() => '?').join(',');
  const parents = db.prepare(`
    SELECT DISTINCT p.id, p.name, sub.name AS via_name
    FROM playlist_items pi
    JOIN playlists p   ON p.id = pi.playlist_id
    JOIN playlists sub ON sub.id = pi.sub_playlist_id
    WHERE pi.sub_playlist_id IN (${marks}) AND p.workspace_id = ?
  `).all(...playlistIds, workspaceId);
  return parents.filter((p) => !playlistIds.includes(p.id));
}

/*
 * The screens running any of these lists, each named once however many ways it runs them.
 *
 * A screen showing the same content in two zones is ONE screen; reporting two would overstate the
 * reach of everything in a multi-zone layout.
 */
function screensRunning(workspaceId, playlistIds) {
  const ids = [...new Set(playlistIds)].filter(Boolean);
  if (!workspaceId || !ids.length) return [];
  const marks = ids.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, 'playlist' AS how, p.name AS through
    FROM devices d
    JOIN playlists p ON p.id = d.playlist_id
    WHERE d.workspace_id = ? AND d.playlist_id IN (${marks})

    UNION

    SELECT d.id, d.name, d.status, 'zone' AS how, p.name AS through
    FROM device_zone_playlists z
    JOIN devices d ON d.id = z.device_id
    -- The phantom-zone guard. See the note at the top of this file.
    JOIN layout_zones lz ON lz.id = z.zone_id AND lz.layout_id = d.layout_id
    JOIN playlists p ON p.id = z.playlist_id
    WHERE d.workspace_id = ? AND z.playlist_id IN (${marks})
  `).all(workspaceId, ...ids, workspaceId, ...ids);

  const byScreen = new Map();
  for (const r of rows) {
    const e = byScreen.get(r.id);
    if (!e) byScreen.set(r.id, { id: r.id, name: r.name, status: r.status, hows: [r.how], through: [r.through] });
    else { e.hows.push(r.how); e.through.push(r.through); }
  }

  /*
   * Sorted here, not in SQL: a compound UNION cannot take ORDER BY name COLLATE NOCASE — the term
   * has to be a plain result column — and localeCompare sorts "Ág" next to "Ag" the way a
   * Portuguese reader expects, which NOCASE does not.
   */
  return [...byScreen.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

module.exports = { screensRunning, withParents };
