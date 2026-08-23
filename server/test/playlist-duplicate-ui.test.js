'use strict';

/*
 * Duplicate is reachable from both places it was asked for: the bulk bar on the playlist index,
 * and the header inside a playlist. The behaviour is covered by playlist-duplicate.test.js; what
 * this catches is an entry point quietly disappearing, and the two mistakes that would make the
 * feature feel broken rather than fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const web = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', 'js', ...p), 'utf8');
const view = web('views', 'playlists.js');
const apiClient = web('api.js');
const pt = web('i18n', 'pt.js');

test('the bulk bar can duplicate the selected playlists', () => {
  const bar = view.slice(view.indexOf('function renderPlaylistBulkBar'), view.indexOf('async function showAddItemModal'));
  assert.match(bar, /id: 'duplicate'/);
  assert.match(bar, /api\.duplicatePlaylist\(id\)/);
  assert.match(apiClient, /duplicatePlaylist: \(id\)/);
});

test('duplicate sits before delete, so the destructive button stays last', () => {
  // Position is the guard against a mis-click: the button people press by accident should not be
  // the one that deletes several playlists.
  const bar = view.slice(view.indexOf('function renderPlaylistBulkBar'), view.indexOf('async function showAddItemModal'));
  assert.ok(bar.indexOf("id: 'duplicate'") < bar.indexOf("id: 'delete'"));
});

test('the bulk duplicate does not ask for confirmation', () => {
  /*
   * Nothing is destroyed and every copy lands as a draft on no screen. A confirmation on a
   * harmless action is how people learn to click through the one on delete.
   */
  const bar = view.slice(view.indexOf('function renderPlaylistBulkBar'), view.indexOf('async function showAddItemModal'));
  const dup = bar.slice(bar.indexOf("id: 'duplicate'"), bar.indexOf("id: 'delete'"));
  assert.doesNotMatch(dup, /confirm: true/);
});

test('the playlist page has its own duplicate button, which opens the copy', () => {
  /*
   * Staying on the original leaves the operator looking at an unchanged page wondering whether
   * anything happened — and the reason to duplicate is nearly always to edit the copy.
   */
  assert.match(view, /id="duplicatePlaylistBtn"/);
  const handler = view.slice(view.indexOf("getElementById('duplicatePlaylistBtn')"), view.indexOf("getElementById('deletePlaylistBtn')"));
  assert.match(handler, /api\.duplicatePlaylist\(playlist\.id\)/);
  assert.match(handler, /window\.location\.hash = `#\/playlists\/\$\{copy\.id\}`/, 'it must navigate to the copy');
});

test('both messages say the copy is a draft', () => {
  /*
   * Otherwise the copy looks finished, nobody publishes it, and the screens keep showing the
   * original — which reads as the duplicate having silently failed.
   */
  for (const key of ['playlist.toast.duplicated', 'playlist.bulk_duplicated_other']) {
    const line = pt.split('\n').find((l) => l.includes(`'${key}'`));
    assert.ok(line, `${key} must exist`);
    assert.match(line, /rascunho/i, `${key} must say the copy is a draft`);
  }
});
