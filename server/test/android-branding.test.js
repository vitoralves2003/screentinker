'use strict';

/*
 * What is on the TV itself.
 *
 * Nothing here is exercised by building the app, and the app is not built in CI — so the screen a
 * customer stares at while a panel connects had a grey Android "play" glyph at 30% opacity and the
 * product's name typed underneath in the forked project's blue, and nobody found out from a test.
 * These are cheap reads of the resource files, and they are the only automated check that exists
 * on that surface.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RES = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'res');
const res = (...p) => fs.readFileSync(path.join(RES, ...p), 'utf8');

test('the logo is shipped as a drawable', () => {
  const p = path.join(RES, 'drawable', 'loop_player_logo.png');
  assert.ok(fs.existsSync(p), 'the waiting screen references it; it has to be in the APK');
  assert.ok(fs.statSync(p).size > 1000, 'a placeholder or a truncated copy would still "exist"');
});

test('the waiting screen shows the wordmark, not a stock glyph', () => {
  /*
   * This is often the only thing on a wall for a minute at a time — while the panel boots, while
   * it reconnects, while a playlist downloads. A generic play triangle there says nothing about
   * whose product it is.
   */
  const main = res('layout', 'activity_main.xml');
  assert.match(main, /@drawable\/loop_player_logo/);
  assert.doesNotMatch(main, /@android:drawable\/ic_media_play/,
    'the stock glyph must not come back beside the logo');
  assert.match(main, /android:adjustViewBounds="true"/,
    'without it the 428x102 asset is stretched into the box');
});

test("the app carries the product's own name", () => {
  assert.match(res('values', 'strings.xml'), /<string name="app_name">Loop Player<\/string>/);
});

test('the forked project’s blue is gone from every resource', () => {
  /*
   * #3B82F6 was the upstream accent. It survived in nine places — headings, the primary button,
   * an icon and the theme — so the app read as that product even with the right name on it.
   */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.xml') ? [full] : [];
  });
  const offenders = walk(RES).filter((f) => /#3B82F6/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(RES, f)), []);
});

test('no white label sits on the green primary button', () => {
  /*
   * The trap in a colour swap. White on #20DF91 measures 1.8:1, well under the 4.5:1 minimum —
   * turning the button green and leaving its label white would make it HARDER to read than the
   * blue one it replaced. The web palette solved this already with a near-black --accent-on; the
   * app uses the same value.
   */
  const layouts = fs.readdirSync(path.join(RES, 'layout')).filter((f) => f.endsWith('.xml'));
  for (const f of layouts) {
    const src = res('layout', f).replace(/\r\n/g, '\n');
    // Each element that uses the primary background, with a generous window either side of it.
    const around = [...src.matchAll(/[\s\S]{0,300}android:background="@drawable\/button_primary"[\s\S]{0,300}/g)];
    for (const m of around) {
      assert.ok(!/android:textColor="#FFFFFF"/.test(m[0]),
        `${f}: a white label on the green button is 1.8:1 — use #04231A`);
    }
  }
});

test('the primary button itself is the brand green', () => {
  const btn = res('drawable', 'button_primary.xml');
  assert.match(btn, /#20DF91/);
  assert.doesNotMatch(btn, /#2563EB/, 'the pressed ripple was the old blue too');
});
