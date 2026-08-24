'use strict';

/*
 * When this customer's play history actually begins.
 *
 * THE REASON THIS EXISTS. A report for the last thirty days drew a grid with twenty-six empty
 * columns, and an empty column looks exactly like a screen that was switched off. It was not: the
 * recording of plays only started on the day the feature shipped, and everything before that is
 * absent because it was never written, not because nothing played.
 *
 * A document handed to an advertiser that implies twenty-six dark days is not a neutral omission —
 * it is an accusation about a service that was in fact delivered. So the report says where the
 * record starts and lets the reader draw the right conclusion.
 */

const { db } = require('../db/database');
const { dayKey } = require('./zoned-day');

const _first = db.prepare(`
  SELECT MIN(pl.started_at) AS first_at
  FROM play_logs pl
  JOIN devices d ON d.id = pl.device_id
  WHERE d.workspace_id = ?
`);

/*
 * The first day this workspace has any record of, in tz, or null when it has none at all.
 *
 * Read from play_logs rather than from a stored "we started here" marker: pruning moves the floor
 * every day, and a marker written once would keep claiming coverage of a period that has since
 * been deleted.
 */
function historyFrom(workspaceId, tz) {
  if (!workspaceId) return null;
  const row = _first.get(workspaceId);
  return row && row.first_at ? dayKey(row.first_at, tz || 'UTC') : null;
}

module.exports = { historyFrom };
