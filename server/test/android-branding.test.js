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
  /*
   * Follows the @color/ indirection instead of matching a hex in the drawable.
   *
   * The colours used to be literals pasted into whichever view needed them — twenty distinct
   * values across five layouts and seven drawables, none of them named. This test could only ask
   * "does this file contain #20DF91", which stops being true the moment the value is given a name,
   * and stops being MEANINGFUL long before that: it could not tell whether two greys were the same
   * grey on purpose.
   *
   * Resolving the reference asks the question that actually matters — is the button painted the
   * brand green — and keeps working when the palette is edited in one place, which is the whole
   * point of having moved it there.
   */
  const btn = res('drawable', 'button_primary.xml');
  const colors = res('values', 'colors.xml');

  const resolve = (name) => {
    const m = new RegExp(`<color name="${name}">(#[0-9A-Fa-f]{6,8})</color>`).exec(colors);
    assert.ok(m, `colors.xml não define @color/${name}`);
    return m[1].toUpperCase();
  };

  assert.match(btn, /android:color="@color\/brand"/, 'a face do botão usa a marca');
  assert.equal(resolve('brand'), '#20DF91');

  // The ripple is the pressed step of the brand, not the blue it used to be.
  assert.match(btn, /android:color="@color\/brand_pressed"/);
  assert.equal(resolve('brand_pressed'), '#18C57F');

  const themes = res('values', 'themes.xml');
  for (const file of [btn, themes, colors]) {
    assert.doesNotMatch(file, /#2563EB/i, 'o azul do projeto de origem não volta');
  }
});

test('every colour the player draws is named, not pasted', () => {
  /*
   * THE STATE THIS REPLACED. Every colour in the app was a literal written into the view that
   * needed it. Nothing named them, so nothing could check them, and the fork's own blue sat in
   * themes.xml as colorPrimaryVariant — from which Material derives pressed and elevated states,
   * so controls nobody had styled by hand came out in another product's colour.
   *
   * Black and white are the two exceptions and stay literal: a video letterbox is black because
   * black is the absence of picture, not because a designer picked it.
   */
  const ALLOWED = /^#(FFFFFF|000000)$/i;
  const offenders = [];
  for (const dir of ['layout', 'drawable']) {
    for (const f of fs.readdirSync(path.join(RES, dir))) {
      if (!f.endsWith('.xml')) continue;
      const src = fs.readFileSync(path.join(RES, dir, f), 'utf8');
      for (const m of src.matchAll(/"(#[0-9A-Fa-f]{6,8})"/g)) {
        if (!ALLOWED.test(m[1])) offenders.push(`${dir}/${f}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'cores coladas à mão, sem nome:\n  ' + offenders.join('\n  '));
});
