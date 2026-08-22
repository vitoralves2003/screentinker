'use strict';

/*
 * The four colours, resolved from a real database rather than from the pure function.
 *
 *   healthy  green   heard from within 5 minutes
 *   idle     amber   silent for 5, or reconnecting in a loop
 *   offline  red     silent for 10
 *   awaiting blue    answering fine, nothing assigned to play
 *
 * lib/liveness has unit tests for the rule. This exists for the part that is not the rule: where
 * the AGE comes from. deriveLiveness is only as right as the number handed to it, and the number
 * used to come from an in-memory connection entry that is deleted the moment a socket closes —
 * which would make every disconnect instantly red and quietly undo the whole amber window.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live4-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const heartbeat = require('../services/heartbeat');

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p1','u1','Lista')").run();

function screen(id, ageSeconds, playlistId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO devices (id,name,status,last_heartbeat,playlist_id) VALUES (?,?,?,?,?)')
    .run(id, id, 'online', now - ageSeconds, playlistId || null);
}

test('the age comes from devices.last_heartbeat, with no socket in sight', () => {
  /*
   * No device is connected in this process. Under the old rule that alone meant offline for all
   * four; under this one the column decides, which is what lets a dropped panel spend five minutes
   * amber instead of going straight to red.
   */
  screen('green', 30, 'p1');
  screen('blue', 30, null);
  screen('amber', 6 * 60, 'p1');
  screen('red', 11 * 60, 'p1');

  assert.equal(heartbeat.livenessFor('green'), 'healthy');
  assert.equal(heartbeat.livenessFor('blue'), 'awaiting');
  assert.equal(heartbeat.livenessFor('amber'), 'idle');
  assert.equal(heartbeat.livenessFor('red'), 'offline');
});

test('the boundaries land on the stated minute, not near it', () => {
  screen('just-ok', 4 * 60 + 55, 'p1');
  screen('just-amber', 5 * 60 + 5, 'p1');
  screen('just-red', 10 * 60 + 5, 'p1');

  assert.equal(heartbeat.livenessFor('just-ok'), 'healthy', 'under five minutes is still green');
  assert.equal(heartbeat.livenessFor('just-amber'), 'idle');
  assert.equal(heartbeat.livenessFor('just-red'), 'offline');
});

test('a zone map counts as content, so a multi-zone screen is not called empty', () => {
  /*
   * devices.playlist_id is null on a multi-zone screen by design — the server composes from
   * device_zone_playlists instead. Reading only the column would paint every zoned screen blue
   * while it plays perfectly.
   */
  db.prepare("INSERT INTO layouts (id,user_id,name) VALUES ('lay','u1','2 zonas')").run();
  db.prepare("INSERT INTO layout_zones (id,layout_id,name,sort_order) VALUES ('z1','lay','A',0)").run();
  screen('zoned', 30, null);
  db.prepare("UPDATE devices SET layout_id = 'lay' WHERE id = 'zoned'").run();

  assert.equal(heartbeat.livenessFor('zoned'), 'awaiting', 'no zone filled yet — genuinely empty');

  db.prepare("INSERT INTO device_zone_playlists (device_id, zone_id, playlist_id) VALUES ('zoned','z1','p1')").run();
  assert.equal(heartbeat.livenessFor('zoned'), 'healthy', 'a filled zone IS content');
});

test('an unreachable screen is never described as waiting for content', () => {
  /*
   * "Waiting for content" about a panel nobody can reach sends someone to fix the wrong thing, so
   * the content lookup is skipped entirely once a screen is past the idle threshold.
   */
  screen('gone-empty', 12 * 60, null);
  assert.equal(heartbeat.livenessFor('gone-empty'), 'offline');
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
