'use strict';

/*
 * Loop OS monthly close.
 *
 * THE CYCLE
 *   1st … last day   licence peaks accrue (lib/tenant-billing.recordDailyPeaks)
 *   last day 23:59   the month closes
 *   1st              the invoice is published with its amount, and charged in Asaas
 *   5th              it falls due
 *   10th             5 days overdue -> the panel is suspended (screens keep playing)
 *   15th             10 days overdue -> cut: the screens stop too
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

// Workspaces on a paid plan, minus the ones marked exempt (lib/tenant-billing.isBillable).
// Resolution matches lib/tenant-billing.planFor() and
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
      AND COALESCE(w.billing_type, '') != ?
  `).all(billing.INTERNAL_BILLING_TYPE).map((r) => r.id);
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
  // Done means CHARGED AND PAYABLE. A row with a charge but no payment link is a bill the
  // tenant cannot act on, so it is not finished — the backfill below recovers the link.
  if (already && already.asaas_charge_id && already.invoice_url) return already;

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

  // A row that predates an exemption must not be charged by a later tick. isBillable is checked
  // when the row is CREATED; without re-checking it here, marking a workspace exempt stopped
  // future invoices and left every past one armed to fire the moment Asaas was configured.
  if (!billing.isBillable(workspaceId)) return row;
  // Nor may a voided invoice be resurrected by the retry path.
  if (row.status === 'void') return row;

  // Attach the Asaas charge. A failure here leaves a published invoice with no charge, which
  // the next tick retries — the debt is recorded either way.
  if (!asaas.configured()) return row;

  /*
   * Record what came back from Asaas.
   *
   * due_date is taken from the CHARGE, not kept as computed. Asaas will not date a charge in the
   * past, so an invoice charged late is payable from a later date than the 5th it was published
   * for — and suspension counts from the due date. Keeping the original would cut a tenant off
   * for missing a deadline that passed before they were ever given a way to pay. The date only
   * moves forward: services/asaas.js floors it at today and never earlier.
   */
  const attach = (charge) => {
    db.prepare(`UPDATE workspace_invoices
                  SET asaas_charge_id = ?, invoice_url = ?, bank_slip_url = ?,
                      due_date = COALESCE(?, due_date)
                WHERE id = ?`)
      .run(charge.id, charge.invoiceUrl || null, charge.bankSlipUrl || null, charge.dueDate || null, row.id);
    row.asaas_charge_id = charge.id;
    row.invoice_url = charge.invoiceUrl || null;
    if (charge.dueDate) row.due_date = charge.dueDate;
  };

  /*
   * The charge exists and only its link is missing — the month was closed before the link was
   * stored. Read it back rather than falling through to createInvoiceCharge(), which would bill
   * the same month twice: UNIQUE(workspace_id, month) guards the ROW, nothing guards a second
   * charge in Asaas against the same row.
   */
  if (row.asaas_charge_id) {
    if (!row.invoice_url) {
      try {
        attach(await asaas.getCharge(row.asaas_charge_id));
        console.log(`[invoicing] ${workspaceId} ${month}: payment link recovered`);
      } catch (err) {
        console.warn(`[invoicing] ${workspaceId} ${month}: payment link not recovered (${err.message}) — will retry`);
      }
    }
    return row;
  }

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
    attach(charge);
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

// --- dunning ------------------------------------------------------------------------------

/*
 * The three states a tenant's access can be in, and the ONE rule that governs all of them:
 * a tenant is only ever penalised for an invoice they could actually have paid.
 *
 * THE FAILURE THIS WAS WRITTEN AFTER. This sweep used to ask only "is there an invoice past its
 * due date that is not paid". With no Asaas key configured, closeMonthFor publishes the row and
 * cannot attach a charge — so the invoice has no payment link, nothing was ever sent to the
 * customer, and five days later they were suspended for a debt they had no way to settle. Two
 * live tenants were sitting in that state, one of them the operator's own, over six invoices
 * totalling R$2.400 that had never left the building.
 *
 * So invoice_url is now part of the definition of overdue. An invoice the system failed to issue
 * is the system's problem; only an invoice the customer was handed and ignored is theirs.
 */
const ACTIVE = 'active';
const SUSPENDED = 'suspended';
const CUT = 'cut';

/*
 * Void an invoice: it is on the books but will never be collected.
 *
 * Deleting the row would be tidier and worse. An invoice is the evidence behind a number the
 * customer may already have seen, and a month that silently vanishes is indistinguishable from a
 * month that was never closed — which is precisely the condition closeDueMonths() exists to
 * detect and repair, so the next tick would publish it all over again.
 */
function voidInvoice(invoiceId, reason) {
  const changes = db.prepare(
    "UPDATE workspace_invoices SET status = 'void' WHERE id = ? AND status != 'paid'"
  ).run(invoiceId).changes;
  if (changes) console.warn(`[invoicing] invoice ${invoiceId} voided — ${reason || 'no reason given'}`);
  return changes > 0;
}

/*
 * Workspaces holding an invoice that was PAYABLE and is older than `cutoffDay`.
 *
 * 'void' joins 'paid' in the exclusion list: both mean "this will not be collected", and a voided
 * invoice that still suspended people would defeat the whole point of voiding it.
 */
function owingSince(cutoffDay) {
  return db.prepare(`
    SELECT DISTINCT i.workspace_id FROM workspace_invoices i
      JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.status NOT IN ('paid', 'void')
       AND i.due_date IS NOT NULL AND i.due_date < ?
       AND i.invoice_url IS NOT NULL
       AND COALESCE(w.billing_type, '') != ?
  `).all(cutoffDay, billing.INTERNAL_BILLING_TYPE).map((r) => r.workspace_id);
}

/*
 * Move every tenant to the access state their oldest unpaid invoice deserves.
 *
 * Postpaid billing means the service for an unpaid month has ALREADY been delivered, so the only
 * remaining lever is the next one — hence real states rather than a banner.
 */
function enforceSuspensions(nowMs = Date.now()) {
  const dayAgo = (n) => new Date(nowMs - n * 86400000).toISOString().slice(0, 10);

  // owingCut is a strict subset of owingSuspend: its cutoff date is further in the past, so
  // anything old enough to be cut is necessarily old enough to be suspended.
  const owingSuspend = owingSince(dayAgo(config.billing.suspendAfterDays));
  const owingCut = new Set(owingSince(dayAgo(config.billing.cutoffAfterDays)));

  let suspended = 0, cut = 0, restored = 0;

  for (const id of owingSuspend) {
    const ws = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(id);
    if (!ws) continue;
    const want = owingCut.has(id) ? CUT : SUSPENDED;
    if (ws.subscription_status === want) continue;
    /*
     * Never step back DOWN from CUT to SUSPENDED while anything is still owed. A tenant who
     * settles their oldest invoice but not the newest would otherwise see their screens come
     * back on, which reads as "paid up" — and the next sweep would take them out again.
     * Recovery from CUT happens in one move, below, when nothing is owed at all.
     */
    if (ws.subscription_status === CUT) continue;

    db.prepare("UPDATE workspaces SET subscription_status = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(want, id);
    if (want === CUT) { cut++; console.warn(`[invoicing] workspace ${id} CUT — invoice overdue past ${config.billing.cutoffAfterDays} days`); }
    else { suspended++; console.warn(`[invoicing] workspace ${id} SUSPENDED — invoice overdue past ${config.billing.suspendAfterDays} days`); }
  }

  // An exempt workspace must not carry a dunning status at all. Marking one exempt does not
  // retract the PAYMENT_OVERDUE the webhook already recorded, and 'past_due' is not cleared by
  // the restore below (that one deliberately only touches the two enforced states, so a customer
  // two days overdue keeps the state the webhook set). Without this, the operator's own
  // workspace wears "Fatura vencida" in red forever for a bill nobody will ever send it.
  const cleared = db.prepare(`
    UPDATE workspaces SET subscription_status = 'active', updated_at = strftime('%s','now')
     WHERE COALESCE(billing_type, '') = ?
       AND subscription_status IN ('suspended', 'cut', 'past_due', 'unpaid')
  `).run(billing.INTERNAL_BILLING_TYPE).changes;
  if (cleared) console.log(`[invoicing] ${cleared} exempt workspace(s) cleared of a dunning status`);

  /*
   * Anything enforced with nothing payable outstanding gets let back in — by ANY route, not only
   * a webhook: a payment reconciled by hand, a replayed webhook, an invoice voided by the
   * operator, or an Asaas key that was missing and now is not, all land here on the next tick.
   */
  const stillOwing = new Set(owingSuspend);
  for (const r of db.prepare("SELECT id FROM workspaces WHERE subscription_status IN ('suspended', 'cut')").all()) {
    if (stillOwing.has(r.id)) continue;
    db.prepare("UPDATE workspaces SET subscription_status = 'active', updated_at = strftime('%s','now') WHERE id = ?").run(r.id);
    restored++;
    console.log(`[invoicing] workspace ${r.id} restored — nothing payable outstanding`);
  }
  return { suspended, cut, restored };
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

module.exports = {
  voidInvoice, ACTIVE, SUSPENDED, CUT, start, stop, tick, closeDueMonths, closeMonthFor, enforceSuspensions, dueDateFor };
