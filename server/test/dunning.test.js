'use strict';

/*
 * COLLECTION, AND THE ONE RULE THAT GOVERNS IT: a tenant is only ever penalised for an invoice
 * they could actually have paid.
 *
 * THE PRODUCTION FAILURE THIS FILE IS THE RECORD OF. The sweep asked only "is there an invoice
 * past its due date that is not paid". With no Asaas key configured, the monthly close publishes
 * the invoice row and cannot attach a charge — no charge id, no payment link, nothing sent to
 * anybody. Five days later the tenant was suspended for a debt that had never left the building.
 * Two live tenants sat in that state across six invoices totalling R$2.400, one of them the
 * operator's own workspace.
 *
 * The second thing recorded here is that suspension has TWO stages, because the two levers cost
 * the customer very different things:
 *
 *   +5 days   the panel refuses writes; the screens keep playing what is already published
 *   +10 days  the screens stop too
 *
 * And the third is that the enforcement is real. checkActiveSubscription had existed, correct
 * and exported, since the billing work landed, and was mounted on precisely zero routes.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-dunning-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const invoicing = require('../services/tenant-invoicing');

let seq = 0;
function mkWorkspace(planId) {
  const id = `ws-dun-${++seq}`;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-dun','dun@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-dun','O','u-dun')").run();
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,plan_id) VALUES (?,?,?,?,?)')
    .run(id, 'o-dun', id, 'u-dun', planId);
  return id;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* An invoice the customer was actually handed: it has somewhere to pay. */
function payableInvoice(ws, dueDaysAgo, id = `inv-${ws}`, month = '2026-04') {
  db.prepare(`INSERT INTO workspace_invoices
                (id, workspace_id, month, plan_id, amount_cents, due_date, status, invoice_url)
              VALUES (?, ?, ?, 'pro', 40000, ?, 'open', ?)`)
    .run(id, ws, month, daysAgo(dueDaysAgo), `https://pay.example/${id}`);
  return id;
}

/* An invoice the SYSTEM failed to issue: published, overdue, and impossible to settle. */
function unpayableInvoice(ws, dueDaysAgo, id = `inv-${ws}`) {
  db.prepare(`INSERT INTO workspace_invoices
                (id, workspace_id, month, plan_id, amount_cents, due_date, status)
              VALUES (?, ?, '2026-04', 'pro', 40000, ?, 'open')`)
    .run(id, ws, daysAgo(dueDaysAgo));
  return id;
}

const statusOf = (ws) => db.prepare('SELECT subscription_status s FROM workspaces WHERE id = ?').get(ws).s;

/* ────────────────────────────────────────────────────── the rule */

test('an invoice with no payment link never suspends anyone, however old', () => {
  /*
   * THE BUG, PINNED. 60 days past due is twelve times the grace period — and it still must not
   * cost the tenant anything, because nobody ever sent them a bill. If this test ever goes green
   * by suspending, six months of silently uncollected invoices become six months of dark screens.
   */
  const ws = mkWorkspace('pro');
  unpayableInvoice(ws, 60);

  invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'active',
    'a bill the system could not issue is the system’s problem, not the customer’s');
});

test('the same invoice, once it has somewhere to pay, does suspend', () => {
  // The control for the test above: the ONLY difference is the payment link.
  const ws = mkWorkspace('pro');
  payableInvoice(ws, 60);

  invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'cut');
});

/* ────────────────────────────────────────────────────── the two stages */

test('six days past due suspends the panel and leaves the screens alone', () => {
  const ws = mkWorkspace('pro');
  payableInvoice(ws, 6);

  const r = invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'suspended');
  assert.equal(r.cut, 0, 'six days is stage one only');
});

test('eleven days past due cuts everything', () => {
  const ws = mkWorkspace('pro');
  payableInvoice(ws, 11);

  invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'cut');
});

test('four days past due is still inside the grace period', () => {
  const ws = mkWorkspace('pro');
  payableInvoice(ws, 4);

  invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'active');
});

test('a cut tenant does not step back up to suspended while anything is still owed', () => {
  /*
   * Two invoices: one old enough to cut, one only old enough to suspend. Settling the OLD one
   * leaves a debt that is six days past due — which on its own would be stage one. Stepping the
   * screens back on at that moment reads to the customer as "paid up", and the next sweep would
   * take them out again the moment the remaining invoice aged five more days. Recovery from CUT
   * happens in one move, when nothing payable is outstanding at all.
   */
  const ws = mkWorkspace('pro');
  // Different months: UNIQUE(workspace_id, month) is one invoice per month, by design.
  payableInvoice(ws, 20, 'inv-old', '2026-03');
  payableInvoice(ws, 6, 'inv-new', '2026-04');

  invoicing.enforceSuspensions();
  assert.equal(statusOf(ws), 'cut');

  db.prepare("UPDATE workspace_invoices SET status = 'paid' WHERE id = 'inv-old'").run();
  invoicing.enforceSuspensions();
  assert.equal(statusOf(ws), 'cut', 'still owing: no partial recovery');

  db.prepare("UPDATE workspace_invoices SET status = 'paid' WHERE id = 'inv-new'").run();
  invoicing.enforceSuspensions();
  assert.equal(statusOf(ws), 'active', 'nothing owed: back in, in one move');
});

/* ────────────────────────────────────────────────────── voiding */

test('voiding an invoice restores access and stops it being chargeable', () => {
  const ws = mkWorkspace('pro');
  const id = payableInvoice(ws, 30);
  invoicing.enforceSuspensions();
  assert.equal(statusOf(ws), 'cut');

  assert.equal(invoicing.voidInvoice(id, 'test'), true);
  invoicing.enforceSuspensions();

  assert.equal(statusOf(ws), 'active');
  assert.equal(db.prepare('SELECT status FROM workspace_invoices WHERE id = ?').get(id).status, 'void');
});

test('a paid invoice cannot be voided — the money is already in', () => {
  const ws = mkWorkspace('pro');
  const id = payableInvoice(ws, 30);
  db.prepare("UPDATE workspace_invoices SET status = 'paid' WHERE id = ?").run(id);

  assert.equal(invoicing.voidInvoice(id, 'test'), false);
  assert.equal(db.prepare('SELECT status FROM workspace_invoices WHERE id = ?').get(id).status, 'paid');
});

test('the row survives voiding, because a month that vanishes gets published again', () => {
  /*
   * Deleting would be tidier and worse: closeDueMonths() looks back three months asking "is there
   * a closed month I have not invoiced", so a deleted row is indistinguishable from a month that
   * was never closed and the next tick simply re-publishes it.
   */
  const ws = mkWorkspace('pro');
  const id = payableInvoice(ws, 30);
  invoicing.voidInvoice(id, 'test');

  const row = db.prepare('SELECT * FROM workspace_invoices WHERE id = ?').get(id);
  assert.ok(row, 'the evidence behind the number stays on the books');
  assert.equal(row.amount_cents, 40000);
});

/* ────────────────────────────────────────────────────── exemption */

test('an invoice written before an exemption is never charged afterwards', async () => {
  /*
   * closeMonthFor re-enters an existing row every tick to retry a charge that failed. It checked
   * billability only when CREATING the row — so a workspace marked exempt afterwards still had
   * every past open invoice armed to fire the instant an Asaas key appeared. That is exactly the
   * shape of the six uncollected invoices sitting in production: turn the key on, and they all
   * become real charges against the operator's own workspace.
   */
  const ws = mkWorkspace('pro');
  payableInvoice(ws, 30, 'inv-exempt');
  db.prepare("UPDATE workspace_invoices SET invoice_url = NULL WHERE id = 'inv-exempt'").run();
  db.prepare("UPDATE workspaces SET billing_type = 'internal' WHERE id = ?").run(ws);

  const row = await invoicing.closeMonthFor(ws, '2026-04');

  assert.equal(row.asaas_charge_id, null, 'an exempt workspace is not charged for its history');
});
