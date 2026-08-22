'use strict';

/*
 * One Save for the device page.
 *
 * It had three. "Aplicar" wrote the layout, "Salvar zonas" wrote the zone map, and "Salvar
 * configurações" wrote everything else — and each reached the wall on its own. A screen could
 * therefore sit in front of customers wearing a freshly chosen two-zone layout with nothing in
 * either zone, because the operator was still halfway through deciding.
 *
 * Nothing leaves this page until the button is pressed, and then all of it does.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

test('the two extra save buttons are gone', () => {
  assert.doesNotMatch(page, /applyLayoutBtn/, 'choosing a layout is half a decision, not an action');
  assert.doesNotMatch(page, /saveZonesBtn/, 'the zone map is part of the same decision');
  assert.match(page, /saveNotesBtn/, 'and one button remains to write all of it');
});

test('the zone fields come from the layout CHOSEN, not the one saved', () => {
  /*
   * This is what let "Aplicar" disappear. Asking the DEVICE for its zones only ever answers for
   * the layout it already has, so the fields could not appear until something had been written —
   * which is exactly the premature write being removed. Asking the LAYOUT answers for whatever was
   * just picked in the select, with nothing persisted.
   */
  assert.match(page, /api\.getLayout\(layoutId\)/,
    'a newly picked layout must be read by id, not inferred from the device');
  assert.match(page, /renderZoneFields\(e\.target\.value \|\| null\)/,
    'and changing the select must redraw the fields immediately');
});

test('switching layout and back does not silently empty the fields', () => {
  /*
   * Zone ids survive a layout change when the same layout comes back, so a list already mapped to
   * a zone is carried across rather than reset. Without this, an operator comparing two layouts
   * loses their work by looking.
   */
  assert.match(page, /const previous = new Map\(\(saved\.zones \|\| \[\]\)\.map/);
  assert.match(page, /playlist_id: previous\.get\(z\.id\) \|\| null/);
});

test('THE ORDER: layout is written before the zones that depend on it', () => {
  /*
   * The zones route validates every zone id against the device's CURRENT layout_id. Writing the
   * zone map first would have every zone of a freshly chosen layout rejected as unknown — and the
   * failure would look like the zone map being broken rather than the sequence being wrong.
   */
  const save = page.slice(page.indexOf("document.getElementById('saveNotesBtn')"));
  const layoutAt = save.indexOf('layout_id: layoutSel.value');
  const zonesAt = save.indexOf('api.setDeviceZones');
  assert.ok(layoutAt >= 0 && zonesAt >= 0, 'the save must write both');
  assert.ok(layoutAt < zonesAt, 'layout first, always');
});

test('deferring the write comes with a way to notice you have not saved', () => {
  /*
   * Deferring fixes one way of being surprised and creates another: configure, walk away, and
   * nothing happened. Swapping "applies instantly" for "waits for Save" without this is just
   * trading one silent failure for a quieter one.
   */
  assert.match(page, /let deviceFormDirty = false;/);
  assert.match(page, /unsavedHint/, 'a label beside the button');
  assert.match(page, /addEventListener\('beforeunload'/, 'and a prompt on leaving the page');
  assert.match(page, /clearDirty\(\);/, 'cleared once the save succeeds — and only then');
});

test('Substituir tela uses the pairing modal, not a browser prompt', () => {
  /*
   * It was prompt(): an unstyled box with no validation, for an operation that moves a screen's
   * identity, content and licence onto different hardware. It is the same six-digit field as Add
   * Display and now looks like it.
   */
  assert.doesNotMatch(page, /prompt\(t\('device\.replace\.prompt'/, 'the browser prompt is gone');
  assert.match(page, /replaceDeviceModal/);
  const idx = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  assert.match(idx, /id="replaceCodeInput"[^>]*class="pairing-input"/,
    'same six-digit input class as pairing, so nobody learns a second way to type a code');
  assert.doesNotMatch(idx.slice(idx.indexOf('id="replaceDeviceModal"'), idx.indexOf('id="addDeviceModal"')),
    /deviceNameInput|display_name/,
    'and NO name field: the screen already has a name, and keeping it is the whole point');
});
