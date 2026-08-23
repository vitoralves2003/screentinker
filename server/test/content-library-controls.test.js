'use strict';

/*
 * Two controls left the library, and one arrived.
 *
 * GONE: the "show expired" toggle, and the folder move in the batch bar.
 * ARRIVED: adding the selected files to a playlist.
 *
 * These are UI-shape checks, which are weak on their own — they prove a control is absent, not
 * that the behaviour behind it is right. The behaviour lives in playlist-items-batch.test.js and
 * content-expiry-not-customer-editable.test.js. What this file catches is the removal quietly
 * regressing, or the listing going back to hiding expired files by default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const web = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', 'js', ...p), 'utf8');
const library = web('views', 'content-library.js');
const apiClient = web('api.js');

test('expired files are always listed, with no toggle to turn them off', () => {
  /*
   * A file hidden from its own library because it stopped playing is the one file its owner most
   * needs to see. The flag is gone rather than pinned to true, so nothing can set it back.
   */
  assert.doesNotMatch(library, /showExpiredToggle/, 'the checkbox must be gone');
  assert.doesNotMatch(library, /state\.showExpired/, 'and so must the state behind it');
  assert.match(library, /api\.getContent\([^,]+, true, \{/, 'the listing always asks for expired items');
});

test('the folder move is gone from the batch bar', () => {
  // One folder exists — the library you are looking at — so the control could only be clicked by
  // mistake. The endpoint and tables underneath are dormant, not removed.
  assert.doesNotMatch(library, /batchMoveFolder/);
  assert.doesNotMatch(library, /batchMoveContent/);
  assert.doesNotMatch(apiClient, /batchMoveContent/, 'the client method goes with it');
});

test('the batch bar can add the selection to several playlists at once', () => {
  assert.match(library, /id: 'add-to-playlist'/);
  assert.match(library, /api\.batchAddPlaylistItems\(chosen, ids\)/, 'through the batch endpoint, not a loop');
  assert.match(apiClient, /batchAddPlaylistItems: \(playlistIds, contentIds\)/);
  assert.match(apiClient, /playlist_ids: playlistIds/, 'the lists travel as a set, in one request');
});

test('ticking a list keeps the picker open and the earlier ticks intact', () => {
  /*
   * Two traps in one control. Every checkbox click blurs the input, so a blur-close would shut the
   * panel on the first tick; and re-rendering the rows to update the button would fight the
   * checkbox that was just clicked. And filtering must not drop a list already chosen — if it did,
   * the count on the button and what actually gets written would disagree in silence.
   */
  const fn = library.slice(library.indexOf('async function wireAddToPlaylist'), library.indexOf('function renderBatchToolbar'));
  assert.doesNotMatch(fn, /input\.onblur/, 'closing on blur would shut the panel on the first tick');
  assert.match(fn, /addEventListener\('mousedown', onDocDown\)/, 'it closes on a click elsewhere instead');
  assert.match(fn, /const picked = new Set\(\)/, 'the chosen lists live outside the render');
  const onchange = fn.slice(fn.indexOf('results.onchange'), fn.indexOf('results.onclick'));
  assert.doesNotMatch(onchange, /render\(\)/, 'ticking must not re-render the row being ticked');
});

test('the picker fetches playlists lazily and drops the cache after a write', () => {
  /*
   * Fetching on page load would pay for a listing carrying screen counts and durations on every
   * visit to the library, most of which never open the picker. Keeping the cache after adding
   * items would then show a stale item count on the next open.
   */
  const fn = library.slice(library.indexOf('async function wireAddToPlaylist'), library.indexOf('function renderBatchToolbar'));
  assert.match(fn, /if \(!playlistCache\)/, 'fetched on first open');
  assert.match(fn, /playlistCache = null/, 'and invalidated once items are added');
});

test('the toast says the playlist still has to be published', () => {
  /*
   * Adding files marks the list draft. Without saying so, the operator adds nine files, looks at
   * a screen, sees nothing change, and concludes the feature is broken.
   */
  const pt = web('i18n', 'pt.js');
  const line = pt.split('\n').find((l) => l.includes("'content.toast.added_to_list'"));
  assert.ok(line, 'the toast string must exist');
  assert.match(line, /publique/i, 'and must tell the operator to publish');
});
