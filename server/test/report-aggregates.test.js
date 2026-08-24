'use strict';

/*
 * The aggregated reports — the grid, and the per-subject summaries built on it.
 *
 * These exist because the FIRST version of this feature put the play-by-play list on a page: 739
 * rows for one screen for one day, above the settings anybody had opened the page for. A screen
 * looping a 15-second clip makes 5,760 a day. The grid is the answer to that, and what has to hold
 * about it is that it stays readable AND stays honest — a grid whose own totals do not add up is
 * worse than no grid at all.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { buildMatrix, columnsFor, columnOf } = require('../lib/report-matrix');
const { deviceSummary } = require('../lib/device-summary');
const { playlistSummary } = require('../lib/playlist-summary');

const WS = 'ws-a';
const OTHER = 'ws-b';

before(() => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','A')").run(WS);
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','B')").run(OTHER);

  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p1','u',?,'Montanha Geral')").run(WS);
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c1','u',?,'promo.mp4','a','video/mp4')").run(WS);
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,name,widget_type) VALUES ('w-clock','u',?,'Relógio','clock')").run(WS);
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,name,widget_type) VALUES ('w-news','u',?,'Notícias','news')").run(WS);

  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone,status) VALUES ('d1','u',?,'Pro Eletronic','p1','America/Sao_Paulo','online')").run(WS);
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name) VALUES ('alien','u',?,'De outro tenant')").run(OTHER);

  db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('p1','c1')").run();

  /*
   * A day on the screen: the file four times, the clock twice, the news once — the shape that made
   * "Arquivos distintos: 1" look like a fault when the screen had made 739 plays.
   */
  const at = (h, m) => Math.floor(Date.UTC(2026, 8, 10, h + 3, m, 0) / 1000); // UTC-3
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,widget_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
                          VALUES ('d1',?,?,'p1','Montanha Geral',?,?,15)`);
  ins.run('c1', null, 'promo.mp4', at(8, 0));
  ins.run('c1', null, 'promo.mp4', at(8, 30));
  ins.run('c1', null, 'promo.mp4', at(11, 0));
  ins.run('c1', null, 'promo.mp4', at(11, 30));
  ins.run(null, 'w-clock', 'Relógio', at(11, 5));
  ins.run(null, 'w-clock', 'Relógio', at(20, 0));
  ins.run(null, 'w-news', 'Notícias', at(11, 10));
});

/* ---------------------------------------------------------------- the grid */

test('one day is told in hours; a range is told in days', () => {
  assert.equal(columnsFor('2026-09-10', '2026-09-10').kind, 'hour');
  assert.equal(columnsFor('2026-09-10', '2026-09-10').keys.length, 24);

  const week = columnsFor('2026-09-01', '2026-09-07');
  assert.equal(week.kind, 'day');
  assert.equal(week.keys.length, 7);
  // "1 set", not "01/09": a reader takes the first in without decoding it, and the year is already
  // in the period printed above the grid.
  assert.deepEqual(week.labels.slice(0, 2), ['1 set', '2 set']);
});

test('a long period changes UNIT rather than being refused', () => {
  /*
   * The first version drew days until it ran out of room and then gave up, printing a note instead
   * of a grid. Giving up was never necessary: a year has twelve months, and twelve columns fit
   * comfortably. What has to be refused is a request with no period at all, which is the only case
   * left where there is genuinely nothing to draw.
   */
  const year = columnsFor('2026-01-01', '2026-12-31');
  assert.equal(year.kind, 'month');
  assert.equal(year.keys.length, 12);

  const none = columnsFor(null, null);
  assert.equal(none.kind, 'none');
  const m = buildMatrix({ entries: [{ key: 'a', name: 'A', col: '2026-01', plays: 5 }], cols: none });
  assert.equal(m.kind, 'none');
  assert.equal(m.reason, 'no_period');
});

test('row totals, column totals and the grand total all come from the same cells', () => {
  // Two queries for the summary and the grid is how a total ends up disagreeing with the row above
  // it — each number plausible on its own, and nobody notices until they add them up.
  const cols = columnsFor('2026-09-10', '2026-09-10');
  const m = buildMatrix({
    cols,
    entries: [
      { key: 'a', name: 'A', col: '08', plays: 2 },
      { key: 'a', name: 'A', col: '11', plays: 3 },
      { key: 'b', name: 'B', col: '11', plays: 1 },
    ],
  });

  assert.equal(m.rows.reduce((n, r) => n + r.total, 0), m.total);
  assert.equal(m.col_totals.reduce((a, b) => a + b, 0), m.total);
  assert.equal(m.total, 6);
  assert.equal(m.peak, 3, 'the busiest cell, for the shading that finds it without reading every number');
});

test('a long tail is FOLDED into one row, never dropped', () => {
  /*
   * Truncating it would stop the column totals adding up to the grand total. The reader would have
   * no way to tell a grid that is missing rows from one that is complete.
   */
  const cols = columnsFor('2026-09-10', '2026-09-10');
  const entries = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, name: `N${i}`, col: '10', plays: 30 - i }));
  const m = buildMatrix({ entries, cols, rowsCap: 5 });

  assert.equal(m.rows.length, 5);
  const others = m.rows.at(-1);
  assert.equal(others.key, '__others__');
  assert.equal(others.name, null, 'the page names it — this file does not speak Portuguese');
  assert.equal(others.count, 26);
  assert.equal(m.rows.reduce((n, r) => n + r.total, 0), m.total, 'and the totals still add up');
});

test('a play outside the requested days is dropped, not folded into the nearest column', () => {
  // The queries fetch a day of slack either side, because a screen fourteen hours away has plays
  // inside the requested LOCAL day that fall outside the UTC one. Those extras belong to a day
  // nobody asked about.
  // A span of two days is told in HOURS, so this needs a window wide enough to be told in days.
  const cols = columnsFor('2026-09-05', '2026-09-14');
  const m = buildMatrix({
    cols,
    entries: [
      { key: 'a', name: 'A', col: '2026-09-10', plays: 1 },
      { key: 'a', name: 'A', col: '2026-09-04', plays: 99 },
    ],
  });
  assert.equal(m.total, 1);
});

test('the column an instant falls in is read in the zone it is given', () => {
  const noon = Math.floor(Date.UTC(2026, 8, 10, 15, 0, 0) / 1000);
  assert.equal(columnOf(noon, 'America/Sao_Paulo', 'hour'), '12');
  assert.equal(columnOf(noon, 'UTC', 'hour'), '15');
  assert.equal(columnOf(noon, 'America/Sao_Paulo', 'day'), '2026-09-10');
});

/* ---------------------------------------------------------------- one screen */

test('a screen summary counts widgets as themselves', () => {
  /*
   * "Arquivos distintos: 1" on a screen with 739 plays read as a fault. It was not — the rest were
   * the clock, the news, the weather and the football, which carry a widget_id and no content_id.
   */
  const d = deviceSummary({ workspaceId: WS, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  assert.equal(d.totals.plays, 7);
  assert.equal(d.totals.distinct_files, 1);
  assert.equal(d.totals.distinct_widgets, 2);
  assert.equal(d.totals.distinct_lists, 1);

  const kinds = Object.fromEntries(d.by_kind.map((k) => [k.kind, k.plays]));
  assert.equal(kinds.file, 4);
  assert.equal(kinds.clock, 2);
  assert.equal(kinds.news, 1);
});

test('the percentages are computed once, where the total is', () => {
  // Two places dividing by the same total is how a set of percentages ends up summing to 99.
  const d = deviceSummary({ workspaceId: WS, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const sum = d.by_kind.reduce((n, k) => n + k.plays, 0);
  assert.equal(sum, d.totals.plays);
  assert.ok(d.by_kind.every((k) => k.pct > 0));
});

test('the grid on a screen summary matches its own tiles', () => {
  const d = deviceSummary({ workspaceId: WS, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  assert.equal(d.matrix.kind, 'hour');
  assert.equal(d.matrix.total, d.totals.plays);

  const at11 = d.matrix.column_keys.indexOf('11');
  assert.equal(d.matrix.col_totals[at11], 4, 'two files, the clock and the news, all in the 11h hour');
  assert.equal(d.matrix.col_totals[d.matrix.column_keys.indexOf('08')], 2);
});

test('a screen summary is told in the SCREEN\'s clock', () => {
  // The plays were written as UTC-3 wall times; a summary on the server's clock would move every
  // one of them three hours and still look entirely ordinary.
  const d = deviceSummary({ workspaceId: WS, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  assert.equal(d.timezone, 'America/Sao_Paulo');
  assert.equal(d.timezone_assumed, false);
  assert.equal(d.matrix.col_totals[d.matrix.column_keys.indexOf('20')], 1, '20h in São Paulo, 23h UTC');
});

test('another workspace cannot read a screen summary', () => {
  assert.equal(deviceSummary({ workspaceId: OTHER, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' }), null);
  assert.equal(deviceSummary({ workspaceId: WS, deviceId: 'alien', start: '2026-09-10', end: '2026-09-10' }), null);
  assert.equal(deviceSummary({ workspaceId: null, deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' }), null);
});

/* ---------------------------------------------------------------- one list */

test('a list summary says both where it runs and what it broadcast', () => {
  /*
   * The second half of that only became answerable when play_logs started recording playlist_id.
   * Before it, a play knew its screen and its file and nothing about where it came from.
   */
  const l = playlistSummary({ workspaceId: WS, playlistId: 'p1', start: '2026-09-10', end: '2026-09-10' });
  assert.equal(l.reach.screen_count, 1, 'structural: which screens run it, true today');
  assert.equal(l.reach.item_count, 1, 'and what it holds');

  assert.equal(l.totals.plays, 7, 'play-based: what it actually put on air in the period');
  assert.equal(l.totals.distinct_screens, 1);
  assert.equal(l.matrix.total, l.totals.plays);
});

test('a list nothing runs still reports what it holds', () => {
  // Structural answers do not wait for history, which is the whole reason they are separated from
  // the ones that do.
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-nova','u',?,'Recém-criada')").run(WS);
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('p-nova','c1')").run();

  const l = playlistSummary({ workspaceId: WS, playlistId: 'p-nova', start: '2026-09-10', end: '2026-09-10' });
  assert.equal(l.reach.screen_count, 0);
  assert.equal(l.reach.item_count, 1);
  assert.equal(l.totals.plays, 0);
  assert.equal(l.timezone_anchor, 'UTC', 'no screen runs it, so there is no screen calendar to use');
});

test('another workspace cannot read a list summary', () => {
  assert.equal(playlistSummary({ workspaceId: OTHER, playlistId: 'p1', start: '2026-09-10', end: '2026-09-10' }), null);
  assert.equal(playlistSummary({ workspaceId: null, playlistId: 'p1', start: '2026-09-10', end: '2026-09-10' }), null);
});

test('the column unit is chosen by what its LABELS need, not by taste', () => {
  /*
   * The limits are measured, not tidy round numbers. On a landscape A4 the columns share 570pt
   * after the row label and the totals column:
   *
   *   "10 ago"        22.9pt  ->  16 day columns at 35.6pt
   *   "29 jun–5 jul"  38.4pt  ->  13 week columns at 43.8pt
   *   "00h"           12.5pt  ->  24 hour columns at 23.7pt
   *
   * A thirty-column day grid was 19pt a cell and every label printed as two stacked fragments.
   */
  assert.equal(columnsFor('2026-08-24', '2026-08-24').kind, 'hour');
  assert.equal(columnsFor('2026-08-23', '2026-08-24').kind, 'hour', 'two days share the same hours');
  assert.equal(columnsFor('2026-08-10', '2026-08-24').kind, 'day');
  assert.equal(columnsFor('2026-08-09', '2026-08-24').keys.length, 16, 'the last day grid that fits');
  assert.equal(columnsFor('2026-08-08', '2026-08-24').kind, 'week', 'one more day and it is weeks');
  assert.equal(columnsFor('2026-06-01', '2026-08-24').kind, 'week');
  assert.equal(columnsFor('2025-01-01', '2026-08-24').kind, 'month');

  for (const [a, b] of [['2026-08-10', '2026-08-24'], ['2026-06-01', '2026-08-24'], ['2025-01-01', '2026-08-24']]) {
    assert.ok(columnsFor(a, b).keys.length <= 24, `${a}..${b} must stay readable`);
  }
});

test('a week column is named for the range it covers, in one month or two', () => {
  // "1 jun–7" reads as a date and a stray number. The month belongs to the range.
  const q = columnsFor('2026-06-01', '2026-08-24');
  assert.equal(q.labels[0], '1–7 jun');
  const crossing = columnsFor('2026-06-28', '2026-08-24');
  assert.equal(crossing.labels[0], '28 jun–4 jul', 'and both months when it straddles them');
});

test('weeks are anchored on the period, not on Monday', () => {
  /*
   * A report for "the last 30 days" is about those 30 days. A first column holding two of them
   * because the period happened to begin on a Saturday is an artefact of the calendar, not
   * something the screens did.
   */
  const cols = columnsFor('2026-07-26', '2026-08-24');
  assert.equal(cols.keys[0], '2026-07-26');
  assert.equal(cols.keys[1], '2026-08-02', 'seven days later, whatever weekday that is');

  const at = Math.floor(Date.UTC(2026, 7, 3, 15, 0, 0) / 1000); // 03/08, inside the second week
  assert.equal(columnOf(at, 'America/Sao_Paulo', cols), '2026-08-02');
});

test('a play before the first column belongs to no column at all', () => {
  // The queries fetch a day of slack either side; a play that lands there is outside the period
  // and must not be folded into its first week.
  const cols = columnsFor('2026-07-26', '2026-08-24');
  const early = Math.floor(Date.UTC(2026, 6, 25, 15, 0, 0) / 1000);
  assert.equal(columnOf(early, 'America/Sao_Paulo', cols), null);
});
