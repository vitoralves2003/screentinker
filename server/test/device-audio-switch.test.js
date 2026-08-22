'use strict';

/*
 * "This screen may play sound" — the switch that replaced the volume and brightness sliders.
 *
 * The sliders asked the wrong question. A media VOLUME belongs to whoever holds the TV remote,
 * and driving it from a dashboard fights them; system brightness rode on WRITE_SETTINGS, which
 * the store build no longer requests, so on a Play-installed panel it was a control that could
 * not work at all. Whether a screen may make a sound is the business decision — a waiting room
 * cannot, an electronics shop must — and it is the only one of the three an operator needs.
 *
 * THE DESIGN DECISION THIS FILE EXISTS TO PROTECT: the switch is enforced by stamping the
 * per-item `muted` the player has always honoured, NOT by adding a field to the wire.
 *
 * Every panel in the field reads `muted` today — including the one still on 1.9.33. A new
 * `audio_enabled` in the payload would have reached only panels that updated and silently done
 * nothing on the rest, which is the worst available failure for a setting whose entire job is
 * "this screen must not make noise in a waiting room". Anyone tempted to move the logic into the
 * app should read that sentence twice.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const socketSrc = fs.readFileSync(path.join(ROOT, 'server', 'ws', 'deviceSocket.js'), 'utf8');

test('the payload carries the screen-level mute as per-item muted, not as a new field', () => {
  assert.match(socketSrc, /audio_enabled/,
    'buildPlaylistPayload must read the column');
  assert.match(socketSrc, /Number\(device\.audio_enabled\) === 0[\s\S]{0,200}muted: 1/,
    'a silenced screen must stamp muted:1 on every assignment — that is what old players honour');
});

test('the column exists and defaults to sound ON, so no existing screen goes quiet on upgrade', () => {
  const dbSrc = fs.readFileSync(path.join(ROOT, 'server', 'db', 'database.js'), 'utf8');
  assert.match(dbSrc, /ALTER TABLE devices ADD COLUMN audio_enabled INTEGER NOT NULL DEFAULT 1/,
    'default 1: a migration that silenced the fleet would be discovered by customers, not by us');
});

test('changing it re-pushes the playlist instead of waiting for the next register', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'devices.js'), 'utf8');
  /*
   * Every other field on this route reaches the panel on its next register, up to a minute away,
   * and for notes or orientation that is fine. This one is pressed BECAUSE a screen is making
   * noise it should not make, usually with someone standing in front of it.
   */
  assert.match(routeSrc, /audioChanged/,
    'the route must track whether the sound switch moved');
  assert.match(routeSrc, /audioChanged[\s\S]{0,400}queueOrEmitPlaylistUpdate/,
    'and re-push the playlist when it did');
});

test('the sliders and the device clock are gone from the device page', () => {
  const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  for (const gone of ['sysVolume', 'sysWinBrightness', 'sysBrightness', 'renderDeviceClock']) {
    assert.doesNotMatch(page, new RegExp(`\b${gone}\b`),
      `${gone} was removed; leaving it renders a control that cannot work on a store build`);
  }
  assert.match(page, /devAudioEnabled/, 'and the sound switch replaced them');
});

test('a failed save puts the switch back where it was', () => {
  const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  /*
   * A checkbox that stays where you put it while the server never heard about it is how someone
   * walks away believing a waiting room is silent.
   */
  assert.match(page, /catch \(err\) \{\s*\n\s*e\.target\.checked = !on;/,
    'the checkbox must revert when the request fails');
});

/*
 * The behavioural half. Everything above reads source; this one builds a real payload out of a
 * real database, because "the string is in the file" and "the panel is told to be quiet" are
 * different claims and only the second one matters to a waiting room.
 */
test('a silenced screen gets every item muted, and an allowed one keeps what the list said', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';

  const { db } = require('../db/database');
  // buildPlaylistPayload is attached to the module only once setupDeviceSocket has run, so the
  // namespace stub below is the cheapest way to reach the function the fleet actually receives.
  require('../ws/deviceSocket')({
    of: () => ({ on() {}, adapter: { rooms: new Map() }, to: () => ({ emit() {} }) }),
  });
  const { buildPlaylistPayload } = require('../ws/deviceSocket');

  db.prepare("INSERT INTO users (id,email,password_hash,name) VALUES ('u1','a@b.c','x','A')").run();
  // Item 2 is muted in the list itself: per-item mute must survive underneath the screen switch.
  const snapshot = JSON.stringify([
    { id: 1, content_id: 'c1', muted: 0 },
    { id: 2, content_id: 'c2', muted: 1 },
  ]);
  db.prepare("INSERT INTO playlists (id,user_id,name,published_snapshot) VALUES ('p1','u1','t',?)").run(snapshot);
  db.prepare("INSERT INTO devices (id,name,playlist_id,audio_enabled) VALUES ('loud','Loud','p1',1)").run();
  db.prepare("INSERT INTO devices (id,name,playlist_id,audio_enabled) VALUES ('quiet','Quiet','p1',0)").run();

  assert.deepEqual(
    buildPlaylistPayload('loud').assignments.map((a) => a.muted), [0, 1],
    'a screen allowed to speak plays the list exactly as authored',
  );
  assert.deepEqual(
    buildPlaylistPayload('quiet').assignments.map((a) => a.muted), [1, 1],
    'a silenced screen mutes everything — the switch can only ever ADD silence',
  );

  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
