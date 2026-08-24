'use strict';

/*
 * The exhibition section on a screen's page.
 *
 * These are text and structure checks on the source, not a browser. They cannot prove the panel
 * reads well — only a real screen does that — but each one guards a failure that is invisible
 * until somebody is looking at the wrong answer and believes it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const view = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-exhibition.js'), 'utf8');
const detail = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'main.css'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
const pt = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'pt.js'), 'utf8');

test('the section is rendered, mounted and torn down by the page that hosts it', () => {
  /*
   * The third of these is the one that bites. The panel owns a 30-second poll; a page that renders
   * and mounts it but never cleans up leaves that timer fetching for a screen the operator left,
   * once per visit, for as long as the tab lives.
   */
  assert.match(detail, /import \{ renderExhibitionSection, mountExhibition, cleanupExhibition \}/);
  assert.match(detail, /\$\{renderExhibitionSection\(\)\}/, 'the markup must be in the template');
  assert.match(detail, /mountExhibition\(device\.id\)/, 'and something has to wire it up');

  const cleanup = detail.slice(detail.indexOf('export function cleanup()'));
  assert.match(cleanup, /cleanupExhibition\(\)/, 'the poll must stop when the page does');
});

test('the poll is stopped in the module too, not only by the page', () => {
  // Belt and braces on the same timer: setLive clears before it sets, so toggling the checkbox
  // twice cannot leave two intervals running against the same panel.
  const setLive = view.slice(view.indexOf('function setLive'), view.indexOf('function isoBack'));
  assert.match(setLive, /clearInterval\(timer\)/);
  assert.match(view, /export function cleanupExhibition[\s\S]*clearInterval\(timer\)/);
});

test('a play that recorded no list is never shown as one', () => {
  /*
   * The whole point of the feature. Three situations — recorded, deleted since, never recorded —
   * and three different sentences. One shared empty cell would let an operator read "we have no
   * idea" as "it did not play", and read a deleted list as a gap in the record.
   */
  const label = view.slice(view.indexOf('function listLabel'), view.indexOf('function renderDay'));
  assert.match(label, /exhibition\.list_deleted/);
  assert.match(label, /exhibition\.list_unknown/);
  assert.doesNotMatch(label, /playlist_id/,
    'the decision belongs to the server, which knows why the name is missing');

  for (const key of ['exhibition.list_unknown', 'exhibition.list_deleted']) {
    assert.ok(en.includes(`'${key}'`), `${key} must exist in English or it renders as its own key`);
    assert.ok(pt.includes(`'${key}'`), `${key} must exist in Portuguese — this is a pt-BR product`);
  }
});

test('every time on the panel comes from the server, in the SCREEN\'s zone', () => {
  /*
   * The browser must never turn an epoch into a clock face here. It would use the operator's zone,
   * so a screen in another state would report hours it did not play — and every row would still
   * look like a perfectly ordinary time.
   */
  assert.match(view, /esc\(it\.time\)/, 'the row renders the server-formatted time');
  assert.doesNotMatch(view, /toLocaleTimeString|getHours\(\)/,
    'formatting a play time in the browser puts it in the wrong zone');

  // And the zone is stated, rather than left for the reader to assume.
  assert.match(view, /exhibition\.times_in/);
  assert.match(view, /exhibition\.tz_assumed/,
    'a screen that never reported a zone must say so, not quietly borrow UTC');
});

test('a partial answer says that it is partial', () => {
  // Truncation and unrecorded plays are both stated. Either one hidden turns "some of the rows"
  // into "the rows", which is the difference between a report and a claim.
  assert.match(view, /data\.truncated/);
  assert.match(view, /data\.totals\.unattributed/);
  assert.match(view, /exhibition\.truncated/);
  assert.match(view, /exhibition\.unattributed/);
});

test('an empty period does not claim the screen played nothing', () => {
  // play_logs is pruned at 90 days, so "nothing here" and "nothing kept" are different answers and
  // the panel cannot tell them apart. It says so instead of picking one.
  assert.match(view, /exhibition\.empty_hint/);
  assert.match(en, /'exhibition\.empty_hint': '[^']*\{days\}/, 'the retention has to be IN the sentence');
});

test('a failed live refresh leaves the panel it already drew', () => {
  /*
   * The quiet path returns instead of rendering an error. Without it, one dropped request while
   * the tab sat open would replace a screenful of readable history with a failure message every
   * thirty seconds.
   */
  const load = view.slice(view.indexOf('async function load'), view.indexOf('function setLive'));
  assert.match(load, /if \(quiet\) return;/);
});

test('a backwards date range is straightened, not obeyed', () => {
  // start after end returns nothing, which on this panel reads exactly like "this screen played
  // nothing" — the one conclusion it must never produce by accident.
  assert.match(view, /if \(b < a\) \[a, b\] = \[b, a\];/);
});

test('the table scrolls inside its own box', () => {
  // A long file name would otherwise widen the page itself, and on a phone the whole layout
  // scrolls sideways behind the fixed bar.
  assert.match(view, /class="exh-scroll"/);
  assert.match(css, /\.exh-scroll \{ overflow-x: auto; \}/);
});

test('the tiles stack on a phone instead of shrinking to slivers', () => {
  const rule = css.slice(css.indexOf('.exh-tiles {'), css.indexOf('\n}', css.indexOf('.exh-tiles {')));
  assert.match(rule, /auto-fit/, 'four fixed columns at 390px are four unreadable columns');
});

test('the export is fetched with the token, not opened as a link', () => {
  // A plain href cannot send an Authorization header: it would save the 401 body as a .csv and
  // look to the operator like a corrupt export rather than a login problem.
  const exp = view.slice(view.indexOf("getElementById('exhExport')"));
  assert.match(exp, /Authorization: `Bearer/);
  assert.match(exp, /URL\.createObjectURL/);
});
