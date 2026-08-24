'use strict';

/*
 * The three reports the operator actually asks for, and the one rule they all obey.
 *
 * EVERY QUERY IS SCOPED BY WORKSPACE, without exception and without a platform-admin bypass. That
 * is not defensive habit: the uptime report in this same file once had no scope clause at all, and
 * any authenticated user could read telemetry for every device on the platform. An aggregate is
 * the easiest place for that to happen again, because a leak looks like a slightly larger number
 * rather than like somebody else's data.
 *
 * Reports come in two kinds and they fail differently:
 *
 *   PLAY-BASED    counted from play_logs, which is pruned at 90 days. An empty result can mean
 *                 "nothing played" OR "it played four months ago", so the window is always part
 *                 of the answer and the caller is told what it is.
 *
 *   STRUCTURAL    "in how many playlists is this file", "how many screens run this list". These
 *                 read the current shape of things, so they are meaningful the day the product is
 *                 installed and they do not decay. Most of what was asked for is this kind.
 */

const { db } = require('../db/database');

/*
 * play_logs carries no workspace of its own — a play belongs to whichever workspace owns the
 * DEVICE that showed it. So every report below joins through devices (or content / playlists /
 * device_groups, which do carry workspace_id) and filters there. Nothing filters play_logs
 * directly, because there is nothing on that table to filter by.
 */
function windowOf({ start, end }) {
  const startEpoch = start
    ? Math.floor(new Date(start).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end
    ? Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  return { startEpoch, endEpoch };
}

// ---- screens ------------------------------------------------------------------------------------

function screensReport(workspaceId, range) {
  const { startEpoch, endEpoch } = windowOf(range);

  /*
   * LEFT JOIN, so a screen that played nothing still appears with a zero. Dropping it would make
   * the exact case the operator is looking for — a panel that has shown nothing all week —
   * invisible in the report about it.
   */
  return db.prepare(`
    SELECT d.id,
           d.name,
           d.status,
           p.name  AS playlist_name,
           -- A screen can belong to several groups, so this is a list, not a value. Reading one
           -- would silently pick whichever the join happened to return first.
           GROUP_CONCAT(DISTINCT g.name) AS group_names,
           COUNT(DISTINCT pl.id)               AS plays,
           -- SUM over a multiplied join would count a play once per group the screen is in.
           COALESCE((SELECT SUM(p2.duration_sec) FROM play_logs p2
                      WHERE p2.device_id = d.id AND p2.started_at BETWEEN ? AND ?), 0) AS seconds,
           COUNT(DISTINCT pl.content_id)       AS distinct_files,
           MAX(pl.started_at)                  AS last_play
      FROM devices d
      LEFT JOIN playlists p     ON p.id = d.playlist_id
      LEFT JOIN device_group_members gm ON gm.device_id = d.id
      LEFT JOIN device_groups g          ON g.id = gm.group_id AND g.workspace_id = d.workspace_id
      LEFT JOIN play_logs pl    ON pl.device_id = d.id AND pl.started_at BETWEEN ? AND ?
     WHERE d.workspace_id = ?
     GROUP BY d.id
     ORDER BY plays DESC, d.name COLLATE NOCASE`)
    .all(startEpoch, endEpoch, startEpoch, endEpoch, workspaceId || null);
}

// ---- files --------------------------------------------------------------------------------------

function filesReport(workspaceId, range) {
  const { startEpoch, endEpoch } = windowOf(range);

  /*
   * The two structural columns are the ones that were asked for by name: how many playlists hold
   * this file, and how many screens it therefore reaches. The second is a DISTINCT count across
   * the join — a file in three lists that all run on the same panel reaches one screen, not three,
   * and reporting three would overstate every file in a small network.
   */
  return db.prepare(`
    SELECT c.id,
           c.filename,
           c.mime_type,
           COALESCE(SUM(CASE WHEN pl.started_at BETWEEN ? AND ? THEN 1 ELSE 0 END), 0)               AS plays,
           COALESCE(SUM(CASE WHEN pl.started_at BETWEEN ? AND ? THEN pl.duration_sec ELSE 0 END), 0) AS seconds,
           MAX(CASE WHEN pl.started_at BETWEEN ? AND ? THEN pl.started_at END)                       AS last_play,
           (SELECT COUNT(DISTINCT pi.playlist_id)
              FROM playlist_items pi
              JOIN playlists pp ON pp.id = pi.playlist_id
             WHERE pi.content_id = c.id AND pp.workspace_id = c.workspace_id)                        AS in_playlists,
           (SELECT COUNT(DISTINCT d.id)
              FROM playlist_items pi
              JOIN devices d ON d.playlist_id = pi.playlist_id
             WHERE pi.content_id = c.id AND d.workspace_id = c.workspace_id)                         AS on_screens
      FROM content c
      LEFT JOIN play_logs pl ON pl.content_id = c.id
     WHERE c.workspace_id = ?
     GROUP BY c.id
     ORDER BY plays DESC, c.filename COLLATE NOCASE`)
    .all(startEpoch, endEpoch, startEpoch, endEpoch, startEpoch, endEpoch, workspaceId || null);
}

// ---- playlists ------------------------------------------------------------------------------------

function playlistsReport(workspaceId, range) {
  const { startEpoch, endEpoch } = windowOf(range);

  /*
   * Plays are attributed through the SCREENS running the list, because play_logs records what a
   * device showed, not which list it came from. That is an approximation and it is the honest one
   * available: a screen running list A reports A's plays. A screen with no list contributes to no
   * list's count.
   */
  return db.prepare(`
    SELECT p.id,
           p.name,
           p.status,
           (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)                  AS items,
           (SELECT COALESCE(SUM(pi.duration_sec), 0) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS duration_sec,
           (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id AND d.workspace_id = p.workspace_id) AS on_screens,
           COALESCE((SELECT COUNT(*)
                       FROM play_logs pl
                       JOIN devices d ON d.id = pl.device_id
                      WHERE d.playlist_id = p.id
                        AND d.workspace_id = p.workspace_id
                        AND pl.started_at BETWEEN ? AND ?), 0)                                    AS plays,
           COALESCE((SELECT SUM(pl.duration_sec)
                       FROM play_logs pl
                       JOIN devices d ON d.id = pl.device_id
                      WHERE d.playlist_id = p.id
                        AND d.workspace_id = p.workspace_id
                        AND pl.started_at BETWEEN ? AND ?), 0)                                    AS seconds
      FROM playlists p
     WHERE p.workspace_id = ?
     ORDER BY on_screens DESC, p.name COLLATE NOCASE`)
    .all(startEpoch, endEpoch, startEpoch, endEpoch, workspaceId || null);
}

// ---- groups ---------------------------------------------------------------------------------------

function groupsReport(workspaceId, range) {
  const { startEpoch, endEpoch } = windowOf(range);
  return db.prepare(`
    SELECT g.id,
           g.name,
           (SELECT COUNT(*)
              FROM device_group_members gm
              JOIN devices d ON d.id = gm.device_id
             WHERE gm.group_id = g.id AND d.workspace_id = g.workspace_id)                    AS screens,
           (SELECT COUNT(*)
              FROM device_group_members gm
              JOIN devices d ON d.id = gm.device_id
             WHERE gm.group_id = g.id AND d.workspace_id = g.workspace_id
               AND d.status = 'online')                                                       AS online,
           COALESCE((SELECT COUNT(*)
                       FROM play_logs pl
                       JOIN device_group_members gm ON gm.device_id = pl.device_id
                       JOIN devices d ON d.id = pl.device_id
                      WHERE gm.group_id = g.id
                        AND d.workspace_id = g.workspace_id
                        AND pl.started_at BETWEEN ? AND ?), 0)                                AS plays
      FROM device_groups g
     WHERE g.workspace_id = ?
     ORDER BY screens DESC, g.name COLLATE NOCASE`).all(startEpoch, endEpoch, workspaceId || null);
}

// ---- CSV ---------------------------------------------------------------------------------------------

/*
 * ⚠️ FORMULA INJECTION. A filename beginning =, +, - or @ is executed as a formula when the CSV is
 * opened in Excel or Sheets, and these reports are full of operator-supplied names. Prefixing a
 * single quote is the standard defence and is invisible in the cell.
 *
 * The BOM is not decoration either: without it Excel on a Portuguese Windows reads the file as
 * Latin-1 and every accented filename arrives mangled.
 */
/*
 * toCsv and csvCell lived here and are gone with the exports they served. The spreadsheet-formula
 * guard they carried (a cell starting with = + - or @ is executed by Excel) is not a rule that
 * stopped mattering — it is a rule with nothing left to apply to. Anything that writes a CSV from
 * this data again has to bring it back.
 */
module.exports = { screensReport, filesReport, playlistsReport, groupsReport, windowOf };
