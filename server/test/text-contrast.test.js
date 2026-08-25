'use strict';

/*
 * Text has to be readable on the surfaces it is actually painted on.
 *
 * --text-muted was #64748B, which measures 3.58:1 against the darkest background in the palette —
 * below the 4.5:1 WCAG AA minimum, and it is used for 11px uppercase labels, where the relaxed
 * large-text threshold does not apply. It read as "a bit dim" rather than as a defect, which is
 * why it survived: nothing fails, nobody files it, and everyone squints slightly.
 *
 * This computes the real ratios from the tokens rather than trusting a colour that "looks fine",
 * so the next person to nudge a palette value finds out here instead of on a customer's monitor.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'css', 'variables.css'), 'utf8');

function token(name) {
  const m = CSS.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(m, `--${name} must be defined as a six-digit hex`);
  return m[1];
}

/* WCAG 2.1 relative luminance and contrast ratio. */
function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Every surface text is drawn on. The worst of them is the one that matters.
const SURFACES = ['bg-primary', 'bg-secondary', 'bg-card', 'bg-input'];

function worstAgainstSurfaces(fg) {
  return Math.min(...SURFACES.map((s) => ratio(fg, token(s))));
}

for (const name of ['text-primary', 'text-secondary', 'text-muted']) {
  test(`--${name} clears 4.5:1 on every surface`, () => {
    const r = worstAgainstSurfaces(token(name));
    assert.ok(r >= 4.5, `--${name} (${token(name)}) is ${r.toFixed(2)}:1 at worst; 4.5:1 is the minimum`);
  });
}

test('the three text levels stay distinguishable from each other', () => {
  /*
   * The lazy fix for the contrast failure is to make everything white, which passes this file and
   * destroys the reason the levels exist: a label and its value would carry identical weight, and
   * the reader loses the structure that told them which was which.
   */
  /*
   * Measured as DISTANCE FROM THE PAGE, not as brightness.
   *
   * This asserted "primary must be brighter than secondary" — true while the app was dark, and
   * false the moment it was not: on a light page the most prominent text is the darkest one. The
   * rule it was actually protecting is direction-free, and is the one written here.
   */
  const ground = token('bg-primary');
  const [p, s, m] = ['text-primary', 'text-secondary', 'text-muted'].map((n) => ratio(token(n), ground));
  assert.ok(p > s, 'primary must stand further from the page than secondary');
  assert.ok(s > m, 'secondary must stand further from the page than muted');
  assert.ok(ratio(token('text-secondary'), token('text-muted')) > 1.1,
    'secondary and muted must not collapse into the same colour');
});

test('nothing still hardcodes the old failing muted value as a fallback', () => {
  /*
   * `var(--text-muted, #64748B)` only fires when the token is missing — but leaving the old value
   * there means that path silently keeps the bug, and it is exactly the sort of thing a
   * find-and-replace on the token definition misses.
   */
  const ROOT = path.join(__dirname, '..', '..', 'frontend');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(css|js|html)$/.test(e.name) ? [full] : [];
  });
  const offenders = walk(ROOT).filter((f) => /--text-muted,\s*#64748[Bb]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});
