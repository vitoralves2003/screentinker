'use strict';

/*
 * Three faults that only exist on a phone, and none of which fails anything on a desktop.
 *
 *   1. The bottom of every page was unreachable. 100vh on a phone is the height WITHOUT the
 *      browser's toolbars, which are on screen — so the shell was taller than the visible area,
 *      and `body { overflow: hidden }` meant there was no way to scroll to what fell off.
 *   2. The menu button floated with nothing behind it, so content scrolled UNDER a transparent
 *      square and every heading that passed beneath came out half-covered.
 *   3. The screen name was not truncated, it was COLLAPSED. table-layout:fixed with a fixed width
 *      on every column except the name leaves the name whatever remains, and on a 390px phone
 *      nothing remains.
 *
 * These are arithmetic and CSS-presence checks. They cannot prove the page feels right — only a
 * real device does that — but they can stop the specific causes coming back.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'main.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'app.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'dashboard.js'), 'utf8');

/*
 * The body of a rule, from its selector to the closing brace at column zero.
 *
 * A plain indexOf('}') is wrong here and was: .main-wrapper's own comment contains
 * `body { overflow: hidden }`, so the slice ended inside the comment and the assertions read a
 * rule that appeared to have no height at all.
 */
function ruleBody(selector) {
  const at = css.indexOf(selector);
  assert.ok(at > 0, `${selector} must exist`);
  const end = css.indexOf('\n}', at);
  assert.ok(end > at, `${selector} must be closed`);
  return css.slice(at, end);
}

/*
 * Everything outside the mobile breakpoint. Not "the text before it": the device-table rules sit
 * AFTER the media query in this file, and slicing only the prefix silently checked nothing.
 */
function desktopCss() {
  const mq = mobileBlock();
  return css.replace(mq, '');
}

/* The @media (max-width: 768px) block, on its own. */
function mobileBlock() {
  const at = css.indexOf('@media (max-width: 768px) {');
  assert.ok(at > 0, 'the mobile breakpoint must exist');
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error('unbalanced media query');
}

test('the shell is sized in dvh, with vh kept as the fallback', () => {
  /*
   * Both, and in that order. dvh alone breaks a browser that does not know it (the declaration is
   * dropped and the element has no height at all); vh alone is the bug.
   */
  for (const sel of ['.sidebar', '.main-wrapper']) {
    const rule = ruleBody(`${sel} {`);
    assert.match(rule, /height: 100vh;/, `${sel} needs the vh fallback`);
    assert.match(rule, /height: 100dvh;/, `${sel} needs dvh`);
    assert.ok(rule.indexOf('100vh') < rule.indexOf('100dvh'), `${sel}: the fallback must come first`);
  }
});

test('the page can still only scroll in one place', () => {
  // The dvh fix is only correct while .content is the scroller; if body scrolled too the fixed
  // sidebar and the bar would drift.
  assert.match(css, /body \{[^}]*overflow: hidden/s);
  assert.match(ruleBody('.content {'), /overflow-y: auto/);
});

test('safe areas are honoured, and asked for', () => {
  /*
   * env(safe-area-inset-*) reports 0 unless the viewport meta opts in with viewport-fit=cover.
   * Writing the padding without the meta is the quiet half-fix: it looks done and does nothing.
   */
  assert.match(html, /viewport-fit=cover/, 'without this every inset below reads as zero');
  assert.match(css, /env\(safe-area-inset-bottom/, 'the home indicator overlaps the last row');
  assert.match(css, /env\(safe-area-inset-top/, 'the notch overlaps the bar');
});

test('the menu button lives in a bar with a background, not loose over the page', () => {
  const rule = ruleBody('.mobile-topbar {');
  assert.match(rule, /position: fixed/);
  assert.match(rule, /background: var\(--bg-primary\)/,
    'a transparent bar is the original bug wearing a new name');

  // And the button itself must no longer position itself.
  const btn = ruleBody('.mobile-menu-btn {');
  assert.doesNotMatch(btn, /position: fixed/, 'the bar positions it now');

  assert.match(html, /class="mobile-topbar"/);
  assert.match(html, /id="mobileMenuBtn"/, 'the id every handler already looks for must survive');
});

test('the content clears the bar by the height the bar actually has', () => {
  /*
   * The old value was 68px against a 44px button at top:12 — a guess that happened to fit. Now it
   * is the bar's own box: 8 + 44 + 8 + 1px border = 61.
   */
  const mq = mobileBlock();
  assert.match(mq, /padding-top: calc\(61px \+ env\(safe-area-inset-top/);
  assert.doesNotMatch(mq, /padding-top: 68px/);
});

test('the bar says which page you are on, without a second route table', () => {
  /*
   * On a phone the real page header scrolls away and nothing is left saying where you are. The
   * title is read off the nav link that just became active — a parallel route-to-name map would
   * be one more thing to update, and its failure is silent: the bar keeps the previous page's name.
   */
  assert.match(html, /id="mobileTopbarTitle"/);
  assert.match(app, /document\.querySelector\('\.nav-link\.active span'\)/);
  assert.doesNotMatch(app, /const MOBILE_TITLES/, 'no second table of route names');
});

test('the device table stops crushing the name column on a phone', () => {
  /*
   * The arithmetic that caused it: five fixed columns totalling 707px plus a percentage one, on a
   * viewport of 390. With table-layout:fixed the only column without a width — the name — gets
   * what is left, and nothing is left.
   *
   * Three of those columns are gone now (state, current item, signals), which fixes the sum at the
   * source. What remains on a phone is the name and the lists, because those are the two things
   * you cannot answer any other way.
   */
  const mq = mobileBlock();
  assert.match(mq, /\.device-list-wrap \.list-table \{ table-layout: auto; \}/,
    'fixed layout is what turns "too narrow" into "zero width"');
  assert.match(mq, /\.col-layout \{ display: none; \}/,
    'the layout name is the one a phone can spare — the lists are not');

  /*
   * And the state has to be readable without colour. The dot beside the name is a 9px target
   * carrying a title and an aria-label; on a phone the WORD comes back under the name, because
   * colour alone is exactly what a colour-blind reader and a screen reader do not get.
   */
  assert.match(mq, /\.state-inline \{ display: block; \}/,
    'the state must appear as a word under the name, not as colour alone');
  assert.match(dashboard, /<div class="state-inline">/, 'and the row has to render it');
});

test('the state travels on the row, and not as colour alone', () => {
  /*
   * THE STATE HAS NO CELL AND NO DOT. It is the coloured stripe down the left of the row — which is
   * the thing actually scanned in a long list, because it sits at a fixed x while names do not.
   *
   * A stripe is colour, and colour alone is exactly what a colour-blind reader and a screen reader
   * do not get. So the row also carries the state IN WORDS, as a title and an aria-label, and the
   * phone still prints it under the name. Three carriers, one fact.
   */
  assert.match(dashboard, /data-row-state="\${b\.state}"/, 'the stripe reads this');
  assert.match(dashboard, /data-liveness="\${b\.state}"/, 'the status filter reads this');
  assert.match(dashboard, /aria-label="\${esc\(device\.name\)} — \${esc\(stateText\(device, b\)\)}"/,
    'and anything that cannot see the stripe reads this');

  assert.ok(!dashboard.includes('state-dot'), 'no dot: the stripe already said it, three pixels away');

  for (const state of ['healthy', 'degraded', 'offline', 'provisioning']) {
    assert.ok(css.includes(`.device-row[data-row-state="${state}"]`),
      `no stripe colour for "${state}" — it would paint as nothing`);
  }
});

test('the screen owner is not repeated under every name', () => {
  /*
   * Removed at the operator's request, and he is right about the arithmetic: on a single-tenant
   * fleet the line under every name is the same name, so it is a column's worth of vertical space
   * spent saying nothing that distinguishes one row from another.
   */
  assert.ok(!dashboard.includes('device.owner_name || device.owner_email'),
    'the owner line is gone from the fleet row');
});

test('the desktop table keeps its fixed layout', () => {
  // The phone fix must not cost the desktop its column sizing, which is the shape of regression
  // this file exists to catch.
  const base = desktopCss();
  assert.match(base, /\.device-list-wrap \.list-table \{ table-layout: fixed; \}/);
  assert.match(base, /\.device-list-wrap \.list-table \.col-layout \{ width: 20%; \}/);
});

