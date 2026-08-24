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

/*
 * How many columns each unit can carry on a landscape A4, measured against its own LABELS.
 *
 * The page gives 762pt; the row label takes 150 and the totals column 42, leaving 570. The limits
 * below come from what has to be drawn in a cell, not from what looks tidy:
 *
 *   "10 ago"        22.9pt  ->  16 day columns (35.6pt each)
 *   "29 jun–5 jul"  38.4pt  ->  13 week columns (43.8pt each)
 *   "00h"           12.5pt  ->  24 hour columns fit easily
 *
 * The first version allowed 30 day columns at 19pt and the labels wrapped: "10 ago" printed as
 * "10" above "ago", and a four-digit figure as two two-digit ones. The values were right and the
 * page was unreadable, which is the same as being wrong.
 */
const MAX_DAY_COLUMNS = 16;
const MAX_WEEK_COLUMNS = 13;

const p2 = (n) => (n < 10 ? `0${n}` : String(n));
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/* '2026-08-17' -> '17 ago', which a reader takes in without decoding it. */
function dayLabel(key) {
  const [, m, d] = key.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/* Whole days between two 'YYYY-MM-DD' — calendar arithmetic, never seconds. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/*
 * The columns for a period, in the SCREEN's own calendar.
 *
 * A LADDER, not a fixed unit: hours for a day or two, days for a fortnight, weeks for a season,
 * months beyond. The alternative — always days — is what produced a thirty-column grid where
 * twenty-six columns were empty and the four with data had their numbers broken in half.
 *
 * Day columns are walked as strings rather than by adding 86400 seconds, which drifts by an hour
 * across a DST change and yields a duplicate or a missing column.
 */
function columnsFor(start, end) {
  if (!start || !end) return { kind: 'none', keys: [], labels: [] };

  const span = daysBetween(start, end) + 1;

  if (span <= 2) {
    /*
     * Hours. Two days share the same 24 columns on purpose: "yesterday and today" is a comparison
     * of the same hours, and forty-eight columns would be neither.
     */
    return {
      kind: 'hour',
      keys: Array.from({ length: 24 }, (_, h) => p2(h)),
      labels: Array.from({ length: 24 }, (_, h) => `${p2(h)}h`),
    };
  }

  if (span <= MAX_DAY_COLUMNS) {
    const keys = [];
    for (let d = start; d <= end; d = shiftDays(d, 1)) keys.push(d);
    return { kind: 'day', keys, labels: keys.map(dayLabel) };
  }

  if (span <= MAX_WEEK_COLUMNS * 7) {
    /*
     * Weeks, anchored on the FIRST day of the period rather than on Monday. A report for "the last
     * 30 days" is about those 30 days, and a first column holding two days because the period
     * happened to start on a Saturday is an artefact of the calendar, not of the screens.
     */
    const keys = [];
    const labels = [];
    for (let d = start; d <= end; d = shiftDays(d, 7)) {
      keys.push(d);
      const last = (shiftDays(d, 6) <= end) ? shiftDays(d, 6) : end;
      // "1–7 jun", not "1 jun–7": the month belongs to the range, not to its first day.
      const [, m1] = d.split('-');
      const [, m2] = last.split('-');
      const n = (k) => String(Number(k.split('-')[2]));
      labels.push(m1 === m2
        ? `${n(d)}–${dayLabel(last)}`
        : `${dayLabel(d)}–${dayLabel(last)}`);
    }
    return { kind: 'week', keys, labels, step: 7, from: start };
  }

  // Months. Past a year the grid is a shape, not a table of figures, and that is what it is for.
  const keys = [];
  const labels = [];
  let cur = `${start.slice(0, 7)}-01`;
  while (cur <= end) {
    keys.push(cur.slice(0, 7));
    labels.push(`${MONTHS[Number(cur.slice(5, 7)) - 1]}/${cur.slice(2, 4)}`);
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y + 1}-01-01` : `${y}-${p2(m + 1)}-01`;
  }
  return { kind: 'month', keys, labels };
}

/*
 * Which column an instant falls in, in tz.
 *
 * A week column is named by the day it starts on, so a play has to be walked back to that day —
 * the alternative, keying on an ISO week number, would put the same period under a different
 * column depending on which weekday the report happened to start.
 */
function columnOf(epochSec, tz, cols) {
  const kind = typeof cols === 'string' ? cols : cols.kind;
  if (kind === 'hour') return hhmm(epochSec, tz).slice(0, 2);

  const day = dayKey(epochSec, tz);
  if (kind === 'day') return day;
  if (kind === 'month') return day.slice(0, 7);
  if (kind === 'week') {
    const offset = daysBetween(cols.from, day);
    if (offset < 0) return null;
    return shiftDays(cols.from, Math.floor(offset / 7) * 7);
  }
  return null;
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
    return { kind: 'none', reason: 'no_period', columns: [], column_keys: [], rows: [], col_totals: [], total: 0, peak: 0 };
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

module.exports = { buildMatrix, columnsFor, columnOf, MAX_DAY_COLUMNS, MAX_WEEK_COLUMNS, dayLabel, daysBetween };
