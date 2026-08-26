'use strict';

/*
 * WHAT THE TENANT IS TOLD ABOUT THEIR BILL, and when.
 *
 * Until now a tenant learned they owed money by having the panel stop working. The invoice existed,
 * the dunning job ran, the workspace was suspended — and the only thing that reached the person
 * paying was a 403 on the next thing they tried to save. Two of them sat suspended over six
 * invoices that had never been issued at all, which is a bill nobody sent and a door nobody could
 * open.
 *
 * This is the one place that answers "is there something to say about money", so the banner, and
 * anything else that asks later, cannot disagree about it.
 *
 * ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────────────────────
 * An invoice with no charge issued (invoice_url IS NULL) is NEVER overdue. It has no due date the
 * customer ever saw. This mirrors owingSince() in services/tenant-invoicing.js exactly — the guard
 * that stopped the suspensions above — and the two must not drift: if this file called such a month
 * "vencida" while dunning called it "not owed", the tenant would be shown a threat the system had
 * already decided not to act on. It reports the state honestly instead: the month closed, this is
 * the amount, the charge has not gone out, nothing is late.
 */

const { db } = require('../db/database');
const config = require('../config');
const { spDay } = require('./tenant-billing');

/* Whole days from a YYYY-MM-DD to another, positive when `to` is later. Dates only — no clock, no
 * offsets: both sides are already calendar days in São Paulo, and turning them back into instants
 * is how a bill due today starts reading as overdue at nine in the evening. */
function daysBetween(fromDay, toDay) {
  const at = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((at(toDay) - at(fromDay)) / 86400000);
}

/*
 * The notice for one workspace, or null when there is nothing to say.
 *
 * @param {string} workspaceId
 * @param {number} [now] instant to judge against, for tests
 */
function noticeFor(workspaceId, now = Date.now()) {
  // A self-hosted install is never invoiced, so there is no bill to warn anybody about.
  if (config.selfHosted || !workspaceId) return null;

  /*
   * Zero-amount rows are excluded rather than shown as "R$ 0,00 a pagar". A free tier and a month
   * a workspace was exempt both close as real rows, and a banner about nothing is how a reader
   * learns to stop reading banners — which is exactly the banner you need them to read later.
   */
  let rows;
  try {
    rows = db.prepare(`
      SELECT month, amount_cents, currency, due_date, invoice_url, status
        FROM workspace_invoices
       WHERE workspace_id = ? AND status NOT IN ('paid', 'void') AND amount_cents > 0
       ORDER BY month ASC`).all(workspaceId);
  } catch (_) {
    // Never take the page down over the bill. An install mid-migration has no such table yet.
    return null;
  }
  if (!rows.length) return null;

  const today = spDay(now);
  const totalCents = rows.reduce((sum, r) => sum + r.amount_cents, 0);

  /*
   * The OLDEST outstanding month leads, because it is the one dunning acts on. Showing the newest
   * would put a bill due next week at the top while the one about to suspend them sits silent.
   */
  const lead = rows[0];

  // Issued but with no due date is treated as not yet due rather than overdue: absent evidence
  // that a deadline passed, the customer gets the benefit of it.
  const daysOverdue = lead.invoice_url && lead.due_date ? daysBetween(lead.due_date, today) : 0;

  const base = {
    month: lead.month,
    amount_cents: lead.amount_cents,
    currency: lead.currency || 'BRL',
    due_date: lead.due_date || null,
    invoice_url: lead.invoice_url || null,
    // Present so a tenant owing three months is not told about one of them and surprised by the
    // rest. The frontend says "e mais N" rather than repeating the whole ledger on a home page.
    outstanding_count: rows.length,
    outstanding_cents: totalCents,
  };

  if (!lead.invoice_url) return { ...base, state: 'uninvoiced', days_overdue: 0, stage: 'none' };
  if (daysOverdue <= 0) return { ...base, state: 'due', days_overdue: 0, stage: 'none' };

  /*
   * How far into dunning this is. Read from the WORKSPACE rather than recomputed from the date:
   * services/tenant-invoicing.js is what actually suspends, it runs on a schedule, and a banner
   * that announced a suspension the job had not performed yet would be telling the customer their
   * panel is blocked while it still works. The countdown below is the honest version of that — it
   * says what is coming, not what has happened.
   */
  const ws = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(workspaceId);
  const status = ws ? ws.subscription_status : null;
  const stage = status === 'cut' ? 'cut' : status === 'suspended' ? 'suspended' : 'none';

  return {
    ...base,
    state: 'overdue',
    days_overdue: daysOverdue,
    stage,
    // Days remaining before each stage bites, floored at zero. Only meaningful while it has not
    // happened yet, which is why the frontend reads `stage` first.
    suspend_in_days: Math.max(0, config.billing.suspendAfterDays - daysOverdue),
    cut_in_days: Math.max(0, config.billing.cutoffAfterDays - daysOverdue),
  };
}

module.exports = { noticeFor, daysBetween };
