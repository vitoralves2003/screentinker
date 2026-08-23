'use strict';

/*
 * The nav must not flash English before it says Telas.
 *
 * index.html ships the sidebar with literal English words, and app.js — which owns the
 * dictionaries — is `type="module"`, therefore deferred. The browser paints the markup first and
 * the translation lands afterwards, so every page load showed the wrong language for as long as
 * the module graph took to parse. lang-prime.js fixes it the way brand-prime.js fixes the brand
 * flash: a plain synchronous script that runs during parse.
 *
 * The cost is a second copy of sixteen short strings. This file is what stops that copy rotting:
 * a label renamed in the dictionary and not here would flash the OLD word instead of the wrong
 * language, which is harder to notice and just as wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const front = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', ...p), 'utf8');

const primer = front('js', 'lang-prime.js');
const html = front('index.html');

/* The primer's own tables, read out of its source rather than re-typed here. */
function primerLabels(lang) {
  const block = primer.slice(primer.indexOf(`    ${lang}: {`));
  const body = block.slice(block.indexOf('{') + 1, block.indexOf('},'));
  const out = {};
  for (const m of body.matchAll(/(\w+):\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

/* And the real dictionary, likewise. */
function dictLabels(loc) {
  const src = front('js', 'i18n', `${loc}.js`);
  const out = {};
  for (const m of src.matchAll(/^\s*'nav\.([\w.]+)'\s*:\s*(['"])([^'"]*)\2/gm)) out[m[1]] = m[3];
  return out;
}

// data-view -> translation key, as app.js maps them.
const NAV_KEYS = {
  dashboard: 'displays', content: 'content', playlists: 'playlists', layouts: 'layouts',
  widgets: 'widgets', schedule: 'schedule', walls: 'walls', reports: 'reports',
  kiosk: 'kiosk', designer: 'designer', teams: 'teams', members: 'members',
  help: 'help', settings: 'settings', billing: 'subscription', admin: 'admin',
};

test('the primer runs before the deferred module, and after the nav exists', () => {
  /*
   * Both halves matter. Before app.js or it is pointless; after the markup or there is nothing
   * for querySelectorAll to find and it silently does nothing.
   */
  const primerAt = html.indexOf('/js/lang-prime.js');
  const appAt = html.indexOf('/js/app.js');
  const lastNav = html.lastIndexOf('class="nav-link"');
  assert.ok(primerAt > 0, 'the primer must be on the page');
  assert.ok(primerAt < appAt, 'it must come before the deferred module that would repaint it');
  assert.ok(primerAt > lastNav, 'and after the last nav link, or it finds nothing to translate');
  assert.doesNotMatch(html.slice(primerAt, primerAt + 120), /type="module"/,
    'a module here would be deferred too, which is the bug');
});

for (const [loc, key] of [['pt', 'pt'], ['en', 'en'], ['es', 'es']]) {
  test(`every ${loc} label in the primer matches the dictionary`, () => {
    const mine = primerLabels(key);
    const real = dictLabels(loc);
    for (const [view, navKey] of Object.entries(NAV_KEYS)) {
      if (!real[navKey]) continue;   // a key the locale has not translated falls back; skip it
      assert.equal(mine[view], real[navKey],
        `${loc}: "${view}" says "${mine[view]}" in the primer and "${real[navKey]}" in i18n/${loc}.js`);
    }
  });
}

test('the primer covers every nav item on the page', () => {
  // A view missing from the table flashes English on that one link only — the easiest kind of
  // regression to introduce and the hardest to spot.
  const views = [...html.matchAll(/data-view="([\w-]+)"/g)].map((m) => m[1]);
  const mine = primerLabels('pt');
  for (const v of new Set(views)) {
    assert.ok(mine[v], `data-view="${v}" is on the page but not in lang-prime's table`);
  }
});

test('the primer reads the language the same way i18n.js does', () => {
  /*
   * If the two disagreed the flash would come back, just between a different pair of languages —
   * and it would look like the primer was not running at all.
   */
  const i18n = front('js', 'i18n.js');
  assert.match(i18n, /localStorage\.getItem\('rd_lang'\)/);
  assert.match(primer, /localStorage\.getItem\('rd_lang'\)/);
  assert.match(primer, /navigator\.language/);
});

test('the document no longer claims to be in English', () => {
  // A Portuguese page declaring lang="en" is what makes a browser offer to translate it, and what
  // makes a screen reader pronounce it with an English voice.
  assert.doesNotMatch(html, /<html lang="en">/);
  assert.match(primer, /setAttribute\('lang'/, 'and the primer corrects it per language');
});

test('a blocked localStorage cannot stop the page loading', () => {
  // Private windows and locked-down TV browsers throw on access. The primer runs before anything
  // else, so an exception here would take the whole dashboard with it.
  assert.match(primer, /try \{[\s\S]*\} catch/);
});
