'use strict';

/*
 * THE CASH POSITION, in the numbers an operator actually needs.
 *
 * There was no such screen. "How much did I bill this month, and who has not paid" was answerable
 * only by reading a table row by row, so in practice it was not answered — which is how six
 * invoices sat unissued long enough to suspend two tenants without anyone noticing that no charge
 * had ever gone out for them.
 *
 * ── THE SPLIT THAT MATTERS, AND WHY IT IS NOT ONE "INADIMPLÊNCIA" NUMBER ─────────────────────
 * Money not collected comes in three kinds, and they are three different problems with three
 * different owners:
 *
 *   NÃO EMITIDO — a month closed with an amount owed and no charge was ever created. The customer
 *                 has done nothing wrong; they were never asked. This is the operator's fault and
 *                 the operator's fix, and it is the one that hides, because it looks exactly like
 *                 an unpaid bill in any total that lumps them together.
 *   VENCIDO     — a charge the customer received and did not pay. Genuine delinquency.
 *   A VENCER    — issued, not due yet. Not a problem at all, and counting it as one makes the
 *                 whole screen cry wolf.
 *
 * A single "inadimplência" figure would have shown the same R$ 2.400 in every one of those cases,
 * and the action needed is completely different in each.
 */

const { db } = require('../db/database');
const { spDay, spMonth, isBillable } = require('./tenant-billing');
const { resolvedPlanSql } = require('./tenant-plan');

/*
 * Outstanding money, cut three ways.
 *
 * The classification mirrors owingSince() in services/tenant-invoicing.js: a row with no
 * invoice_url is never counted as overdue, because that is the guard that decides whether anybody
 * gets suspended. If this screen called it delinquency while the dunning job called it nothing,
 * the operator would chase a customer the system had already decided not to chase.
 */
function outstanding(today) {
  const rows = db.prepare(`
    SELECT amount_cents, due_date, invoice_url
      FROM workspace_invoices
     WHERE status NOT IN ('paid', 'void') AND amount_cents > 0`).all();

  const out = {
    not_invoiced: { count: 0, cents: 0 },
    overdue: { count: 0, cents: 0 },
    due: { count: 0, cents: 0 },
  };

  for (const r of rows) {
    const bucket = !r.invoice_url ? 'not_invoiced'
      : (r.due_date && r.due_date < today) ? 'overdue'
        : 'due';
    out[bucket].count += 1;
    out[bucket].cents += r.amount_cents;
  }

  out.total_cents = out.not_invoiced.cents + out.overdue.cents + out.due.cents;
  return out;
}

/*
 * Tenants by what they are actually doing, not by a status column alone.
 *
 * PAYING means on a priced plan AND not exempt. Both halves earn their place: a free workspace is
 * a real tenant and not revenue, and the house account sits on a paid plan because it uses the
 * paid features — counting either as a customer moves the customer count for reasons that have
 * nothing to do with anybody paying anything.
 */
function tenants() {
  const { join, expr } = resolvedPlanSql('w');
  const rows = db.prepare(`
    SELECT w.id, w.subscription_status AS status,
           ${expr} AS plan_id,
           COALESCE(p.price_per_device, 0) AS price,
           (w.billing_type = 'internal') AS internal
      FROM workspaces w
      ${join}
      LEFT JOIN plans p ON p.id = ${expr}`).all();

  const t = { total: rows.length, paying: 0, free: 0, internal: 0, suspended: 0, cut: 0 };
  for (const r of rows) {
    if (r.status === 'cut') t.cut += 1;
    else if (r.status === 'suspended') t.suspended += 1;

    /*
     * THE HOUSE ACCOUNT IS NOT A PAYING CUSTOMER.
     *
     * It sits on a paid plan because it uses the paid features, so counting by price alone put the
     * operator's own workspace in "clientes pagantes" — two customers where there was one, on the
     * screen the number of customers is read from.
     *
     * billing_type = 'internal' is the same exemption services/tenant-invoicing.js already honours
     * when deciding whether to charge. It existed; nothing on this screen consulted it.
     */
    if (r.internal) t.internal += 1;
    else if (r.price > 0) t.paying += 1;
    else t.free += 1;
  }
  return t;
}

/*
 * What was actually RECEIVED in a calendar month, by when it was paid rather than which month it
 * bills. Those two differ constantly — July's invoice is usually paid in August — and an operator
 * reconciling against a bank statement needs the date the money landed.
 */
function received(month) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
      FROM workspace_invoices
     WHERE status = 'paid' AND paid_at IS NOT NULL
       AND strftime('%Y-%m', paid_at, 'unixepoch', '-3 hours') = ?`).get(month);
  return { count: row.n, cents: row.cents };
}

/* What a closed month came to, whatever has happened to it since. The billing side of the same
 * period, so "faturado" and "recebido" can be compared instead of confused. */
function billed(month) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
      FROM workspace_invoices
     WHERE month = ? AND status != 'void'`).get(month);
  return { count: row.n, cents: row.cents };
}

/*
 * Paid months carrying no document. Counted here as well as on the fiscal screen because it is a
 * MONEY fact before it is a configuration one: revenue received with no nota behind it is a
 * liability, and it is invisible until somebody counts it.
 */
function missingNfse() {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
      FROM workspace_invoices
     WHERE status = 'paid' AND amount_cents > 0
       AND (nfse_id IS NULL OR nfse_status = 'ERROR')`).get();
  return { count: row.n, cents: row.cents };
}

/*
 * The month in progress, across every tenant — what is accruing right now and has not been
 * invoiced yet.
 *
 * Summed from the licence-day table rather than from screen counts: the bill is licence-days, a
 * screen added yesterday is not a full month, and a projection built on today's headcount would
 * read high all month and be wrong in a way that flatters.
 */
function accruing(month) {
  const tenantBilling = require('./tenant-billing');
  const ids = db.prepare('SELECT id FROM workspaces').all().map((r) => r.id);

  let cents = 0;
  let count = 0;
  for (const id of ids) {
    /*
     * Skipped BEFORE the arithmetic. An exempt workspace's licence-days are not revenue that
     * happens to be filtered out afterwards — they are not revenue. Today computeInvoice happens
     * to return null for the one exempt workspace here, so this changes no number yet; it is the
     * difference between being right and being lucky.
     */
    if (!isBillable(id)) continue;
    let preview = null;
    // Never let one workspace's arithmetic take the whole screen down — this is a summary, and a
    // missing line is better than a blank page.
    try { preview = tenantBilling.currentMonthPreview(id); } catch { preview = null; }
    if (!preview || !(preview.projected_amount > 0)) continue;
    cents += Math.round(preview.projected_amount * 100);
    count += 1;
  }
  return { count, cents, month };
}

function summary(now = Date.now()) {
  const today = spDay(now);
  const month = spMonth(now);
  const prev = (() => {
    const [y, m] = month.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  })();

  return {
    month,
    previous_month: prev,
    tenants: tenants(),
    received_this_month: received(month),
    billed_previous_month: billed(prev),
    accruing: accruing(month),
    outstanding: outstanding(today),
    missing_nfse: missingNfse(),
  };
}

module.exports = { summary, outstanding, tenants, received, billed, missingNfse, accruing };
