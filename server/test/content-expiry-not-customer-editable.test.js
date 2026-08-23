'use strict';

/*
 * Expiry left the customer's file dialog and moved to Administração, because it is becoming the
 * switch that stops an unpaid file playing.
 *
 * THE BUG THIS EXISTS TO PREVENT is not the missing field — it is what the save does without it.
 * The dialog read the value as `#editExpiresAt?.value || ''`, and an absent input reads exactly
 * like a cleared one. The server treats any expires_at it receives as a change and sets
 * is_active = 1 alongside it, so hiding the control naively would have meant: a customer whose
 * content was blocked renames a file, presses Salvar, and un-blocks themselves. Nothing would
 * have errored, and no test that only checked "the field is gone" would have noticed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const library = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'content-library.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'admin.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'content.js'), 'utf8');

test('the customer dialog no longer offers an expiry control', () => {
  // Nowhere in the customer's library view, not merely nowhere in one function of it. The admin
  // page renders its own inputs under a different attribute, so this cannot collide with those.
  assert.doesNotMatch(library, /id="editExpiresAt"/, 'the input must not be rendered');
});

test('and the save never sends expires_at while the control is absent', () => {
  /*
   * The guard is a presence check, not a value read. Omitting the key is the difference between
   * "I did not touch it" and "I cleared it", and only one of those is true here.
   */
  const save = library.slice(library.indexOf("querySelector('#saveEditBtn')"));
  const sends = save.indexOf('updateData.expires_at');
  assert.ok(sends >= 0, 'the code path still exists, and must stay behind the guard');

  const guard = save.indexOf('const expiryInput = overlay.querySelector(\'#editExpiresAt\')');
  assert.ok(guard >= 0 && guard < sends, 'the write must sit inside a check that the input exists');
  assert.doesNotMatch(save, /querySelector\('#editExpiresAt'\)\?\.value/,
    'reading the missing input with ?. is what made an absent field look like a cleared one');
});

test('the server still resets is_active whenever expiry is written', () => {
  /*
   * Not a change — a pin. This coupling is the reason the guard above matters, so if it were ever
   * removed the guard would start looking like pointless ceremony and get deleted with it.
   */
  const put = server.slice(server.indexOf('if (expires_at !== undefined)'));
  assert.match(put.slice(0, 600), /updates\.push\('is_active = 1'\)/);
});

test('expiry is editable nowhere in the UI, and that is deliberate', () => {
  /*
   * It briefly had a section in Administração, added as the way back from a blocked file. That
   * was removed on purpose: no file has an expiry today, and a page whose only job is to undo a
   * state nothing produces is a page that rots unnoticed. When billing starts SETTING expiries,
   * the release path has to be built alongside it — the two belong in the same change, and
   * whoever builds one will find this test asking for the other.
   *
   * What must not drift meanwhile is expiry becoming editable by accident from the customer
   * dialog, where a save also resets is_active and would let someone un-block their own content.
   */
  assert.doesNotMatch(admin, /data-expiry-save|loadContentExpiry/,
    'the admin section is gone; re-add it together with whatever starts setting expiries');
  assert.doesNotMatch(library, /id="editExpiresAt"/,
    'and the customer dialog must still not offer it');
});
