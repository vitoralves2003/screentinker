'use strict';

/*
 * The page for one file.
 *
 * The thing this page can get wrong without anyone noticing is mixing its two kinds of number.
 * "In 3 lists, on 4 screens" is true right now and does not decay. "142 exhibitions" is bounded by
 * a 90-day retention. Shown as one row of equal tiles, a zero in the second kind reads as "it
 * never played" when it means "not in this window" — so the separation is what most of this pins.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const view = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'content-detail.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'app.js'), 'utf8');
const library = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'content-library.js'), 'utf8');
const exhibition = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-exhibition.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'main.css'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
const pt = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'pt.js'), 'utf8');

test('#/content/<id> routes to the file page and #/content still opens the library', () => {
  /*
   * Order matters and gets this wrong silently. A startsWith('#/content') arm placed first
   * swallows the library itself, and an equality check alone never matches the detail page — the
   * hash falls through to whatever arm comes next.
   */
  const detailAt = app.indexOf("hash.startsWith('#/content/')");
  const libraryAt = app.indexOf("hash === '#/content'");
  assert.ok(detailAt > 0, 'the detail route must exist');
  assert.ok(libraryAt > 0, 'and so must the library');
  assert.ok(detailAt < libraryAt, 'the more specific route has to be tested first');
  assert.match(app, /import \* as contentDetail from '\.\/views\/content-detail\.js'/);
});

test('there is a way to REACH the page from both places a file is looked at', () => {
  // A page nothing links to is a page nobody finds. The library modal is where a file is opened;
  // the exhibition row is where somebody is already asking "what is this file doing".
  assert.match(library, /id="fileReportBtn"/);
  assert.match(library, /window\.location\.hash = `#\/content\/\$\{contentItem\.id\}`/);
  assert.match(exhibition, /href="#\/content\/\$\{esc\(it\.content_id\)\}"/);
});

test('a play row with no file id is text, not a broken link', () => {
  // Widget plays and files deleted since carry no content_id. Linking them anyway would produce
  // '#/content/undefined' — a page that loads, fails, and looks like the report is broken.
  assert.match(exhibition, /it\.content_id\s*\n?\s*\?/, 'the link is conditional on there being an id');
});

test('the two kinds of number are separated, and each says what it is', () => {
  /*
   * Structural above, play-based below, each under its own heading. The retention limit is IN the
   * subtitle of the second, not in a footnote — the reader has to meet it before the zero.
   */
  assert.match(view, /filereport\.where_title/);
  assert.match(view, /filereport\.plays_title/);
  assert.match(en, /'filereport\.plays_sub': '[^']*\{days\}/, 'the window and the retention belong in the heading');
  assert.match(en, /'filereport\.where_sub': '[^']*does not depend on play history/);

  // And the structural tiles must not be inside the play section's window.
  const whereAt = view.indexOf('filereport.where_title');
  const playsAt = view.indexOf('filereport.plays_title');
  const reachTile = view.indexOf('filereport.tile.screens');
  assert.ok(whereAt < reachTile && reachTile < playsAt, 'reach belongs above the play window');
});

test('an empty window does not claim the file never played', () => {
  assert.match(view, /filereport\.no_plays_hint/);
  assert.match(en, /'filereport\.no_plays_hint': '[^']*\{days\}/);
  for (const key of ['filereport.no_plays', 'filereport.where_title', 'filereport.via_sublist']) {
    assert.ok(pt.includes(`'${key}'`), `${key} must exist in Portuguese — this is a pt-BR product`);
  }
});

test('a list the file only rotates THROUGH says so', () => {
  // Naming "Principal" without saying it reaches the file through a sub-list implies somebody
  // added the file to a list nobody added it to.
  assert.match(view, /p\.via \?/);
  assert.match(view, /filereport\.via_sublist/);
  assert.match(en, /'filereport\.via_sublist': 'through \{list\}'/);
});

test('the chart draws empty days as gaps rather than skipping them', () => {
  /*
   * A series built only from the days that have plays draws a continuous, healthy-looking line
   * across a week the screen was switched off. The gap is the finding.
   */
  const fn = view.slice(view.indexOf('function chart'), view.indexOf('function reachPanel'));
  assert.match(fn, /byDate\.get\(key\) \|\| 0/, 'every day in the range gets a bar, even a zero one');
  assert.match(fn, /d\.plays \? 'var\(--accent\)' : 'transparent'/);
  assert.match(fn, /all\.length > 400/, 'a range of years must not draw sub-pixel bars forever');
});

test('the chart needs no external library', () => {
  // The page is served under a CSP that blocks external hosts, and inlining a charting library to
  // draw eleven rectangles is a lot of weight for the shape being shown.
  assert.doesNotMatch(view, /import .*(chart|d3|plotly)/i);
  assert.match(view, /<svg viewBox/);
});

test('a slow response cannot paint over a page the operator has left', () => {
  const load = view.slice(view.indexOf('async function load'), view.indexOf('export async function render'));
  assert.match(load, /if \(!state\) return;/, 'the module clears state on cleanup, and the fetch checks it');
  assert.match(view, /export function cleanup\(\)[\s\S]*state = null/);
});

test('a backwards date range is straightened, not obeyed', () => {
  // start after end returns nothing, which on this page reads as "this file never played".
  assert.match(view, /if \(b < a\) \[a, b\] = \[b, a\];/);
});

test('the layout stacks on a phone by content width, not by a breakpoint', () => {
  const cols = css.slice(css.indexOf('.cd-cols {'), css.indexOf('}', css.indexOf('.cd-cols {')));
  assert.match(cols, /auto-fit/);
  assert.match(cols, /minmax\(260px/);

  const tiles = css.slice(css.indexOf('.cd-tiles {'), css.indexOf('\n}', css.indexOf('.cd-tiles {')));
  assert.match(tiles, /auto-fit/, 'three fixed columns at 390px are three unreadable columns');

  assert.match(view, /class="cd-scroll"/);
  assert.match(css, /\.cd-scroll \{ overflow-x: auto; \}/);
});

test('the export is fetched with the token, not opened as a link', () => {
  const exp = view.slice(view.indexOf("getElementById('cdExport')"));
  assert.match(exp, /Authorization: `Bearer/);
  assert.match(exp, /URL\.createObjectURL/);
});
