'use strict';

// t() returns the KEY ITSELF when a string is missing — `registry[lang]?.[key] ?? fallback[key] ?? key`.
// It never returns undefined. Two consequences, both of which have already bitten:
//
//   1. A missing key ships to the user as raw text. A browser run found a context menu whose only
//      item read "schedule.ctx_new".
//   2. `t('x') || 'Some default'` looks like a safety net but is dead code, because the key string
//      is truthy. The default can never render, so it hides the missing key instead of covering it.
//
// Neither shows up in a unit test of the logic, or in a syntax check, or in review — only in front
// of a user. So this walks the views for the keys they actually ask for and checks English has them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const EN = fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.js'), 'utf8');

// Keys defined in en.js, as written: 'some.key': '...'
const defined = new Set([...EN.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Only literal t('...') calls — a computed key cannot be checked statically, and pretending
// otherwise would produce false failures.
function referencedKeys(src) {
  return [...src.matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi)].map(m => m[1]);
}

test('every literal t() key used by the app exists in English', () => {
  const missing = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const key of referencedKeys(src)) {
      if (!defined.has(key)) missing.push(`${path.relative(FRONTEND, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [],
    `these render as raw key text to the user:\n  ${missing.join('\n  ')}`);
});

test('every literal tn() key has BOTH plural forms in English', () => {
  /*
   * tn() builds its key at runtime — `keyBase + (n === 1 ? '_one' : '_other')` — so the literal
   * in the source matches nothing the test above looks for, and neither half is checked by it.
   *
   * The failure that leaves is worse than a plain missing key, because it is intermittent: define
   * only '_other' and the string reads correctly every time except the one day a customer owes
   * exactly one invoice, or is exactly one day late. Then the page says "ops.bill.days_one" to
   * them, and to nobody else, and it cannot be reproduced by whoever is told about it.
   *
   * Both halves, or neither counts.
   */
  const missing = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\btn\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi)) {
      for (const form of ['_one', '_other']) {
        if (!defined.has(m[1] + form)) missing.push(`${path.relative(FRONTEND, file)}: ${m[1]}${form}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    `tn() renders these as raw key text, but only at the count that needs them:\n  ${missing.join('\n  ')}`);
});

test('no t() call carries a || default, which can never fire', () => {
  // The pattern reads as a safety net and is the opposite: it guarantees the missing key is
  // silently shipped instead of the readable default.
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'[^']+'\s*(?:,[^)]*)?\)\s*\|\|\s*'/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(FRONTEND, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `t() never returns falsy, so these defaults are dead:\n  ${offenders.join('\n  ')}`);
});

test('the getting-started checklist has all of its strings', () => {
  // Called out separately because it is brand-new copy and entirely user-facing.
  for (const k of ['gs.title', 'gs.progress', 'gs.dismiss',
    'gs.device.title', 'gs.device.desc', 'gs.device.cta',
    'gs.content.title', 'gs.content.desc', 'gs.content.cta',
    'gs.playlist.title', 'gs.playlist.desc', 'gs.playlist.cta',
    'gs.assign.title', 'gs.assign.desc', 'gs.assign.cta']) {
    assert.ok(defined.has(k), `${k} is missing and would render literally`);
  }
});

// Help tips are the main in-product explanation, so a missing translation is not a cosmetic
// gap — it is a non-English user being handed an English paragraph at the exact moment they
// are confused. English is the deliberate fallback, but it should be a CHOICE, not a surprise.
//
// hi.js is intentionally empty (see the note at the top of that file: a real user in India,
// and a decision not to ship machine-quality Hindi), so it is excluded by name rather than by
// accident — if another locale is ever stubbed the same way it has to be added here on purpose.
const INTENTIONALLY_EMPTY = new Set(['hi']);

test('the page-title help markers stay gone', () => {
  /*
   * Two tests used to live here: one checked that every .help_tip string was translated in every
   * locale, the other that a tip marker named a string that exists. Both are about a thing that
   * no longer does — thirteen "?" markers, one per page title, were removed along with their
   * strings and their CSS.
   *
   * They are replaced rather than deleted because the first would have kept PASSING while
   * guarding translations of text nobody renders, and the second would have quietly become
   * vacuous. A test that cannot fail is worse than no test: it reads like coverage.
   *
   * What is worth guarding now is the removal. A "?" beside a heading is the kind of thing that
   * comes back one view at a time.
   */
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/class="help-tip"/.test(src)) offenders.push(path.relative(FRONTEND, file));
  }
  assert.deepEqual(offenders, [], 'the page-title "?" markers were removed deliberately');

  // And the strings with them, so no locale carries text for a control that is not there.
  const stale = [...defined].filter((k) => k.endsWith('.help_tip'));
  assert.deepEqual(stale, [], 'help_tip strings outlived their markers');
});

test('user-facing labels are translated, not hardcoded English', () => {
  // A title= is a tooltip the user reads and an aria-label is what a screen reader says. Both
  // were hardcoded English in a dozen places, so a French user hovering the only route to
  // workspace members heard "Manage members". They are invisible to the key checks above
  // precisely because they never call t().
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(aria-label|title)="([A-Z][a-zA-Z ]{3,40})"/g)) {
      offenders.push(`${path.relative(FRONTEND, file)}: ${m[1]}="${m[2]}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `these ship English regardless of language:\n  ${offenders.join('\n  ')}`);
});
