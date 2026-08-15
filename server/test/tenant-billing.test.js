'use strict';

// Loop OS tenant billing — licence-days, closed monthly, charged in arrears.
//
// The cases that matter are the ones where a plausible implementation quietly overcharges or
// undercharges a real customer:
//   - the worked example: 20 screens to the 24th, 15 after, in a 30-day month = R$475
//   - the Corporativo floor applies PER DAY, not to the month's total
//   - a day with no row still costs the floor (a plan with a minimum is owed its minimum)
//   - money is integer centavos end to end — R$475,00, never 474.99999999999994
//   - the peak is the peak: deleting a screen does not erase the day it was held
//   - the monthly close is idempotent, because it is retried on every boot and daily tick

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-tenantbill-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const billing = require('../lib/tenant-billing');
const invoicing = require('../services/tenant-invoicing');

function mkWorkspace(id, planId) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-tb','tb@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-tb','O','u-tb')").run();
  db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name,created_by,plan_id) VALUES (?,?,?,?,?)')
    .run(id, 'o-tb', id, 'u-tb', planId);
  db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run(planId, id);
  return id;
}
// Write the licence peak for a range of days directly — the same rows recordDailyPeaks writes.
function seed(workspaceId, month, fromDay, toDay, screens) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?,?,?)'
  );
  for (let d = fromDay; d <= toDay; d++) stmt.run(workspaceId, `${month}-${String(d).padStart(2, '0')}`, screens);
}

test('the worked example: 20 screens to the 24th, 15 after, 30-day month = R$475,00', () => {
  const ws = mkWorkspace('ws-example', 'premium');
  seed(ws, '2026-06', 1, 24, 20);    // June has 30 days
  seed(ws, '2026-06', 25, 30, 15);

  const inv = billing.computeInvoice(ws, '2026-06');

  // 24x20 + 6x15 = 570 licence-days over 30 days = 19 average screens
  assert.equal(inv.license_days, 570);
  assert.equal(inv.days_in_month, 30);
  assert.equal(inv.avg_screens, 19);
  assert.equal(inv.amount_cents, 47500, 'integer centavos, no float drift');
  assert.equal(inv.amount, 475);
  assert.equal(inv.currency, 'BRL');
  // Neither the full month at 20 screens nor the tail-end count.
  assert.notEqual(inv.amount, 500);
  assert.notEqual(inv.amount, 375);
});

test('a mid-month signup is prorated by construction — no special case needed', () => {
  const ws = mkWorkspace('ws-midmonth', 'premium');
  // First screen appears on the 20th of a 31-day month: 12 days x 1 screen.
  seed(ws, '2026-07', 20, 31, 1);

  const inv = billing.computeInvoice(ws, '2026-07');
  assert.equal(inv.license_days, 12);
  assert.equal(inv.days_in_month, 31);
  // 12/31 of R$25 = R$9.68
  assert.equal(inv.amount_cents, Math.round((12 * 2500) / 31));
  assert.equal(inv.amount, 9.68);
});

test('the Corporativo floor is applied PER DAY, not to the month total', () => {
  const ws = mkWorkspace('ws-floor', 'corporate');
  // 25 screens for the first half, 5 for the second — genuinely above the minimum for 15 days.
  seed(ws, '2026-06', 1, 15, 25);
  seed(ws, '2026-06', 16, 30, 5);

  const inv = billing.computeInvoice(ws, '2026-06');

  // Daily floor: 15x25 + 15xmax(5,20) = 375 + 300 = 675
  assert.equal(inv.license_days, 675);
  assert.equal(inv.amount_cents, Math.round((675 * 2000) / 30));
  assert.equal(inv.amount, 450);

  // A MONTHLY floor would have computed (375+75)/30 = 15 avg -> R$300 -> floored to R$400,
  // erasing the fortnight they ran 25 screens. That is the bug this test exists to prevent.
  assert.notEqual(inv.amount, 400);
});

test('a Corporativo month with almost no screens still owes the 20-licence minimum', () => {
  const ws = mkWorkspace('ws-min', 'corporate');
  seed(ws, '2026-06', 1, 30, 3);     // three screens all month

  const inv = billing.computeInvoice(ws, '2026-06');
  assert.equal(inv.license_days, 600, '30 days x the 20-licence floor');
  assert.equal(inv.amount, 400, 'the committed minimum: 20 x R$20');
});

test('days with no row at all still cost the floor on a plan that has one', () => {
  const ws = mkWorkspace('ws-gap', 'corporate');
  seed(ws, '2026-06', 1, 10, 30);    // rows for ten days only; nothing for the other twenty

  const inv = billing.computeInvoice(ws, '2026-06');
  // 10x30 + 20x20 = 300 + 400 = 700
  assert.equal(inv.license_days, 700);
});

test('a Premium month with no screens at all is not billed', () => {
  const ws = mkWorkspace('ws-empty', 'premium');
  assert.equal(billing.computeInvoice(ws, '2026-06'), null, 'no floor, no screens, no invoice');
});

test('the free plan is never invoiced', () => {
  const ws = mkWorkspace('ws-free', 'free');
  seed(ws, '2026-06', 1, 30, 1);
  assert.equal(billing.computeInvoice(ws, '2026-06'), null);
});

test('the peak is the peak — removing a screen does not erase the day it was held', () => {
  const ws = mkWorkspace('ws-peak', 'premium');
  db.prepare('INSERT OR REPLACE INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?,?,?)')
    .run(ws, '2026-06-01', 10);

  // A later sample that same day sees fewer screens. MAX must win, or a tenant could delete
  // screens shortly before each sample and pay for almost nothing.
  db.prepare(`
    INSERT INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?,?,?)
    ON CONFLICT(workspace_id, day) DO UPDATE SET peak_devices = MAX(peak_devices, excluded.peak_devices)
  `).run(ws, '2026-06-01', 2);

  const peak = db.prepare('SELECT peak_devices p FROM workspace_license_daily WHERE workspace_id = ? AND day = ?')
    .get(ws, '2026-06-01').p;
  assert.equal(peak, 10, 'a lower later sample must not lower the day');
});

test('invoices fall due on the 5th of the month AFTER the one they cover', () => {
  assert.equal(invoicing.dueDateFor('2026-06'), '2026-07-05');
  assert.equal(invoicing.dueDateFor('2026-12'), '2027-01-05', 'and across the year boundary');
});

test('closing a month is idempotent — it is retried on every boot and daily tick', async () => {
  const ws = mkWorkspace('ws-close', 'premium');
  seed(ws, '2026-05', 1, 31, 4);

  const first = await invoicing.closeMonthFor(ws, '2026-05');
  assert.ok(first, 'the month should close');
  assert.equal(first.amount_cents, 10000, '4 screens all month x R$25 = R$100');

  const second = await invoicing.closeMonthFor(ws, '2026-05');
  assert.equal(second.id, first.id, 'the same invoice, not a second one');

  const count = db.prepare('SELECT COUNT(*) c FROM workspace_invoices WHERE workspace_id = ? AND month = ?')
    .get(ws, '2026-05').c;
  assert.equal(count, 1, 'a retried close must never bill twice');
});

test('the month in progress reports what has accrued so far, and projects the rest', () => {
  const ws = mkWorkspace('ws-preview', 'premium');
  const month = billing.spMonth();
  const today = Number(billing.spDay().slice(8, 10));
  seed(ws, month, 1, today, 8);

  const p = billing.currentMonthPreview(ws);
  assert.equal(p.partial, true);
  assert.equal(p.days_elapsed, today);
  assert.equal(p.license_days, 8 * today);
  assert.equal(p.avg_screens, 8);
  // Holding 8 screens all month would cost 8 x R$25.
  assert.equal(p.projected_amount, 200);
});

test('the São Paulo calendar is used, not UTC', () => {
  // 2026-06-01T02:00Z is 23:00 on 31 May in São Paulo. Billing must call it May, or an invoice
  // would be published while it is still the previous month for the customer.
  const ms = Date.parse('2026-06-01T02:00:00Z');
  assert.equal(billing.spDay(ms), '2026-05-31');
  assert.equal(billing.spMonth(ms), '2026-05');
});

test('suspension waits out the grace period, and paying restores access', () => {
  const ws = mkWorkspace('ws-susp', 'premium');
  const longAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);

  db.prepare(`INSERT INTO workspace_invoices (id, workspace_id, month, plan_id, amount_cents, due_date, status)
              VALUES ('inv-susp', ?, '2026-04', 'premium', 5000, ?, 'open')`).run(ws, longAgo);

  invoicing.enforceSuspensions();
  assert.equal(db.prepare('SELECT subscription_status s FROM workspaces WHERE id = ?').get(ws).s, 'suspended');

  // Settling it lets them back in on the next sweep — without needing the webhook to also
  // flip the workspace, so a payment reconciled by any route restores access.
  db.prepare("UPDATE workspace_invoices SET status = 'paid' WHERE id = 'inv-susp'").run();
  invoicing.enforceSuspensions();
  assert.equal(db.prepare('SELECT subscription_status s FROM workspaces WHERE id = ?').get(ws).s, 'active');
});

test('an invoice inside the grace period does NOT suspend', () => {
  const ws = mkWorkspace('ws-grace', 'premium');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO workspace_invoices (id, workspace_id, month, plan_id, amount_cents, due_date, status)
              VALUES ('inv-grace', ?, '2026-04', 'premium', 5000, ?, 'open')`).run(ws, yesterday);

  invoicing.enforceSuspensions();
  assert.notEqual(db.prepare('SELECT subscription_status s FROM workspaces WHERE id = ?').get(ws).s, 'suspended',
    'one day overdue is inside the 5-day grace period');
});

test('the plans match the commercial model', () => {
  const p = (id) => db.prepare('SELECT * FROM plans WHERE id = ?').get(id);

  const free = p('free');
  assert.equal(free.max_devices, 1);
  assert.equal(free.price_per_device, 0);
  assert.equal(free.widgets_enabled, 0);

  const premium = p('premium');
  assert.equal(premium.max_devices, -1, 'Premium has no screen ceiling');
  assert.equal(premium.min_devices, 0, 'and no billing floor');
  assert.equal(premium.price_per_device, 25);
  assert.equal(premium.widgets_enabled, 1);
  assert.equal(premium.sublists_enabled, 0, 'sub-lists are Corporativo-only');

  const corp = p('corporate');
  assert.equal(corp.max_devices, -1);
  assert.equal(corp.min_devices, 20, '20-licence minimum');
  assert.equal(corp.price_per_device, 20);
  assert.equal(corp.sublists_enabled, 1);
  assert.equal(corp.layouts_enabled, 1);
});

test.after(() => {
  invoicing.stop();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows locks */ }
});
