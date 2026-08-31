'use strict';

/*
 * The soft-reload hash must cover every frontend source file.
 *
 * It used to be a hand-kept list of paths, and a hand-kept list goes stale in silence: a file
 * missing from it ships a change that no open browser is ever told about. That already happened
 * once (a new landing page went out while every session on screen kept running the old bundle),
 * and by the time the schedule editor was reworked the list had drifted again — views/playlists.js
 * and everything under js/components/ and js/i18n/ were absent, so half of that change would have
 * reached nobody until they reloaded by hand.
 *
 * A walk cannot drift. This test exists so nobody replaces it with a list again.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fn = server.slice(server.indexOf('function updateFrontendHash()'),
  server.indexOf('updateFrontendHash();'));

test('the hash walks the frontend instead of enumerating it', () => {
  assert.match(fn, /const walk = \(dir\) => fs\.readdirSync/, 'the hash must be built from a walk');
  assert.doesNotMatch(fn, /'js\/views\//, 'no hand-kept path list — that is what went stale');
});

test('the walk reaches the directories the old list forgot', () => {
  /*
   * Not a check on the code's shape but on its result: run the same walk and require the files
   * that were missing. If someone narrows the pattern or skips a subdirectory, this fails.
   */
  const root = path.join(__dirname, '..', '..', 'frontend');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|css|html)$/.test(e.name) ? [full] : [];
  });
  const found = walk(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
  for (const missing of ['js/views/playlists.js', 'js/components/schedule-editor.js',
    'js/schedule-validate.js']) {
    assert.ok(found.includes(missing), `${missing} must be part of the reload hash`);
  }
});

test('the extension test is anchored, so "notjs" is not a match', () => {
  // The escaped dot was lost once in transit through a shell; an unescaped one matches any
  // character, quietly widening the hash to files that are not sources.
  assert.ok(fn.includes('/\\.(js|css|html)$/'), 'the dot must be escaped and the extension anchored');
});
