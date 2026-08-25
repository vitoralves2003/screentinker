'use strict';

/*
 * The theme, as a set of rules the stylesheet has to keep obeying.
 *
 * The app is a dark rail with a light application, and the two halves are held apart by nothing
 * but discipline: one token family for the sidebar, another for everything else. Discipline
 * decays, so it is written down here.
 *
 * THE FAILURE THIS GUARDS AGAINST is not "the wrong shade of grey". It is a colour written as a
 * literal — #fff, #3B82F6, rgba(255,255,255,.06) — which belongs to whichever theme the person
 * writing it had on screen at the time, and which no theme change can reach. The app already
 * carried a whole second accent colour that way: --primary was referenced eight times, defined
 * nowhere, and fell through to the blue of the project this was forked from.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'frontend');
const vars = fs.readFileSync(path.join(ROOT, 'css', 'variables.css'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'css', 'main.css'), 'utf8');

function appScripts() {
  const out = [];
  for (const dir of ['views', 'components']) {
    const d = path.join(ROOT, 'js', dir);
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.js')) out.push([path.join(dir, f), fs.readFileSync(path.join(d, f), 'utf8')]);
    }
  }
  return out;
}

const defined = new Set([...vars.matchAll(/^\s*(--[a-z-]+)\s*:/gm)].map((m) => m[1]));

/* WCAG 2.1 relative luminance, so the numbers in variables.css can be checked rather than trusted. */
function luminance(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? [...c].map((x) => x + x).join('') : c;
  const v = [0, 2, 4].map((i) => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name) => (new RegExp(`^\\s*${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'm').exec(vars) || [])[1];

/* ---------------------------------------------------------------- tokens exist */

test('every token the app asks for is actually defined', () => {
  /*
   * THE BUG THIS PINS. --primary and --info were used eight times between them and defined
   * nowhere, so each use silently fell through to its literal fallback — the fork's #3B82F6. The
   * product carried a second accent colour that nobody had chosen and no theme could change.
   *
   * An undefined LENGTH is worse still: --radius-md had no fallback at all, so the declaration
   * was simply invalid and the element got no radius — a square card among rounded ones.
   */
  const used = new Set();
  for (const [, src] of [['main.css', main], ...appScripts()]) {
    for (const m of src.matchAll(/var\((--[a-z-]+)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], `usados e não definidos: ${missing.join(', ')}`);
});

test('no var() carries a fallback colour', () => {
  /*
   * Every fallback in this codebase was a DARK literal — var(--bg-card, #111827). Harmless while
   * the token resolves, and worse than harmless if it ever does not: the fallback paints the old
   * theme into the new page, and the result looks like a design decision rather than a fault.
   * The answer to a missing token is a defined token, which the test above enforces.
   */
  const offenders = [];
  for (const [name, src] of [['css/main.css', main], ...appScripts()]) {
    for (const m of src.matchAll(/var\(--[a-z-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\()/g)) {
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

/* ---------------------------------------------------------------- the two halves */

test('only the rail reads the rail palette', () => {
  /*
   * The split between the two halves is held by nothing but which token a rule reaches for. So the
   * rule is stated: a --sidebar-* value may only be read by a selector that IS the rail — the rail
   * itself, the wordmark, the nav, the workspace switcher that sits inside it.
   *
   * The day a content-area component borrows --sidebar-bg because it happened to want a dark
   * panel, the two palettes are one again and the next change to the rail leaks into the page.
   */
  assert.equal(token('--sidebar-bg'), '#031525', 'the rail did not change');

  const RAIL = /\.(sidebar|logo|nav-link|nav-links|workspace-switcher|mobile-menu|mobile-topbar)/;
  const offenders = [];

  // Rule by rule: the selector is whatever precedes the brace.
  for (const m of main.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/var\(--sidebar-/.test(m[2])) continue;
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
    if (!RAIL.test(selector)) offenders.push(selector.slice(-70));
  }

  assert.deepEqual(offenders, [],
    'estes leem um token do rail sem ser o rail:\n  ' + offenders.join('\n  '));
});

test('the page ground is light and the rail is dark', () => {
  const ground = token('--bg-primary');
  assert.ok(luminance(ground) > 0.7, `--bg-primary ${ground} should be a light ground`);
  assert.ok(luminance(token('--sidebar-bg')) < 0.05, 'the rail should stay dark');
});

/* ---------------------------------------------------------------- measured contrast */

test('body text clears AA against both the page and a card', () => {
  const ground = token('--bg-primary');
  const card = token('--bg-card');
  for (const name of ['--text-primary', '--text-secondary', '--text-muted']) {
    for (const [surface, hex] of [['página', ground], ['cartão', card]]) {
      const r = contrast(token(name), hex);
      assert.ok(r >= 4.5, `${name} sobre ${surface}: ${r.toFixed(2)}:1 (mínimo 4,5)`);
    }
  }
});

test('every status colour is legible as text, which none of the old ones were', () => {
  /*
   * #22C55E measured 2.28:1 on a white card and #F59E0B measured 2.15:1. Both read perfectly on
   * the old dark ground; both became decoration on this one. A status that cannot be read is a
   * status that is not being reported.
   */
  const card = token('--bg-card');
  for (const name of ['--success', '--danger', '--warning', '--info']) {
    const r = contrast(token(name), card);
    assert.ok(r >= 4.5, `${name}: ${r.toFixed(2)}:1 sobre cartão`);
  }
});

test('the brand green is used as a surface, never as ink', () => {
  /*
   * THE MEASUREMENT THE WHOLE PALETTE TURNS ON. #20DF91 on white is 1.75:1 — it fails as text,
   * and fails again as a border, where the bar is only 3:1. So it keeps the one job it is good
   * at: a filled surface, with --accent-on over it. Everything read as ink takes --accent-ink.
   */
  const white = token('--bg-card');
  assert.ok(contrast(token('--accent'), white) < 3,
    'if the brand green ever passes on white, this rule can be revisited — until then it cannot be ink');
  assert.ok(contrast(token('--accent-on'), token('--accent')) >= 4.5,
    'text on a filled brand button');
  assert.ok(contrast(token('--accent-ink'), white) >= 4.5,
    'the ink green has to be readable, which is its entire reason for existing');
});

test('the rail\'s own colours still hold against the rail', () => {
  const rail = token('--sidebar-bg');
  assert.ok(contrast(token('--sidebar-text'), rail) >= 4.5);
  assert.ok(contrast(token('--sidebar-brand'), rail) >= 4.5,
    'the brand green is at its best here — which is what lets it be sober in the content area');
});

/* ---------------------------------------------------------------- no literals creeping back */

test('no colour is written as a literal outside the places that earn it', () => {
  /*
   * Three kinds of literal are legitimate and everything else is a theme waiting to break:
   *
   *   #000 / #0003        a media surface — a video, a screenshot, a scrim over one. Dark whatever
   *                       the page does, because the thing behind it is.
   *   #fff                white ON one of those scrims, or on a filled status colour.
   *   the sidebar block   still a dark theme, and correct there.
   */
  const allowed = /^#(fff|ffffff|000|000000|0003)$/i;
  const offenders = [];

  for (const [name, src] of appScripts()) {
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(/(?:color|background|border[a-z-]*|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
        if (!allowed.test(m[1])) offenders.push(`${name}:${i + 1} ${m[0]}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    `cor literal fora de token:\n  ${offenders.join('\n  ')}`);
});

test('translucent WHITE survives only in the sidebar', () => {
  // On a dark ground a white veil is a highlight; on this one it is nothing at all. Six of these
  // were spread through the content area and simply stopped rendering.
  const at = main.indexOf('/* Sidebar');
  const body = main.slice(0, at) + main.slice(at + 4000);
  assert.doesNotMatch(body, /rgba\(255,\s*255,\s*255/,
    'a white veil outside the rail is invisible on a light page');
});

/* ---------------------------------------------------------------- white-label */

/*
 * Branding is applied by writing custom properties onto <html> as an INLINE style, which beats
 * every stylesheet. That is what made the theme change look broken in production: a tenant row
 * still holding bg_color #06111e from the dark era repainted the page ground dark while every
 * other token came from the new palette. Dark text on a dark page, and nothing in the CSS to
 * explain it.
 *
 * The rules below are what keeps that from happening again, and they are checked by RUNNING the
 * real functions out of brand-prime.js rather than by reading its source.
 */
function brandingFns() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'brand-prime.js'), 'utf8');
  const grab = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `brand-prime.js must define ${name}()`);
    let depth = 0;
    for (let j = src.indexOf('{', at); j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}' && (depth -= 1) === 0) return src.slice(at, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const mod = { exports: {} };
  const body = ['luminance', 'contrast', 'inkOn', 'darken'].map(grab).join('\n');
  // eslint-disable-next-line no-new-func
  new Function('module', `${body}\nmodule.exports = { luminance, contrast, inkOn, darken };`)(mod);
  return mod.exports;
}

test('branding cannot repaint the page ground', () => {
  /*
   * THE BUG THIS PINS, exactly. One colour was allowed to move the ground and nothing re-derived
   * the ink that has to be read against it — so it would break the same way in reverse the day a
   * tenant picked white. What a customer wants from white-label is their name, their logo and
   * their colour, not authority over the surface hierarchy.
   */
  for (const f of ['brand-prime.js', 'branding.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    assert.doesNotMatch(src, /--bg-primary|--bg-card|--bg-secondary|--text-primary/,
      `${f} must not set a surface or text token`);
  }
});

test('a brand colour arrives as a complete set, never on its own', () => {
  // --accent is a SURFACE; --accent-on is what sits legibly on top of it and --accent-ink is the
  // readable version. Setting only the first leaves the other two pointing at the default green,
  // so a tenant with a dark brand colour gets dark ink on a dark button.
  const src = fs.readFileSync(path.join(ROOT, 'js', 'brand-prime.js'), 'utf8');
  for (const tok of ['--accent', '--accent-on', '--accent-ink']) {
    assert.ok(src.includes(`'${tok}'`), `${tok} must be derived alongside the others`);
  }
});

test('every brand colour a tenant could pick stays legible', () => {
  /*
   * Run against real inputs, including the two stored in production and the one that broke the
   * first attempt: pure red. A luminance THRESHOLD chose white there and measured 4.00:1, when
   * black would have given 5.25 — so the choice is measured now rather than guessed.
   */
  const { luminance, contrast, inkOn, darken } = brandingFns();
  const brands = [
    '#20DF91', // the default
    '#23d448', // the colour actually stored for the live workspace
    '#1E293B', '#FFFFFF', '#000000', '#FF0000', '#FFFF00', '#0000FF', '#888888', '#7C3AED',
  ];

  for (const brand of brands) {
    const on = inkOn(brand);
    assert.ok(contrast(on, brand) >= 4.5,
      `${brand}: text on the filled button is ${contrast(on, brand).toFixed(2)}:1`);

    const lum = luminance(brand);
    const ink = lum > 0.18 ? darken(brand, lum) : brand;
    assert.ok(contrast(ink, '#FFFFFF') >= 4.5,
      `${brand}: derived ink is ${contrast(ink, '#FFFFFF').toFixed(2)}:1 on white`);
  }
});

test('the derived ink is not needlessly sombre', () => {
  /*
   * A first version darkened by a fixed ratio and landed at 11.7:1 where 5.5 was the target. Safe,
   * and visibly duller than the palette's own ink — so a branded interface would have read as
   * greyer than the default one for no reason anybody could see.
   */
  const { luminance, contrast, darken } = brandingFns();
  const ink = darken('#20DF91', luminance('#20DF91'));
  const r = contrast(ink, '#FFFFFF');
  assert.ok(r >= 4.5 && r <= 8,
    `derived ink for the brand green is ${r.toFixed(2)}:1; it should sit near the palette's own 5.5`);
});

test('the admin form does not offer a control that does nothing', () => {
  // The background-colour field kept saving a value nothing reads. An operator sets it, saves,
  // sees no change, and cannot tell whether the colour or the save was at fault.
  const admin = fs.readFileSync(path.join(ROOT, 'js', 'views', 'admin.js'), 'utf8');
  assert.doesNotMatch(admin, /brBg|bg_color/);
  assert.doesNotMatch(admin, /#3B82F6/i, 'and it stopped offering the fork\'s blue as the example');
});
