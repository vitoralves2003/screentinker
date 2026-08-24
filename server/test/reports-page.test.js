'use strict';

/*
 * The reports page, checked where a server-side suite can reach: its wiring and its columns.
 *
 * The behaviour is covered by reports-by-type.test.js. What this catches is the page and the API
 * drifting apart — a column added to one and not the other, a tab with no endpoint, an export that
 * cannot authenticate — none of which fails anything, they just produce a blank cell or a file
 * nobody can open.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const view = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'reports.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'reports.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'en.js'), 'utf8');

const TYPES = ['screens', 'files', 'playlists', 'groups'];

test('the page is reachable from the menu again', () => {
  // It existed and was hidden, which is a page nobody can find rather than a page that is missing.
  const li = html.slice(html.indexOf('data-view="reports"') - 200, html.indexOf('data-view="reports"'));
  assert.ok(!/style="display:none"[^<]*$/.test(li), 'the reports nav item must not be hidden');
});

test('every tab on the page has an endpoint behind it', () => {
  for (const type of TYPES) {
    assert.ok(view.includes(`'${type}'`), `${type} must be a tab`);
    assert.match(routes, new RegExp(`${type}:\\s*${type}Report`), `${type} must have a builder`);
  }
});

test('every tab and every column has an English string', () => {
  /*
   * A missing key renders as the key itself — "report.col.airtime" in a table header. It is the
   * kind of thing that ships because the developer's own locale happened to have it.
   */
  const defined = new Set([...en.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]));
  for (const type of TYPES) assert.ok(defined.has(`report.tab.${type}`), `report.tab.${type}`);
  for (const m of view.matchAll(/label: '(report\.col\.[\w.]+)'/g)) {
    assert.ok(defined.has(m[1]), `${m[1]} is used as a column header but is not defined`);
  }
});

test('the export authenticates, rather than being a plain link', () => {
  /*
   * The endpoint needs an Authorization header and an <a href> cannot send one — the browser would
   * download the 401 body as a .csv, which reaches the operator as a corrupt export rather than
   * as "you are not allowed".
   */
  // The handler is a named function now, not an inline listener, so the window is the function
  // itself rather than whatever follows the addEventListener call.
  const exportBlock = view.slice(view.indexOf('async function exportCsv'));
  assert.match(exportBlock, /Authorization: `Bearer/);
  assert.match(exportBlock, /createObjectURL/);
});

test('the page says which numbers decay and which do not', () => {
  /*
   * Half these columns come from a log pruned at 90 days and half describe the current setup. A
   * zero means different things in each, and a report that cannot distinguish "no" from "I do not
   * know" is one people quietly stop trusting.
   */
  assert.match(view, /report\.retention_note/);
  assert.match(routes, /retention_days: 90/);
  const note = en.split('\n').find((l) => l.includes("'report.retention_note'"));
  assert.ok(note, 'the note must exist');
  assert.match(note, /\{days\}/, 'and must state the actual window rather than hardcode a number');
});

test('the report queries are scoped by workspace, every one of them', () => {
  /*
   * Not a style check. This same file once shipped an uptime report with no scope clause at all,
   * readable by any authenticated user for every device on the platform. A missing WHERE here
   * surfaces as a slightly larger number, not as an error.
   */
  const lib = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'reports.js'), 'utf8');
  for (const fn of ['screensReport', 'filesReport', 'playlistsReport', 'groupsReport']) {
    const start = lib.indexOf(`function ${fn}(`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = lib.slice(start, lib.indexOf('\n}', start));
    assert.match(body, /workspace_id = \?/, `${fn} must filter on workspace_id`);
    assert.match(body, /workspaceId \|\| null/, `${fn} must pass the workspace through`);
  }
});

test('the CSV defends against formula injection and Excel encoding', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'reports.js'), 'utf8');
  assert.match(lib, /\^\[=\+\\-@/, 'the leading-character guard must cover = + - @');
  assert.match(lib, /'\\ufeff'|'\uFEFF'|﻿/, 'the BOM must be written, or Excel reads it as Latin-1');
});

test('reporting lives here and nowhere else', () => {
  /*
   * THE REGRESSION THIS GUARDS. The screen's page and the file's page each grew their own report,
   * one of them an always-open panel above the settings anybody opened the page for. Both are
   * gone; if a panel comes back, it comes back on a page that is for doing, not reading.
   */
  const ROOT = path.join(__dirname, '..', '..');
  const device = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.doesNotMatch(device, /renderExhibitionSection|mountExhibition/,
    'the screen page configures a screen; it does not report on one');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend', 'js', 'views', 'content-detail.js')),
    "a file's own report page is a second home for reporting");
});

test('a screen report is a GRID, not the play-by-play list', () => {
  /*
   * The list is what made the screen's page unreadable — 739 rows for one day, and 5,760 for a
   * screen looping a 15-second clip. It is also what makes the competitor's per-screen PDF fifteen
   * pages long. The grid says the same thing in one screenful; the row-by-row detail is the CSV.
   */
  assert.match(view, /renderMatrix/);

  // The page reads the AGGREGATED endpoint; the play-by-play one is reachable only as a CSV,
  // which is where somebody who genuinely wants 5,760 lines can have them.
  const detail = view.slice(view.indexOf('const DETAIL_URL'), view.indexOf('const EXPORT_URL'));
  assert.match(detail, /\/summary/);
  assert.doesNotMatch(detail, /timeline/, 'a timeline is not what a page shows');

  const exp = view.slice(view.indexOf('const EXPORT_URL'), view.indexOf('const RENDER'));
  assert.match(exp, /timeline\/export/, 'and it is exactly what a CSV shows');
});

test('the period is picked in words, and resolved to dates', () => {
  // Two bare date fields made "today", "yesterday" and "last week" a calendar exercise every time.
  for (const p of ['today', 'yesterday', 'last7', 'this_month', 'last_month', 'custom']) {
    assert.ok(view.includes(`'${p}'`), `${p} must be offered`);
  }
  assert.match(view, /function resolvePeriod/);
  // And the custom fields only appear when they mean something.
  assert.match(view, /rep-custom/);
});

test('a backwards range is straightened, not obeyed', () => {
  // start after end returns nothing, which reads exactly like "this played nothing" — the one
  // conclusion this page must never reach by accident.
  assert.match(view, /if \(b < a\) \[a, b\] = \[b, a\];/);
});

test('the subject can be reached three ways, and they all end in the same place', () => {
  // Picked from the dropdown, clicked in the table, or deep-linked from the object's own page.
  assert.match(view, /getElementById\('reportSubject'\)/);
  assert.match(view, /\.rep-row/);
  assert.match(view, /function applyParams/);
  assert.match(view, /params\.get\('id'\)/);

  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');
  assert.match(app, /hash\.startsWith\('#\/reports\?'\)/, 'the route has to accept the parameters');
  assert.match(app, /new URLSearchParams\(qs\)/);
});

test('switching tab drops the subject with it', () => {
  // Carrying it across would ask for a file report about a screen — a 404 that looks like the
  // report being broken rather than like the wrong question.
  const tabHandler = view.slice(view.indexOf("querySelectorAll('.settings-tab')"), view.indexOf("getElementById('reportPeriod')"));
  assert.match(tabHandler, /state\.subject = null/);
});

test('groups stay comparative, and the picker knows it', () => {
  // A group is a way of selecting screens, not something that plays. Offering a per-group report
  // would be a control that leads nowhere.
  assert.match(view, /const DETAILED = \{[^}]*groups: false/s);
  assert.match(view, /field\.hidden = !DETAILED\[state\.tab\]/);
});

test('the subject picker is filled from the rows already fetched', () => {
  // A second list of the same things is a second thing that can be out of step with the first.
  assert.match(view, /state\.subjects = data\.rows\.map/);
});
