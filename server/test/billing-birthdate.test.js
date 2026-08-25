'use strict';

/*
 * NOBODY IS BILLED FOR A MONTH THEY DID NOT EXIST IN.
 *
 * FOUND IN PRODUCTION, on a real customer, four hours after he signed up. He registered at 19:47,
 * chose Corporativo, and by the next tick held three invoices of R$400 — for May, June and July.
 * His account was hours old and had never held a single screen.
 *
 * The mechanism is the billing FLOOR doing exactly what it was designed to do, in a case nobody
 * had checked it against. computeInvoice walks every calendar day and charges
 * max(peak_devices, min_devices); with no licence rows at all, every day of the month costs the
 * 20-screen minimum. That is the right answer for "a customer who committed to a minimum and ran
 * nothing this month" and an absurd one for "a month before the customer existed" — and
 * closeDueMonths deliberately looks three months back to catch up after an outage, so every new
 * Corporativo signup was born owing R$1.200.
 *
 * It had done no damage only because no charge could be issued: the Asaas key is empty, so the
 * invoices sat unsent. The moment that key is configured, this bills a real person, in full, for
 * the crime of being new.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-birth-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const billing = require('../lib/tenant-billing');

let seq = 0;
/* `bornAt` is a São Paulo wall-clock date, because that is the calendar billing runs on. */
function mkWorkspace(planId, bornAt) {
  const id = `ws-birth-${++seq}`;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-b','b@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-b','O','u-b')").run();
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,plan_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'o-b', id, 'u-b', planId, Math.floor(Date.parse(bornAt) / 1000));
  return id;
}

const seed = (ws, month, from, to, screens) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?,?,?)');
  for (let d = from; d <= to; d++) stmt.run(ws, `${month}-${String(d).padStart(2, '0')}`, screens);
};

test('a month that ended before the tenant existed is never billed', () => {
  /*
   * THE EXACT PRODUCTION SHAPE. Corporativo, created in August, and the close asks about July.
   * Without the guard the 20-screen floor answers R$400 for a workspace that did not exist.
   */
  const ws = mkWorkspace('corporate', '2026-08-25T19:47:00-03:00');

  assert.equal(billing.computeInvoice(ws, '2026-07'), null);
  assert.equal(billing.computeInvoice(ws, '2026-06'), null);
  assert.equal(billing.computeInvoice(ws, '2026-05'), null);
});

test('the floor still bills a tenant who WAS there and ran nothing', () => {
  /*
   * The control, and the reason the guard is on the birth date rather than on "has no rows".
   * Committing to a minimum means paying it in a quiet month — that is what a minimum is. Erasing
   * that would turn a fix for one customer into silent under-billing for every other.
   */
  const ws = mkWorkspace('corporate', '2026-05-01T00:00:00-03:00');

  const inv = billing.computeInvoice(ws, '2026-07');
  assert.ok(inv, 'um tenant que existia no mês deve o piso');
  assert.equal(inv.amount, 400);
  assert.equal(inv.avg_screens, 20, 'o piso de 20 telas, todos os dias do mês');
});

test('the month of signup itself is billed, and only for the days that happened', () => {
  /*
   * The guard compares MONTHS, not days, on purpose: somebody who signs up on the 20th genuinely
   * owes that month, and the proration already handles it from the days that have rows. Refusing
   * the signup month outright would hand every new customer a free first month.
   */
  const ws = mkWorkspace('premium', '2026-07-20T10:00:00-03:00');
  seed(ws, '2026-07', 20, 31, 4);          // 12 days of 4 screens in a 31-day month

  const inv = billing.computeInvoice(ws, '2026-07');
  assert.ok(inv, 'o mês da assinatura é cobrado');
  assert.equal(inv.license_days, 48);
  // 48/31 x R$25 = R$38,71 — the proration, not a whole month.
  assert.equal(inv.amount, 38.71);
});

test('the creation date cannot go missing, which is what makes the guard safe', () => {
  /*
   * The guard reads the row and then its created_at, and bills when either is absent — it fails
   * OPEN, because not knowing when a tenant appeared must never silently forgive a debt.
   *
   * That branch is unreachable, and this asserts WHY: workspaces.created_at is NOT NULL and
   * SQLite refuses the write. The guarantee lives in the schema, so it is the schema that is
   * pinned here. A migration that quietly dropped the constraint would leave the fail-open
   * fallback as the only thing standing between a corrupt row and a customer billed for months
   * before they existed — or, worse, one never billed at all.
   */
  const ws = mkWorkspace('corporate', '2026-05-01T00:00:00-03:00');
  assert.throws(
    () => db.prepare('UPDATE workspaces SET created_at = NULL WHERE id = ?').run(ws),
    /NOT NULL/i,
  );
});
