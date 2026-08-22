'use strict';

/*
 * Substituir tela — point an existing screen at different hardware.
 *
 * THE DEFECT THIS EXISTS FOR, measured in production before it was written:
 *
 * The device fingerprint is a SHA-256 of ANDROID_ID plus Build fields, and a factory reset
 * regenerates ANDROID_ID. Reinstalling the app keeps the fingerprint, so the socket recognises
 * the panel and reuses its row. RESETTING changes it, so the panel arrives as a stranger, gets a
 * brand-new row, and the screen the customer had configured sits offline forever beside its
 * replacement — a duplicate in the dashboard and a duplicate on the invoice, for what the
 * customer experienced as swapping a box.
 *
 * The row is therefore REUSED and the new hardware adopts its identity. Everything the operator
 * configured survives because it is never touched; the licence survives because the row is the
 * licence. A version that created a fresh row and deleted the old one would look identical in
 * the dashboard and bill twice, which is the failure these tests are pointed at.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');

/* A namespace stub that records every emit, because the ORDER of the three device events is
   load-bearing and asserting it is the only way to keep it that way. */
function makeIo() {
  const sent = [];
  const ns = {
    on() {},
    adapter: { rooms: new Map() },
    to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }),
  };
  return { io: { of: () => ns }, sent };
}

function app(io) {
  const a = express();
  a.use(express.json());
  a.set('io', io);
  // Minimal auth context: the route's own ownership check does the real work.
  a.use((req, _res, next) => {
    req.user = { id: 'u1', role: 'admin' };
    req.workspaceId = 'w1';
    next();
  });
  a.use('/api/devices', require('../routes/devices'));
  return a;
}

/*
 * The tenancy rows are created ONCE, deliberately not with INSERT OR IGNORE.
 *
 * The first version used OR IGNORE for idempotency and it cost twenty minutes: organizations
 * requires owner_user_id, the insert violated it, OR IGNORE swallowed that silently, and every
 * later statement failed on a foreign key to a row that had never been written. A seed that
 * hides its own failure reports the wrong bug.
 */
db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o1','Org','u1')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('w1','o1','WS')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('w1','u1','owner')").run();
db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p1','u1','Lista')").run();

function seed() {
  db.exec('DELETE FROM device_fingerprints; DELETE FROM devices;');

  // The configured screen whose hardware died.
  db.prepare(`INSERT INTO devices (id,name,user_id,workspace_id,playlist_id,orientation,settings_pin,
                                   device_token,status,audio_enabled)
              VALUES ('scr','Recepção','u1','w1','p1','portrait','111111','tok-old','offline',0)`).run();
  db.prepare("INSERT INTO device_fingerprints (fingerprint,device_id,user_id,last_seen) VALUES ('fp-old','scr','u1',1)").run();

  // The replacement box, sitting on its pairing screen.
  db.prepare(`INSERT INTO devices (id,pairing_code,device_token,status,platform,app_version,last_heartbeat)
              VALUES ('new','654321','tok-new','online','Android 10','1.9.37', strftime('%s','now'))`).run();
  db.prepare("INSERT INTO device_fingerprints (fingerprint,device_id,last_seen) VALUES ('fp-new','new',1)").run();
}

async function post(a, url, body) {
  const server = a.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } finally { server.close(); }
}

test('the screen keeps everything and the new hardware brings only its credentials', async () => {
  seed();
  const { io, sent } = makeIo();
  const res = await post(app(io), '/api/devices/scr/replace', { pairing_code: '654321' });
  assert.equal(res.status, 200);

  const scr = db.prepare("SELECT * FROM devices WHERE id = 'scr'").get();
  // Configuration: untouched, because the row was never re-created.
  assert.equal(scr.name, 'Recepção');
  assert.equal(scr.playlist_id, 'p1');
  assert.equal(scr.orientation, 'portrait');
  assert.equal(scr.settings_pin, '111111');
  assert.equal(scr.audio_enabled, 0, 'the sound switch is configuration too');
  // Credentials and reported identity: adopted from the box that is actually there now.
  assert.equal(scr.device_token, 'tok-new');
  assert.equal(scr.app_version, '1.9.37');
  assert.equal(scr.pairing_code, null);
  assert.equal(scr.status, 'online');
  assert.ok(sent.length > 0, 'the swap must be announced');
});

test('ONE screen exists afterwards — the duplicate is what this feature is against', async () => {
  seed();
  const { io } = makeIo();
  await post(app(io), '/api/devices/scr/replace', { pairing_code: '654321' });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 1,
    'the placeholder row must be gone; two rows here is two licences on the invoice');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE id = 'new'").get().c, 0);
});

test("the new hardware's fingerprint now names the screen, so a later reinstall comes home", async () => {
  seed();
  const { io } = makeIo();
  await post(app(io), '/api/devices/scr/replace', { pairing_code: '654321' });

  const fp = db.prepare("SELECT * FROM device_fingerprints WHERE fingerprint = 'fp-new'").get();
  assert.equal(fp.device_id, 'scr', 'without this the next reinstall provisions a third row');
  assert.equal(fp.user_id, 'u1');
});

test('the old panel is told first, and the incoming one never hears "unpaired"', async () => {
  seed();
  const { io, sent } = makeIo();
  await post(app(io), '/api/devices/scr/replace', { pairing_code: '654321' });

  /*
   * Order is the whole point. Once the new hardware adopts scr it joins that room, and a
   * broadcast to scr would then reach it too — "you are unpaired" is the one message the
   * incoming panel must never see.
   */
  const unpaired = sent.findIndex((e) => e.event === 'device:unpaired');
  const registered = sent.findIndex((e) => e.event === 'device:registered');
  const paired = sent.findIndex((e) => e.event === 'device:paired');

  assert.ok(unpaired >= 0 && registered >= 0 && paired >= 0, 'all three events must be sent');
  assert.equal(sent[unpaired].room, 'scr', 'the unpair goes to the OLD hardware');
  assert.ok(unpaired < registered, 'and it goes out before the new panel adopts that room');
  assert.ok(registered < paired,
    'device:registered is what makes the app persist the new id; device:paired then takes it off the pairing screen');
  assert.equal(sent[registered].payload.device_id, 'scr');
  assert.equal(sent[paired].payload.settings_pin, '111111', 'the PIN is the screen’s, not the box’s');
});

test('a code that belongs to somebody else’s screen is refused, not swallowed', async () => {
  seed();
  // The replacement box is in fact already a live screen elsewhere.
  db.prepare("UPDATE devices SET user_id = 'u1', workspace_id = 'w1', name = 'Vitrine' WHERE id = 'new'").run();

  const { io } = makeIo();
  const res = await post(app(io), '/api/devices/scr/replace', { pairing_code: '654321' });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /Vitrine/, 'naming the screen is what makes a mistyped code obvious');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 2, 'and nothing was deleted');
});

test('replacing a screen with its own code is refused', async () => {
  seed();
  db.prepare("UPDATE devices SET pairing_code = '999999' WHERE id = 'scr'").run();
  db.prepare("DELETE FROM devices WHERE id = 'new'").run();

  const { io } = makeIo();
  const res = await post(app(io), '/api/devices/scr/replace', { pairing_code: '999999' });
  assert.equal(res.status, 400);
});

test('an unknown code changes nothing', async () => {
  seed();
  const { io } = makeIo();
  const res = await post(app(io), '/api/devices/scr/replace', { pairing_code: '000000' });
  assert.equal(res.status, 404);
  assert.equal(db.prepare("SELECT device_token FROM devices WHERE id = 'scr'").get().device_token, 'tok-old');
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
