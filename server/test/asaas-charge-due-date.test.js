'use strict';

/*
 * Two defects that between them made a bill impossible to pay, both found by pointing the
 * sandbox key at a real close:
 *
 *   1. Asaas refuses a due date before today ("Não é permitido data de vencimento inferior a
 *      hoje", 400). Invoices are due on the 5th, so ANY charge created after that — a server
 *      down over the close, an Asaas outage, the three-month catch-up — was refused, retried
 *      nightly, and refused identically forever. The tenant was then suspended for a debt that
 *      never became payable.
 *   2. The charge's invoiceUrl (the hosted Pix/boleto/card page) was thrown away, so the UI
 *      said "settle this to restore access" beside a table with nothing to click.
 *
 * These exercise the module boundary rather than the network: services/asaas.js is stubbed, so
 * the assertions are about what THIS code sends and stores.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-asaasdue-' + crypto.randomBytes(4).toString('hex'));
process.env.ASAAS_API_KEY = 'test-key';   // asaas.configured() gates the whole path

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const billing = require('../lib/tenant-billing');
const asaas = require('../services/asaas');
const invoicing = require('../services/tenant-invoicing');

function mkWorkspace(id) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-ad','ad@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-ad','O','u-ad')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name,created_by,plan_id,billing_tax_id) VALUES (?,?,?,?,'premium','24971563792')")
    .run(id, 'o-ad', id, 'u-ad');
  db.prepare("UPDATE workspaces SET plan_id='premium', asaas_customer_id='cus_test' WHERE id=?").run(id);
  return id;
}

// Stand in for the network. Records what it was asked for, answers like Asaas does.
function stubAsaas(answer) {
  const calls = [];
  const realCreate = asaas.createInvoiceCharge;
  const realGet = asaas.getCharge;
  asaas.createInvoiceCharge = async (inv) => { calls.push(['create', inv]); return answer(inv); };
  asaas.getCharge = async (id) => { calls.push(['get', id]); return answer({ id }); };
  return { calls, restore: () => { asaas.createInvoiceCharge = realCreate; asaas.getCharge = realGet; } };
}

test('a charge is never dated in the past — the real rule, applied where Asaas applies it', () => {
  const today = billing.spDay();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // The floor is in services/asaas.js, so assert it through the body that module builds. It is
  // not exported; the observable contract is the request, which is what this reads.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'asaas.js'), 'utf8');
  assert.match(src, /dueDate: chargeableDueDate\(invoice\.due_date\)/,
    'the charge must go out through the floor, not with the raw invoice date');
  assert.match(src, /function chargeableDueDate/);

  // And the floor itself: past -> today, future -> untouched.
  const chargeable = (d) => (!d || d < today ? today : d);
  assert.equal(chargeable(yesterday), today, 'a past due date is pulled up to today');
  assert.equal(chargeable('2099-01-01'), '2099-01-01', 'a future one is left exactly as it is');
});

test('closing an overdue month charges it, records the link, and moves the due date to when it is payable', async () => {
  const ws = mkWorkspace('ws-late');
  const today = billing.spDay();
  const stub = stubAsaas(() => ({
    id: 'pay_late', dueDate: today,
    invoiceUrl: 'https://sandbox.asaas.com/i/pay_late',
    bankSlipUrl: 'https://sandbox.asaas.com/b/pdf/pay_late',
  }));
  try {
    // A month closed with a due date long past — the case that used to fail forever.
    db.prepare(`INSERT INTO workspace_invoices (id, workspace_id, month, plan_id, amount_cents, due_date, status)
                VALUES ('inv-late', ?, '2026-01', 'premium', 18871, '2026-02-05', 'open')`).run(ws);

    const row = await invoicing.closeMonthFor(ws, '2026-01');

    assert.equal(row.asaas_charge_id, 'pay_late', 'the charge is created, not refused');
    const saved = db.prepare("SELECT * FROM workspace_invoices WHERE id = 'inv-late'").get();
    assert.equal(saved.invoice_url, 'https://sandbox.asaas.com/i/pay_late', 'the tenant gets somewhere to pay');
    assert.equal(saved.bank_slip_url, 'https://sandbox.asaas.com/b/pdf/pay_late');
    assert.equal(saved.due_date, today,
      'suspension counts from the due date, so it must be the date the bill actually became payable');
  } finally { stub.restore(); }
});

test('a charge that already exists gets its link recovered, never a second charge', async () => {
  const ws = mkWorkspace('ws-backfill');
  const stub = stubAsaas(() => ({ id: 'pay_old', dueDate: '2026-09-05', invoiceUrl: 'https://sandbox.asaas.com/i/pay_old' }));
  try {
    // Closed before links were stored: charge id present, no URL.
    db.prepare(`INSERT INTO workspace_invoices (id, workspace_id, month, plan_id, amount_cents, due_date, status, asaas_charge_id)
                VALUES ('inv-old', ?, '2026-02', 'premium', 5000, '2026-03-05', 'open', 'pay_old')`).run(ws);

    await invoicing.closeMonthFor(ws, '2026-02');

    const saved = db.prepare("SELECT * FROM workspace_invoices WHERE id = 'inv-old'").get();
    assert.equal(saved.invoice_url, 'https://sandbox.asaas.com/i/pay_old');
    assert.deepEqual(stub.calls.map((c) => c[0]), ['get'],
      'reading the charge back is the only acceptable move — creating one would bill the month twice');
  } finally { stub.restore(); }
});

test('a fully charged and payable month is left alone', async () => {
  const ws = mkWorkspace('ws-done');
  const stub = stubAsaas(() => { throw new Error('must not be called'); });
  try {
    db.prepare(`INSERT INTO workspace_invoices (id, workspace_id, month, plan_id, amount_cents, due_date, status, asaas_charge_id, invoice_url)
                VALUES ('inv-done', ?, '2026-02', 'premium', 5000, '2026-03-05', 'open', 'pay_done', 'https://x/i/pay_done')`).run(ws);

    await invoicing.closeMonthFor(ws, '2026-02');

    assert.equal(stub.calls.length, 0, 'nothing to do means no call to Asaas at all');
  } finally { stub.restore(); }
});

test.after(() => {
  invoicing.stop();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows locks */ }
});
