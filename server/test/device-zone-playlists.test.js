'use strict';

/*
 * One playlist per zone.
 *
 * The old model put the zone on the playlist ITEM: a single list per screen, every item stamped
 * for a zone. Two things followed from that and both were bad. A list built for one screen could
 * not be reused anywhere else, and choosing a multi-zone layout in the dashboard showed no fields
 * at all — because there was nothing to show. The only question such a layout raises, "what goes
 * in the top strip?", had nowhere to be answered.
 *
 * The map belongs to the SCREEN. The same layout then serves many screens with different content
 * in each slot, and a list stays zone-agnostic — reusable in another zone, on another screen, at
 * the same time.
 *
 * WHAT THE PLAYER SEES DOES NOT CHANGE. ZoneManager has always grouped assignments by their
 * `zone_id`; the server now stamps that on the way out instead of reading it off the row. So this
 * reaches every panel in the field without an APK, which is the same reasoning as the sound
 * switch and worth keeping in mind before anyone moves this logic into the app.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zones-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
require('../ws/deviceSocket')({
  of: () => ({ on() {}, adapter: { rooms: new Map() }, to: () => ({ emit() {} }) }),
});
const { buildPlaylistPayload } = require('../ws/deviceSocket');

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o1','Org','u1')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('w1','o1','WS')").run();

// Two lists, neither of which knows anything about zones — that is the point.
db.prepare("INSERT INTO playlists (id,user_id,name,published_snapshot) VALUES ('top','u1','Topo',?)")
  .run(JSON.stringify([{ id: 1, content_id: 'noticia' }]));
db.prepare("INSERT INTO playlists (id,user_id,name,published_snapshot) VALUES ('main','u1','Principal',?)")
  .run(JSON.stringify([{ id: 2, content_id: 'promo' }, { id: 3, content_id: 'institucional' }]));

db.prepare("INSERT INTO layouts (id,user_id,name,workspace_id) VALUES ('lay','u1','Duas zonas','w1')").run();
db.prepare("INSERT INTO layout_zones (id,layout_id,name,sort_order) VALUES ('z-top','lay','Topo',0)").run();
db.prepare("INSERT INTO layout_zones (id,layout_id,name,sort_order) VALUES ('z-main','lay','Principal',1)").run();

db.prepare(`INSERT INTO devices (id,name,user_id,workspace_id,layout_id,status)
            VALUES ('scr','Tela','u1','w1','lay','online')`).run();

function setZones(map) {
  db.prepare("DELETE FROM device_zone_playlists WHERE device_id = 'scr'").run();
  const ins = db.prepare('INSERT INTO device_zone_playlists (device_id, zone_id, playlist_id) VALUES (?,?,?)');
  for (const [z, p] of Object.entries(map)) ins.run('scr', z, p);
}

test('each zone plays its own list, and every item carries the zone it belongs to', () => {
  setZones({ 'z-top': 'top', 'z-main': 'main' });
  const { assignments } = buildPlaylistPayload('scr');

  assert.equal(assignments.length, 3, 'one item from Topo, two from Principal');
  assert.deepEqual(
    assignments.map((a) => [a.zone_id, a.content_id]),
    [['z-top', 'noticia'], ['z-main', 'promo'], ['z-main', 'institucional']],
    'zones come out in sort_order, items in list order',
  );
});

test('the same list can run in two zones at once, because the list holds no zone', () => {
  setZones({ 'z-top': 'main', 'z-main': 'main' });
  const { assignments } = buildPlaylistPayload('scr');

  assert.equal(assignments.length, 4);
  assert.deepEqual(assignments.filter((a) => a.zone_id === 'z-top').map((a) => a.content_id),
    ['promo', 'institucional']);
  assert.deepEqual(assignments.filter((a) => a.zone_id === 'z-main').map((a) => a.content_id),
    ['promo', 'institucional']);
  // The stored snapshot must be untouched by having been stamped for a zone on the way out.
  const raw = JSON.parse(db.prepare("SELECT published_snapshot FROM playlists WHERE id = 'main'").get().published_snapshot);
  assert.ok(raw.every((i) => i.zone_id === undefined), 'stamping must not write back into the list');
});

test('an unfilled zone plays nothing rather than borrowing from a neighbour', () => {
  setZones({ 'z-main': 'main' });
  const { assignments } = buildPlaylistPayload('scr');
  assert.deepEqual([...new Set(assignments.map((a) => a.zone_id))], ['z-main']);
});

test('a screen with no zone map at all gets an empty list, not the old single playlist', () => {
  /*
   * devices.playlist_id still exists and still drives single-zone screens. On a MULTI-zone layout
   * it must not leak through: an operator who assigned per-zone lists and left one empty would
   * otherwise see the screen's old fullscreen playlist appear in every slot at once.
   */
  setZones({});
  db.prepare("UPDATE devices SET playlist_id = 'main' WHERE id = 'scr'").run();
  const { assignments } = buildPlaylistPayload('scr');
  assert.deepEqual(assignments, []);
  db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = 'scr'").run();
});

test('a single-zone layout is untouched by any of this', () => {
  db.prepare("DELETE FROM layout_zones WHERE id = 'z-top'").run();
  db.prepare("UPDATE devices SET playlist_id = 'main' WHERE id = 'scr'").run();
  setZones({ 'z-main': 'top' });

  const { assignments } = buildPlaylistPayload('scr');
  assert.deepEqual(assignments.map((a) => a.content_id), ['promo', 'institucional'],
    'one zone falls back to the screen playlist, exactly as before');
  assert.ok(assignments.every((a) => a.zone_id == null),
    'and assemblePayload still strips the zone id from a non-multi-zone layout');
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
