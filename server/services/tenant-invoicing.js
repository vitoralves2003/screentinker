'use strict';

/*
 * Loop OS monthly close.
 *
 * THE CYCLE
 *   1st … last day   licence peaks accrue (lib/tenant-billing.recordDailyPeaks)
 *   last day 23:59   the month closes
 *   1st              the invoice is published with its amount, and charged in Asaas
 *   5th              it falls due
 *   10th             5 days overdue -> the workspace is suspended
 *
 * NOT A CRON THAT FIRES ON THE 1st. A single scheduled firing is a single point of failure: a
 * server that is down, or restarting, at that moment simply never bills that month and nobody
 * notices until someone reconciles by hand. Instead this asks "is there a closed month I have
 * not invoiced?" on every boot and on a daily tick, and UNIQUE(workspace_id, month) makes the
 * answer safe to act on repeatedly. Late is recoverable; skipped is not.
 *
 * THE LOCAL ROW IS WRITTEN FIRST, then the Asaas charge is attached. If Asaas is unreachable
 * the debt still exists and is visible to the operator; the next tick retries the charge. The
 * opposite order would risk charging a customer for a month with no record of why.
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
const billing = require('../lib/tenant-billing');
const asaas = require('./asaas');

// --- helpers ------------------------------------------------------------------------------

// Invoices fall due on a fixed day of the month FOLLOWING the one they cover: the month closes
// on the 1st and is due on the 5th of that same publishing month.
function dueDateFor(month) {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));            // first day of the month after `month`
  const dd = String(config.billing.dueDay).padStart(2, '0');
  return `${next.toISOString().slice(0, 7)}-${dd}`;
}

// Workspaces on a paid plan. Resolution matches lib/tenant-billing.planFor() and
// middleware/subscription.getWorkspacePlan(): workspace plan, else the OWNER's, else free.
// Getting that wrong here is a revenue leak rather than a crash — a workspace with a NULL
// plan_id shows its owner's paid plan in the UI and unlocks its features, so resolving it to
// 'free' would mean serving a paid plan that is never invoiced.
function billableWorkspaces() {
  return db.prepare(`
    SELECT w.id FROM workspaces w
    LEFT JOIN users u ON u.id = w.created_by
    JOIN plans p ON p.id = COALESCE(w.plan_id, u.plan_id, 'free')
    WHERE p.price_per_device > 0
  `).all().map((r) => r.id);
}

// Lazy for the same reason as lib/tenant-billing.js: this module is reachable from route
// requires, and a module-scope prepare would make a missing billing table an import-time crash
// in tests that inject a minimal database for something else entirely.
let _existingStmt = null;
function _existing(workspaceId, month) {
  if (!_existingStmt) _existingStmt = db.prepare('SELECT * FROM workspace_invoices WHERE workspace_id = ? AND month = ?');
  return _existingStmt.get(workspaceId, month);
}

// --- closing ------------------------------------------------------------------------------

/*
 * Close one workspace's month. Returns the invoice row, or null when there is nothing to bill.
 * Safe to call repeatedly: an already-closed month short-circuits, and a closed month whose
 * Asaas charge failed earlier is picked up and retried here.
 */
async function closeMonthFor(workspaceId, month) {
  const already = _existing(workspaceId, month);
  if (already && already.asaas_charge_id) return already;      // fully done

  let row = already;
  if (!row) {
    const computed = billing.computeInvoice(workspaceId, month);
    if (!computed) return null;                                // free tier, or nothing held

    const id = uuidv4();
    try {
      db.prepare(`
        INSERT INTO workspace_invoices
          (id, workspace_id, month, plan_id, license_days, days_in_month, avg_screens,
           price_per_device, amount_cents, currency, due_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, workspaceId, month, computed.plan_id, computed.license_days, computed.days_in_month,
             computed.avg_screens, computed.price_per_device, computed.amount_cents,
             computed.currency, dueDateFor(month));
    } catch (err) {
      // Another tick (or another process) closed it first. That is the UNIQUE constraint doing
      // its job, not an error — re-read and carry on to the charge.
      if (!/UNIQUE constraint failed/i.test(err.message)) throw err;
    }
    row = _existing(workspaceId, month);
    if (!row) return null;
    console.log(`[invoicing] ${workspaceId} ${month}: ${row.license_days} licence-days -> ${row.currency} ${(row.amount_cents / 100).toFixed(2)} due ${row.due_date}`);
  }

  // Attach the Asaas charge. A failure here leaves a published invoice with no charge, which
  // the next tick retries — the debt is recorded either way.
  if (!asaas.configured()) return row;
  try {
    const charge = await asaas.createInvoiceCharge({
      workspace_id: row.workspace_id,
      month: row.month,
      plan_name: db.prepare('SELECT display_name FROM plans WHERE id = ?').get(row.plan_id)?.display_name || row.plan_id,
      amount_cents: row.amount_cents,
      due_date: row.due_date,
      avg_screens: row.avg_screens,
      license_days: row.license_days,
    });
    db.prepare('UPDATE workspace_invoices SET asaas_charge_id = ? WHERE id = ?').run(charge.id, row.id);
    row.asaas_charge_id = charge.id;
    console.log(`[invoicing] ${workspaceId} ${month}: charge ${charge.id} created`);
  } catch (err) {
    console.warn(`[invoicing] ${workspaceId} ${month}: charge not created (${err.message}) — will retry`);
  }
  return row;
}

/*
 * Close every month that has ended and is not yet invoiced, for every billable workspace.
 *
 * Looks back a few months rather than only at the one that just ended, so an instance that was
 * off for a while catches up instead of losing the gap. Months with no licence rows compute to
 * null and cost nothing to skip.
 */
async function closeDueMonths(nowMs = Date.now(), lookback = 3) {
  const workspaces = billableWorkspaces();
  if (!workspaces.length) return { closed: 0, charged: 0 };

  // Every month strictly before the current one, most recent first.
  const months = [];
  let m = billing.previousMonth(billing.spMonth(nowMs));
  for (let i = 0; i < lookback; i++) { months.push(m); m = billing.previousMonth(m); }

  let closed = 0, charged = 0;
  for (const workspaceId of workspaces) {
    for (const month of months) {
      try {
        const before = _existing(workspaceId, month);
        const row = await closeMonthFor(workspaceId, month);
        if (!row) continue;
        if (!before) closed++;
        if (row.asaas_charge_id && !before?.asaas_charge_id) charged++;
      } catch (err) {
        console.error(`[invoicing] closing ${workspaceId} ${month} failed: ${err.message}`);
      }
    }
  }
  if (closed || charged) console.log(`[invoicing] ${closed} invoice(s) published, ${charged} charge(s) created`);
  return { closed, charged };
}

// --- suspension ---------------------------------------------------------------------------

/*
 * Suspend workspaces whose invoice has been overdue for longer than the grace period, and
 * un-suspend those that have since paid.
 *
 * Postpaid billing means the service for an unpaid month has ALREADY been delivered, so the
 * only remaining lever is the next one — hence a real cut-off rather than a banner. The grace
 * period is deliberately measured from the due date, not from the invoice date.
 */
function enforceSuspensions(nowMs = Date.now()) {
  const cutoff = new Date(nowMs - config.billing.suspendAfterDays * 86400000).toISOString().slice(0, 10);

  const overdue = db.prepare(`
    SELECT DISTINCT workspace_id FROM workspace_invoices
     WHERE status != 'paid' AND due_date IS NOT NULL AND due_date < ?
  `).all(cutoff).map((r) => r.workspace_id);

  let suspended = 0, restored = 0;
  for (const id of overdue) {
    const ws = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(id);
    if (!ws || ws.subscription_status === 'suspended') continue;
    db.prepare("UPDATE workspaces SET subscription_status = 'suspended', updated_at = strftime('%s','now') WHERE id = ?").run(id);
    suspended++;
    console.warn(`[invoicing] workspace ${id} SUSPENDED — invoice overdue past ${config.billing.suspendAfterDays} days`);
  }

  // Anything suspended with no outstanding overdue invoice has paid up: let it back in. Doing
  // this here rather than only in the webhook means a payment reconciled by any route (a manual
  // status change, a replayed webhook) restores access on the next tick.
  const stillOwing = new Set(overdue);
  for (const r of db.prepare("SELECT id FROM workspaces WHERE subscription_status = 'suspended'").all()) {
    if (stillOwing.has(r.id)) continue;
    db.prepare("UPDATE workspaces SET subscription_status = 'active', updated_at = strftime('%s','now') WHERE id = ?").run(r.id);
    restored++;
    console.log(`[invoicing] workspace ${r.id} restored — no overdue invoice`);
  }
  return { suspended, restored };
}

// --- scheduling ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
let timers = [];

async function tick() {
  try {
    await closeDueMonths();
    enforceSuspensions();
  } catch (e) {
    console.error(`[invoicing] tick failed: ${e.message}`);
  }
}

/*
 * Start the licence sampler and the daily close. Both timers are unref'd so they never hold the
 * process open, matching every other background sweep in this codebase.
 */
function start() {
  // Sample the licence peak now and on an interval. Sampling on a schedule rather than hooking
  // every device create/delete path is what makes this impossible to under-count when a new
  // path is added — see lib/tenant-billing.recordDailyPeaks.
  billing.recordDailyPeaks();
  timers.push(setInterval(() => billing.recordDailyPeaks(), config.billing.licenseSampleMs));

  // Catch up shortly after boot (not immediately — let migrations and the rest of startup
  // settle), then once a day.
  timers.push(setTimeout(tick, 60_000));
  timers.push(setInterval(tick, DAY_MS));

  for (const t of timers) t.unref?.();
  console.log(`[invoicing] tenant billing active — ${config.billing.tenantZone}, due day ${config.billing.dueDay}, suspend after ${config.billing.suspendAfterDays} days`);
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
}

module.exports = { start, stop, tick, closeDueMonths, closeMonthFor, enforceSuspensions, dueDateFor };
