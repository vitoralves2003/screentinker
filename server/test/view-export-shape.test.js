'use strict';

/*
 * Every view app.js routes to must export `render` at the TOP LEVEL.
 *
 * This exists because of a bug with no symptom worth the name. operations.js was written as
 *
 *     export const operations = { async render(app) { … }, cleanup() {} };
 *
 * while app.js does `import * as operations` and calls `operations.render(app)`. A module namespace
 * puts that object one level deeper, so `operations.render` was undefined, route() threw, and the
 * page came up COMPLETELY BLANK with the sidebar already painted — the nav highlight working, the
 * URL right, nothing in the content area. Two rounds of looking for a caching problem went by
 * before anyone suspected the export.
 *
 * The shapes are indistinguishable by eye and identical to a linter. Only the caller knows which
 * one is right, so the check belongs here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'frontend', 'js', 'app.js');
const app = fs.readFileSync(APP, 'utf8');

/* Source with comments removed, so prose about a thing is not mistaken for the thing. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

/* Every `import * as name from './views/x.js'` — the namespace form, which is the one that cares. */
function namespaceViews() {
  const out = [];
  for (const m of app.matchAll(/^import \* as (\w+) from '(\.\/views\/[^']+)';/gm)) {
    out.push({ name: m[1], file: m[2] });
  }
  return out;
}

test('app.js imports at least the views it routes to', () => {
  const views = namespaceViews();
  assert.ok(views.length >= 10, `found only ${views.length} namespace-imported views — did the import style change?`);
});

test('each one exports render at the top level, where the caller looks for it', () => {
  const broken = [];
  for (const { name, file } of namespaceViews()) {
    const p = path.join(ROOT, 'frontend', 'js', file.replace('./', ''));
    if (!fs.existsSync(p)) { broken.push(`${file}: missing`); continue; }
    const src = stripComments(fs.readFileSync(p, 'utf8'));   // a commented-out export must not count as one

    // `export function render` / `export async function render` / `export const render =`
    const hasRender = /^export\s+(async\s+)?function\s+render\b/m.test(src)
      || /^export\s+const\s+render\s*=/m.test(src);
    if (!hasRender) broken.push(`${file}: no top-level export named render`);

    /*
     * The specific trap: exporting an object that HAPPENS to be named after the view. It reads
     * correctly, it lints clean, and `<name>.render` resolves to undefined at the call site.
     */
    if (!hasRender && new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*\\{`, 'm').test(src)) {
      broken[broken.length - 1] += ` (exports an object called \`${name}\` instead — the namespace nests it)`;
    }
  }
  assert.deepEqual(broken, [], 'a view whose render is not top-level renders a blank page and logs nothing useful');
});

test('a view that declares cleanup exports it the same way', () => {
  // route() calls currentView.cleanup?.() — optional, so a missing one is fine and a NESTED one is
  // silently skipped forever, which is how a listener leak survives.
  const broken = [];
  for (const { name, file } of namespaceViews()) {
    const p = path.join(ROOT, 'frontend', 'js', file.replace('./', ''));
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    /*
     * Comments are stripped first. The word "cleanup" turns up in ordinary prose — one view has
     * "cumulative-debt cleanup tracked there" in a comment — and matching that reported a view as
     * broken for describing itself.
     */
    const code = stripComments(src);
    if (!/\bcleanup\s*[(=]/.test(code)) continue;
    const topLevel = /^export\s+(async\s+)?function\s+cleanup\b/m.test(code)
      || /^export\s+const\s+cleanup\s*=/m.test(code);
    if (!topLevel) broken.push(`${file} (${name})`);
  }
  assert.deepEqual(broken, [], 'these declare cleanup somewhere the router cannot reach it');
});
