'use strict';

/*
 * The compact shape of "when did this play" — a grid, not a list.
 *
 * THE LESSON THIS EXISTS FOR: the competitor's per-screen PDF is fifteen pages for a single day,
 * because it prints one line per play. The only two useful pages are the last ones, where it
 * finally aggregates. Their per-FILE report does the opposite — screens down the side, hours
 * across the top — and says the same thing in one page no matter the volume.
 *
 * So: a grid for reading, and the row-by-row detail stays in the CSV, which is where somebody who
 * genuinely wants 5,760 lines can get them.
 *
 * Columns are hours when the period is one day, and days when it is longer. Past a point neither
 * works — sixty columns is not a table anyone reads — and the caller is told the grid was dropped
 * rather than being handed an unreadable one.
 */

const { dayKey, hhmm, shiftDays } = require('./zoned-day');

// Beyond this the columns are too narrow to read on a page or a phone. The ranking below the grid
// still answers "what played most"; only the shape of the days is lost.
const MAX_DAY_COLUMNS = 45;

/*
 * The columns for a period, in the SCREEN's own calendar.
 *
 * One day of a screen is not one day of UTC — see lib/zoned-day.js — so the day columns are built
 * by walking the requested dates as strings rather than by adding 86400 seconds, which drifts by
 * an hour across a DST change and produces a duplicate or a missing column.
 */
function columnsFor(start, end) {
  if (start === end) {
    return {
      kind: 'hour',
      keys: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
      labels: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}h`),
    };
  }

  const keys = [];
  for (let d = start; d <= end; d = shiftDays(d, 1)) {
    keys.push(d);
    if (keys.length > MAX_DAY_COLUMNS) return { kind: 'none', keys: [], labels: [] };
  }
  // Labelled dd/mm: the year is already in the period stated above the grid, and repeating it in
  // every column is what makes a grid stop fitting.
  return { kind: 'day', keys, labels: keys.map((k) => k.slice(8) + '/' + k.slice(5, 7)) };
}

/* Which column an instant falls in, in tz. */
function columnOf(epochSec, tz, kind) {
  if (kind === 'hour') return hhmm(epochSec, tz).slice(0, 2);
  return dayKey(epochSec, tz);
}

/*
 * Rows × columns, with the totals the eye actually uses.
 *
 * Entries arrive with their column ALREADY DECIDED, rather than with an instant and one timezone
 * for the whole grid. A file playing on a screen in São Paulo and one in Manaus plays at "11h" on
 * both, an hour apart in real time, and both belong in the 11h column — the hour an advertiser is
 * asking about is the hour on the screen in front of the customer. One timezone for the grid would
 * shift one of those screens into the wrong column, and every number would still look ordinary.
 *
 * Row and column totals are computed HERE, from the same cells the grid draws, so a total can
 * never disagree with the row above it — which is what happens when the summary and the grid come
 * from two queries.
 */
function buildMatrix({ entries, cols, rowsCap = 20 }) {
  if (!cols || cols.kind === 'none') {
    return { kind: 'none', reason: 'too_many_days', columns: [], column_keys: [], rows: [], col_totals: [], total: 0, peak: 0 };
  }

  const colIndex = new Map(cols.keys.map((k, i) => [k, i]));
  const byRow = new Map();

  for (const e of entries) {
    const ci = colIndex.get(e.col);
    // A play outside the requested days can arrive from the slack the queries fetch either side of
    // the window; it belongs to a day nobody asked about, and is dropped rather than folded into
    // the nearest column.
    if (ci === undefined) continue;

    let row = byRow.get(e.key);
    if (!row) {
      row = { key: e.key, name: e.name, kind: e.kind, cells: new Array(cols.keys.length).fill(0), total: 0 };
      byRow.set(e.key, row);
    }
    row.cells[ci] += e.plays;
    row.total += e.plays;
  }

  const all = [...byRow.values()]
    .sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name), 'pt-BR'));

  /*
   * A long tail is FOLDED into one row, never truncated. Dropping it would stop the column totals
   * adding up to the grand total, and a grid whose own totals do not add up is worse than no grid.
   */
  let rows = all;
  if (all.length > rowsCap) {
    const head = all.slice(0, rowsCap - 1);
    const tail = all.slice(rowsCap - 1);
    const others = {
      key: '__others__',
      name: null, // the page names it; this file does not speak Portuguese
      kind: 'others',
      count: tail.length,
      cells: new Array(cols.keys.length).fill(0),
      total: 0,
    };
    for (const r of tail) {
      r.cells.forEach((v, i) => { others.cells[i] += v; });
      others.total += r.total;
    }
    rows = [...head, others];
  }

  const colTotals = new Array(cols.keys.length).fill(0);
  for (const r of rows) r.cells.forEach((v, i) => { colTotals[i] += v; });
  const total = colTotals.reduce((a, b) => a + b, 0);

  /*
   * The busiest cell, for the highlight the competitor's report uses to good effect — it is how a
   * reader finds the hour that matters without reading every number. Zero when nothing played, so
   * the page does not shade an empty grid.
   */
  let peak = 0;
  for (const r of rows) for (const v of r.cells) if (v > peak) peak = v;

  return { kind: cols.kind, columns: cols.labels, column_keys: cols.keys, rows, col_totals: colTotals, total, peak };
}

module.exports = { buildMatrix, columnsFor, columnOf, MAX_DAY_COLUMNS };
