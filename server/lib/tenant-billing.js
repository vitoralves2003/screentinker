'use strict';

/*
 * Loop OS tenant billing — what a workspace owes, computed from licence-days.
 *
 * THE MODEL
 *   Free         1 screen, R$0
 *   Premium      R$25/screen/month, unlimited screens, widgets
 *   Corporativo  R$20/screen/month, minimum 20 screens billed, widgets + sub-lists + layouts
 *
 * A month is billed on the licences actually held, day by day:
 *
 *   licence_days = Σ over days of  max(peak_screens_that_day, plan.min_devices)
 *   amount       = licence_days / days_in_month × price_per_device
 *
 * So 20 screens until the 24th and 15 after, in a 30-day month, is
 * (24×20 + 6×15) / 30 = 19 average screens = R$475 on Premium — not R$500, and not R$375.
 * Proration is also why a mid-month signup needs no special case: subscribe on the 20th of a
 * 31-day month and you are billed 11/31 of it, by construction.
 *
 * min_devices is a BILLING FLOOR, not a quota (max_devices is the quota). It is applied PER DAY
 * rather than to the month's total: a Corporativo tenant running 25 screens for a fortnight and
 * 5 for the rest genuinely used more than the minimum for half the month, and a monthly floor
 * would erase that.
 *
 * WHY NOT lib/billing.js, which computes a strikingly similar average: that module is the
 * contractual system-of-record for the ByteTinker–Bold Media distribution agreement ("change
 * them only if the contract changes") and it measures ONLINE TIME. Tenant invoices must not
 * move when someone's shop shuts for a bank holiday. The maths here is modelled on it — that
 * shape is proven — but the input and the contract are different, so it is a separate module.
 *
 * TIME ZONE: every date here is America/São_Paulo. These become BRL invoices due on the 5th,
 * read by Brazilian customers; a UTC month boundary lands at 21:00 the previous day locally,
 * which would publish an "August" invoice while it is still 31 August in Brazil.
 */

const { db } = require('../db/database');
const config = require('../config');

const ZONE = config.billing.tenantZone;

// --- São Paulo calendar helpers -----------------------------------------------------------
// Intl rather than a hardcoded -3: Brazil dropped DST in 2019, so the offset is stable today,
// but encoding that assumption is exactly the kind of thing that breaks silently if it changes.
const _dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/* YYYY-MM-DD in São Paulo for a given instant (default: now). */
function spDay(ms = Date.now()) { return _dayFmt.format(new Date(ms)); }

/* YYYY-MM in São Paulo. */
function spMonth(ms = Date.now()) { return spDay(ms).slice(0, 7); }

/* Calendar days in a YYYY-MM. Month is 1-based here, so day 0 of the next month is the last. */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* The month before a given YYYY-MM — the one that just closed on the 1st. */
function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// --- recording ----------------------------------------------------------------------------

/*
 * Record today's peak for every workspace, in ONE statement.
 *
 * Driven by a timer rather than hooked into each place a device is created or deleted: there
 * are several such paths (pairing, the provisioning socket, the status import, deletion) and a
 * hook missed on any of them is silent under-billing. Recomputing the true count on a schedule
 * cannot drift, and cannot be forgotten when a new path is added.
 *
 * The trade-off is granularity: a screen added and removed entirely between two ticks is not
 * counted. At a few minutes per tick that is a rounding error on a daily peak, and it errs
 * toward the customer.
 */
// Prepared LAZILY, not at module scope. Requiring this file must not depend on the billing
// tables existing: routes/subscription.js pulls it in, and several tests inject a minimal
// hand-built database to exercise unrelated routes. A module-scope db.prepare() turns a missing
// table into an import-time crash for code that never calls this function.
let _recordPeaks = null;
function recordPeaksStmt() {
  if (!_recordPeaks) {
    _recordPeaks = db.prepare(`
      INSERT INTO workspace_license_daily (workspace_id, day, peak_devices)
      SELECT workspace_id, ?, COUNT(*) FROM devices
       WHERE workspace_id IS NOT NULL
       GROUP BY workspace_id
      ON CONFLICT(workspace_id, day)
      DO UPDATE SET peak_devices = MAX(peak_devices, excluded.peak_devices)
    `);
  }
  return _recordPeaks;
}

function recordDailyPeaks(nowMs = Date.now()) {
  try {
    return recordPeaksStmt().run(spDay(nowMs)).changes;
  } catch (e) {
    console.warn(`[billing] could not record licence peaks: ${e.message}`);
    return 0;
  }
}

// --- computation --------------------------------------------------------------------------

function planFor(workspaceId) {
  const row = db.prepare(`
    SELECT p.* FROM workspaces w
    JOIN plans p ON p.id = COALESCE(w.plan_id, 'free')
    WHERE w.id = ?
  `).get(workspaceId);
  return row || db.prepare("SELECT * FROM plans WHERE id = 'free'").get();
}

function round2(x) { return Math.round(x * 100) / 100; }

/*
 * What a workspace owes for a month. Returns null when there is nothing to bill — a free plan,
 * or a paid plan that held no screens at all and has no billing floor.
 *
 * Money is summed in integer centavos and only presented as reais at the edge, so a rate like
 * 475/30×25 cannot land on 474.99999999999994.
 */
function computeInvoice(workspaceId, month) {
  if (!MONTH_RE.test(month)) throw new Error(`invalid month (expected YYYY-MM): ${month}`);

  const plan = planFor(workspaceId);
  if (!plan || !(plan.price_per_device > 0)) return null;   // free tier: nothing to charge

  const dim = daysInMonth(month);
  const rows = db.prepare(
    'SELECT day, peak_devices FROM workspace_license_daily WHERE workspace_id = ? AND day LIKE ? ORDER BY day'
  ).all(workspaceId, `${month}-%`);

  const byDay = new Map(rows.map((r) => [r.day, r.peak_devices]));
  const floor = plan.min_devices > 0 ? plan.min_devices : 0;

  // Walk every calendar day, not just the days with rows. A day with no row is a day the
  // workspace held no screens — which still costs the billing floor on a plan that has one.
  let licenseDays = 0;
  let daysWithScreens = 0;
  for (let d = 1; d <= dim; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const peak = byDay.get(key) || 0;
    if (peak > 0) daysWithScreens++;
    licenseDays += Math.max(peak, floor);
  }

  // A floor-less plan that never held a screen owes nothing. A plan WITH a floor owes the
  // floor: that is what committing to a minimum means.
  if (licenseDays === 0) return null;
  if (!floor && daysWithScreens === 0) return null;

  const priceCents = Math.round(plan.price_per_device * 100);
  // Divide once, at the end: (licenceDays × priceCents) / daysInMonth.
  const amountCents = Math.round((licenseDays * priceCents) / dim);

  return {
    workspace_id: workspaceId,
    month,
    plan_id: plan.id,
    plan_name: plan.display_name,
    license_days: licenseDays,
    days_in_month: dim,
    avg_screens: round2(licenseDays / dim),
    price_per_device: plan.price_per_device,
    min_devices: floor,
    amount_cents: amountCents,
    amount: amountCents / 100,
    currency: plan.currency || 'BRL',
  };
}

/*
 * The month IN PROGRESS, for the dashboard: the same maths over the days elapsed so far, so a
 * customer watches the bill accrue instead of discovering it on the 1st. Explicitly a forecast,
 * not an invoice — `partial` says so.
 */
function currentMonthPreview(workspaceId, nowMs = Date.now()) {
  const month = spMonth(nowMs);
  const invoice = computeInvoice(workspaceId, month);
  if (!invoice) return null;

  // Only days up to today have happened; the rest of the month is not owed yet.
  const today = Number(spDay(nowMs).slice(8, 10));
  const plan = planFor(workspaceId);
  const floor = plan.min_devices > 0 ? plan.min_devices : 0;

  const rows = db.prepare(
    'SELECT day, peak_devices FROM workspace_license_daily WHERE workspace_id = ? AND day LIKE ? ORDER BY day'
  ).all(workspaceId, `${month}-%`);
  const byDay = new Map(rows.map((r) => [r.day, r.peak_devices]));

  let elapsed = 0;
  for (let d = 1; d <= today; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    elapsed += Math.max(byDay.get(key) || 0, floor);
  }

  const priceCents = Math.round(plan.price_per_device * 100);
  const accruedCents = Math.round((elapsed * priceCents) / invoice.days_in_month);

  return {
    ...invoice,
    partial: true,
    days_elapsed: today,
    license_days: elapsed,
    avg_screens: round2(elapsed / today),
    amount_cents: accruedCents,
    amount: accruedCents / 100,
    // What the full month costs if nothing changes from here — the number a customer actually
    // wants when deciding whether to add a screen.
    //
    // It is average-screens x price, NOT x days_in_month as well: price_per_device is already a
    // MONTHLY price per screen, so the day count is what the average divides out. Multiplying
    // by it again inflated a R$200 month to R$6.200.
    projected_amount: round2((elapsed / today) * plan.price_per_device),
  };
}

module.exports = {
  spDay, spMonth, daysInMonth, previousMonth, MONTH_RE,
  recordDailyPeaks, computeInvoice, currentMonthPreview, planFor,
};
