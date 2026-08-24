'use strict';

/*
 * Which list a play came from.
 *
 * play_logs recorded the screen, the file, the zone and the time — never the playlist. So "what
 * did this list broadcast last week" had no answer, and the timeline could not be grouped the way
 * an operator reads it.
 *
 * THE REASON THIS LANDED BEFORE THE REPORTS THAT USE IT: history cannot be backfilled. A device's
 * playlist assignment is not versioned, so for rows written before the column the only guess
 * available is "whatever that screen runs today" — wrong for any screen reassigned since. Every
 * day without the column is a day that can never be grouped by list.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plog-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');

before(() => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('w','o','W')").run();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p1','u','w','Manhã')").run();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p2','u','w','Tarde')").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c1','u','w','a.mp4','a','video/mp4')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id) VALUES ('d1','u','w','Tela 1','p1')").run();
});

after(() => { /* the temp DATA_DIR goes with the tmp dir */ });

test('the column exists and is indexed for the query it was added for', () => {
  const cols = db.prepare('PRAGMA table_info(play_logs)').all().map((c) => c.name);
  assert.ok(cols.includes('playlist_id'), 'play_logs must carry the list');

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='play_logs'")
    .all().map((r) => r.name);
  assert.ok(idx.includes('idx_play_logs_playlist'),
    '"what did this list broadcast" is a range scan; without the index it is a table scan');
});

test('a play records the list the screen was running AT THAT MOMENT', () => {
  /*
   * Stamped on write, not joined on read. Joining devices.playlist_id at read time would mean a
   * screen reassigned next month re-attributes every play it has ever made to the new list — the
   * report would quietly rewrite its own past, and nothing would look wrong.
   */
  db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, content_name, started_at)
              VALUES ('d1','c1',(SELECT playlist_id FROM devices WHERE id='d1'),'a.mp4',1000)`).run();

  // The screen moves to another list. The play already recorded stays with the old one.
  db.prepare("UPDATE devices SET playlist_id = 'p2' WHERE id = 'd1'").run();
  db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, content_name, started_at)
              VALUES ('d1','c1',(SELECT playlist_id FROM devices WHERE id='d1'),'a.mp4',2000)`).run();

  const rows = db.prepare('SELECT playlist_id FROM play_logs ORDER BY started_at').all();
  assert.deepEqual(rows.map((r) => r.playlist_id), ['p1', 'p2'],
    'the older play must still belong to the list that was on air when it happened');
});

test('deleting a playlist does not delete the proof that it played', () => {
  /*
   * SET NULL, not CASCADE. The record that a customer's advertisement was on screen is the thing
   * being sold; it must survive somebody tidying up an old list. The row degrades to "list not
   * recorded", which is what the report already says for pre-column history.
   */
  const before = db.prepare("SELECT COUNT(*) n FROM play_logs WHERE device_id='d1'").get().n;
  db.prepare("DELETE FROM playlists WHERE id = 'p1'").run();
  const after = db.prepare("SELECT COUNT(*) n FROM play_logs WHERE device_id='d1'").get().n;
  assert.equal(after, before, 'no play may be lost');
  assert.equal(db.prepare("SELECT playlist_id FROM play_logs WHERE started_at=1000").get().playlist_id, null);
});

test('rows written before the column read as unknown, not as a plausible guess', () => {
  // A NULL here means "we do not know", and the reports must say so rather than attribute it to
  // whichever list the screen happens to run now.
  db.prepare(`INSERT INTO play_logs (device_id, content_id, content_name, started_at)
              VALUES ('d1','c1','antigo.mp4',500)`).run();
  assert.equal(db.prepare('SELECT playlist_id FROM play_logs WHERE started_at=500').get().playlist_id, null);
});

test('the write path stamps it from the device, not from the payload', () => {
  /*
   * A device could otherwise claim any playlist id and have its plays counted against another
   * customer's list. Every other field on this insert is already server-derived or validated; this
   * one has to be too.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  // A window AROUND the insert: the lookup sits on the line above it, so slicing forward from
  // the statement read a region that could never contain what this asserts.
  const at = src.indexOf('INSERT INTO play_logs');
  const insert = src.slice(Math.max(0, at - 800), at + 900);
  assert.match(insert, /_devicePlaylist\.get\(device_id\)/,
    'the list must be read from the device row, never taken from the reported payload');
  assert.doesNotMatch(insert, /playlist_id \|\| null,/,
    'no path where a device-supplied playlist_id reaches the insert');
});
