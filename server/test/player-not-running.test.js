'use strict';

/*
 * "Saudável" with a black wall.
 *
 * Reported from a real panel after a power cut: the dashboard showed the screen healthy, the debug
 * log contained nothing but "Remote debug logging ON", and a screen capture returned nothing at
 * all.
 *
 * The cause is structural, not a bug in any one place. The heartbeat is sent by the WebSocket
 * FOREGROUND SERVICE; device:playback-state is sent only by the player ACTIVITY. Relauncher starts
 * the service unconditionally and then tries to start the Activity — which on Android 10 needs the
 * "display over other apps" permission, because a background receiver may not start one. Grant
 * missing: service up, player never opens, socket answers every heartbeat, dashboard reports
 * perfect health.
 *
 * The dashboard's own "Reproduzindo agora" column was already showing an em dash for that screen.
 * The data to tell the difference was arriving and nothing was using it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notplay-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const heartbeat = require('../services/heartbeat');

const now = () => Math.floor(Date.now() / 1000);

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p1','u1','Lista')").run();
db.prepare("INSERT INTO content (id,user_id,filename,filepath,mime_type) VALUES ('c','u1','a.mp4','/x','video/mp4')").run();
// 41s is the longest item — the grace window is max(10 min, 2x longest), so 10 minutes here.
db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p1','c',0,41)").run();

function screen(id, heartbeatAgeSec, playbackAgeSec) {
  db.prepare(`INSERT INTO devices (id,name,status,last_heartbeat,playlist_id,last_playback_at)
              VALUES (?,?,'online',?,'p1',?)`)
    .run(id, id, now() - heartbeatAgeSec, playbackAgeSec === null ? null : now() - playbackAgeSec);
}

test('answering but not playing is reported as offline, with the reason', () => {
  screen('stalled', 30, 20 * 60);
  const live = heartbeat.livenessDetail('stalled');

  /*
   * OFFLINE rather than idle, and it is a judgement. The panel IS reachable, so red overstates one
   * thing; but the business fact — nothing is on the wall — is identical to a dead screen, and
   * amber invites "probably fine". The reason is what tells the operator it is a permission on a
   * settings page rather than a trip to the site.
   */
  assert.equal(live.state, 'offline');
  assert.equal(live.reason, 'not_playing');
});

test('a screen that is playing is untouched', () => {
  screen('playing', 30, 60);
  assert.deepEqual(heartbeat.livenessDetail('playing'), { state: 'healthy', reason: null });
});

test('a long video is not mistaken for a dead player', () => {
  /*
   * playback-state is sent once per ITEM, so a screen showing a fifteen-minute clip legitimately
   * says nothing for fifteen minutes. A flat five- or ten-minute rule would call that panel dead
   * every time it reached its longest item — the false alarm that teaches people to ignore the
   * real one. The window is twice the longest item, floored at ten minutes.
   */
  screen('long-clip', 30, 9 * 60);
  assert.equal(heartbeat.livenessDetail('long-clip').state, 'healthy');

  db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p2','u1','Longa')").run();
  db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p2','c',0,900)").run();
  screen('movie', 30, 20 * 60);
  db.prepare("UPDATE devices SET playlist_id = 'p2' WHERE id = 'movie'").run();
  assert.equal(heartbeat.livenessDetail('movie').state, 'healthy',
    'a 15-minute item buys a 30-minute window, so 20 minutes of silence is normal');
});

test('a screen that has never reported is given the benefit of the doubt', () => {
  /*
   * NULL is "not yet", not "stale". A screen paired a moment ago has had no chance to play
   * anything, and accusing it would put a red row in front of someone mid-setup.
   */
  screen('fresh', 30, null);
  assert.equal(heartbeat.livenessDetail('fresh').state, 'healthy');
});

test('a screen with no content is called awaiting, not not-playing', () => {
  // Nothing assigned is not a fault, and the check is skipped entirely for it.
  screen('empty', 30, null);
  db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = 'empty'").run();
  assert.equal(heartbeat.livenessDetail('empty').state, 'awaiting');
});

test('a genuinely silent screen is plain offline, with no misleading reason', () => {
  // Past the 10-minute heartbeat threshold: it is down, and saying "the app is not running" about
  // a panel nobody can reach would send someone to the wrong fix.
  screen('gone', 15 * 60, 20 * 60);
  assert.deepEqual(heartbeat.livenessDetail('gone'), { state: 'offline', reason: null });
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
