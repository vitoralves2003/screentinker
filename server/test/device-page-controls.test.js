'use strict';

/*
 * What the device page offers, and what it deliberately no longer does.
 *
 * Each removal below was decided after reading what the control actually did, because several of
 * them did not do what their label claimed. The reasons are recorded here rather than in a commit
 * message alone: the next person to look at this page will see gaps where obvious features should
 * be, and without this file the natural move is to put them back.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

test('BLOCK is gone from the page, and only from the page', () => {
  /*
   * devices.blocked is refused on the next register — but the refusal keys on device_id,
   * fingerprint and token, and a factory reset changes all three. The panel returns as a stranger
   * and the block never reaches it. As a security control it was theatre; the one honest use left,
   * a panel reconnecting in a loop, is handled without anyone pressing anything by lib/flap-limiter
   * and lib/reconnect-throttle.
   */
  assert.doesNotMatch(page, /blockDeviceBtn/, 'the button and its handler are both gone');

  const routes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'devices.js'), 'utf8');
  assert.match(routes, /UPDATE devices SET blocked = 1/,
    'the lever itself STAYS — routes/devices.js documents an outage procedure that uses it');
  const socket = fs.readFileSync(path.join(ROOT, 'server', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(socket, /operator block/, 'and the socket still enforces it for whoever sets it');
});

test('the device-owner QR is offered only where enrolment is actually possible', () => {
  /*
   * This started as "remove it, device owner is out of scope" and changed on the evidence.
   *
   * STPolicy.canInstallSilently() is `isDeviceOwner() || delegated install scope`. Without it,
   * PackageInstaller returns STATUS_PENDING_USER_ACTION and the app has to launch a confirmation
   * dialog — somebody must tap "Install" ON THE TELEVISION for every app update. At three screens
   * that is an inconvenience; at thirty in thirty shops it is thirty journeys.
   *
   * That is a different question from kiosk, which stays out of scope. So the QR is not gone, it
   * MOVED to the two moments it can be acted on: adding a screen and replacing one. Both of those
   * are a fresh or factory-reset panel, which is the only state Android accepts device-owner
   * provisioning in. On an already-paired screen it was a button leading nowhere, and there it
   * stays removed.
   */
  const idx = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  assert.match(idx, /id="deviceOwnerQrBtn"/, 'Add Display keeps it');
  assert.match(idx, /id="replaceOwnerQrBtn"/, 'Replace device keeps it, for the same reason');

  /*
   * And it is NOT a standing control on the device page: the only reference left is the one the
   * replace modal uses. A second entry point from a page about an already-running screen is the
   * dead end that was removed.
   */
  assert.doesNotMatch(page, /id="deviceOwnerBtn"/,
    'the device page must not offer enrolment for hardware that is already paired');
});

test('the now-playing line is gone, and its socket subscription with it', () => {
  /*
   * It printed data.current_content_id RAW: a screen showing the clock widget reported
   * "Reproduzindo: a31d4418-0346-48ba-ac3f-0de908814b6b" in the most prominent spot on the page.
   *
   * Removed rather than repaired: Pré-visualização shows what the screen SHOULD play and Captura
   * shows what it IS playing, which answers the question better than any line of text.
   */
  assert.doesNotMatch(page, /nowPlayingInfo/, 'the element is gone');
  assert.doesNotMatch(page, /now_playing_id/, 'and the string that formatted a raw id with it');
  /*
   * The subscription matters as much as the element. `on('playback-state', null)` would register a
   * null listener that the matching off() could never find — a leak on every page visit.
   */
  assert.doesNotMatch(page, /on\('playback-state'/, 'nothing subscribes to it any more');
  assert.doesNotMatch(page, /let playbackHandler/, 'and the handler variable is gone too');
});

test('clearing the staged update cache left the dashboard but not the product', () => {
  // Once-a-year support tool for a panel holding a download that cannot install. The command still
  // exists and is still reachable through the API; it just stopped occupying an operator control.
  assert.doesNotMatch(page, /clearUpdateCacheBtn/);
  const caps = require('../lib/player-capabilities');
  assert.ok(caps.COMMAND_CAPABILITY.clear_update_cache,
    'the command must stay in the vocabulary, or the API loses it as a side effect of a UI tidy-up');
});

test('four controls remain, and each one does something on this fleet', () => {
  for (const id of ['devicePreviewBtn', 'screenshotBtn', 'launchAppBtn', 'forceUpdateBtn']) {
    assert.match(page, new RegExp(`id="${id}"`), `${id} must still be offered`);
  }
});

test('preview and capture are kept as a PAIR, because they disagree usefully', () => {
  /*
   * They look like duplicates and are opposites. Preview runs the web player in an iframe in the
   * operator's own browser and never touches the panel — zero cost to the device. Capture asks the
   * panel to photograph its own screen, which costs it real work.
   *
   * One shows what the screen SHOULD be showing, the other what it IS showing. When they disagree,
   * that difference is the diagnosis. Folding them into one control would remove the comparison,
   * and the cheaper of the two for the device is the one that looks redundant.
   */
  assert.match(page, /src="\/player\?preview=1&device=/,
    'preview must stay client-side; the moment it asks the panel for anything it stops being free');
  assert.match(page, /screenshotBtn/, 'and capture must stay, or nothing reports the real screen');
});

test('"Iniciar player" is called what it does', () => {
  // It starts nothing — it re-opens an activity that is already running. The old label read as
  // "this screen is stopped" to someone looking at a screen that plainly was not.
  assert.doesNotMatch(page, /device\.ctl\.launch_player/);
  assert.match(page, /device\.ctl\.restart_app/);
  const pt = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'pt.js'), 'utf8');
  // Either quote style: this file carries both, and JSON.stringify emits double quotes for the
  // several locales whose translation contains an apostrophe.
  assert.match(pt, /'device\.ctl\.restart_app': ['\"]Reiniciar aplicativo['\"]/);
});
