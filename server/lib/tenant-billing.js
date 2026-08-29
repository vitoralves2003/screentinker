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
const tenantPlan = require('./tenant-plan');

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

/*
 * The plan a workspace is billed on — delegated, never re-derived.
 *
 * This function used to carry its own COALESCE, which is how the product ended up with three
 * resolutions of "which plan" that disagreed in production. lib/tenant-plan.js is now the only
 * place that answers it, and test/tenant-plan.test.js fails the build if a second one appears.
 */
function planFor(workspaceId) {
  return tenantPlan.planRowFor(workspaceId);
}

/*
 * Is this workspace invoiced at all?
 *
 * workspaces.billing_type has existed since the tenancy migration and was read by NOTHING, which
 * left "bill everyone whose plan has a price" as the only rule the product could express. It
 * cannot express the fleet the operator runs on their own account, a workspace settled by a
 * contract outside the product, or a demo — and role is no substitute: a platform_admin's
 * workspace on Premium is invoiced exactly like a customer's, because billing follows the
 * workspace, not the person.
 *
 * ONLY the exact string 'internal' exempts. Not "anything that isn't client_billable": a typo in
 * this column would then silently stop the invoicing of a paying customer, and silent
 * under-billing is the failure you find months later in a bank statement. An unrecognised value
 * bills, which is the recoverable direction.
 */
const INTERNAL_BILLING_TYPE = 'internal';

function isBillable(workspaceId) {
  if (!workspaceId) return false;
  const row = db.prepare('SELECT billing_type FROM workspaces WHERE id = ?').get(workspaceId);
  if (!row) return false;
  return row.billing_type !== INTERNAL_BILLING_TYPE;
}

function round2(x) { return Math.round(x * 100) / 100; }

/*
 * What a workspace owes for a month. Returns null when there is nothing to bill — a free plan,
 * or a paid plan that held no screens at all and has no billing floor.
 *
 * Money is summed in integer centavos and only presented as reais at the edge, so a rate like
 * 475/30×25 cannot land on 474.99999999999994.
 */
function billingMode(plan) {
  if (!plan) return null;
  if (plan.package_size > 0 && plan.package_price > 0) {
    return { mode: 'package', size: plan.package_size, unitPriceCents: Math.round(plan.package_price * 100) };
  }
  if (plan.price_per_device > 0) {
    return { mode: 'device', size: 1, unitPriceCents: Math.round(plan.price_per_device * 100) };
  }
  if (plan.flat_monthly > 0) {
    return { mode: 'flat', size: 0, unitPriceCents: Math.round(plan.flat_monthly * 100) };
  }
  return null;
}

/*
 * Quantas unidades um dia com `peak` telas consome.
 *
 * O ARREDONDAMENTO PARA CIMA E A REGRA INTEIRA DO PACOTE. A 21a tela custa um pacote
 * completo naquele dia, e no dia em que o cliente volta para 20 ele para de pagar por ele.
 * E por isso que nao existe devolucao no Master: o segundo pacote so e cobrado pelos dias
 * em que esteve aberto, entao nunca ha o que devolver.
 */
function unitsForDay(peak, m, floor) {
  if (m.mode === 'package') return Math.ceil(peak / m.size);
  return Math.max(peak, floor);
}

function computeInvoice(workspaceId, month) {
  if (!MONTH_RE.test(month)) throw new Error(`invalid month (expected YYYY-MM): ${month}`);

  /*
   * A month that ended before this workspace existed is not billable, however the arithmetic
   * comes out. Checked FIRST: um plano fixo cobraria o mes inteiro de um cliente que ainda
   * nao existia, e closeDueMonths olha tres meses para tras.
   */
  const born = db.prepare('SELECT created_at FROM workspaces WHERE id = ?').get(workspaceId);
  if (born && born.created_at && spMonth(born.created_at * 1000) > month) return null;

  // Exempt workspaces owe nothing, whatever plan they are on: the plan still decides their
  // features and limits, it simply is not charged for.
  if (!isBillable(workspaceId)) return null;

  const plan = planFor(workspaceId);
  const m = billingMode(plan);
  if (!m) return null;                                       // plano gratuito: nada a cobrar

  const dim = daysInMonth(month);

  const base = {
    workspace_id: workspaceId,
    month,
    plan_id: plan.id,
    plan_name: plan.display_name,
    days_in_month: dim,
    billing_mode: m.mode,
    unit_price_cents: m.unitPriceCents,
    price_per_device: plan.price_per_device,
    min_devices: plan.min_devices > 0 ? plan.min_devices : 0,
    currency: plan.currency || 'BRL',
  };

  /*
   * FIXO nao consulta dia nenhum -- um plano sem telas nao tem o que medir. O mes inteiro
   * custa o mesmo, inclusive aquele em que o cliente entrou. Isso e decisao de produto e
   * nao esquecimento: nao existe sinal de uso do qual tirar uma proporcao, e inventar uma
   * a partir da data de criacao seria cobrar por uma regra que ninguem combinou.
   */
  if (m.mode === 'flat') {
    return Object.assign({}, base, {
      license_days: 0,
      unit_days: dim,
      avg_screens: 0,
      amount_cents: m.unitPriceCents,
      amount: m.unitPriceCents / 100,
    });
  }

  const rows = db.prepare(
    'SELECT day, peak_devices FROM workspace_license_daily WHERE workspace_id = ? AND day LIKE ? ORDER BY day'
  ).all(workspaceId, `${month}-%`);

  const byDay = new Map(rows.map((r) => [r.day, r.peak_devices]));
  const floor = base.min_devices;

  // Walk every calendar day, not just the days with rows. A day with no row is a day the
  // workspace held no screens.
  //
  // Duas somas, de proposito. `unitDays` e o que se cobra -- pacotes no Master, telas no
  // Pro. `screenDays` e sempre em TELAS, para que a media exibida signifique a mesma coisa
  // nos dois planos: dizer "3,2" quando sao pacotes e "41" quando sao telas, na mesma
  // coluna de duas faturas, e como se descobre tarde que a conta foi lida errado.
  let unitDays = 0;
  let screenDays = 0;
  let daysWithScreens = 0;
  for (let d = 1; d <= dim; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const peak = byDay.get(key) || 0;
    if (peak > 0) daysWithScreens++;
    screenDays += peak;
    unitDays += unitsForDay(peak, m, floor);
  }

  if (unitDays === 0) return null;
  if (!floor && daysWithScreens === 0) return null;

  // Divide once, at the end: (unidades x preco) / dias do mes.
  const amountCents = Math.round((unitDays * m.unitPriceCents) / dim);

  return Object.assign({}, base, {
    license_days: screenDays,
    unit_days: unitDays,
    avg_screens: round2(screenDays / dim),
    amount_cents: amountCents,
    amount: amountCents / 100,
  });
}

/*
 * The month IN PROGRESS, for the dashboard: the same maths over the days elapsed so far, so a
 * customer watches the bill accrue instead of discovering it on the 1st. Explicitly a forecast,
 * not an invoice -- `partial` says so.
 */
function currentMonthPreview(workspaceId, nowMs = Date.now()) {
  const month = spMonth(nowMs);
  const invoice = computeInvoice(workspaceId, month);
  if (!invoice) return null;

  const today = Number(spDay(nowMs).slice(8, 10));
  const plan = planFor(workspaceId);
  const m = billingMode(plan);

  /*
   * FIXO nao acumula. O valor ja e conhecido no dia 1, e mostrar um terco dele no dia 10
   * prometeria uma proporcao que a fatura nao vai fazer.
   */
  if (m.mode === 'flat') {
    return Object.assign({}, invoice, {
      partial: true,
      days_elapsed: today,
      projected_amount: invoice.amount,
    });
  }

  const floor = invoice.min_devices;
  const rows = db.prepare(
    'SELECT day, peak_devices FROM workspace_license_daily WHERE workspace_id = ? AND day LIKE ? ORDER BY day'
  ).all(workspaceId, `${month}-%`);
  const byDay = new Map(rows.map((r) => [r.day, r.peak_devices]));

  let elapsedUnits = 0;
  let elapsedScreens = 0;
  for (let d = 1; d <= today; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const peak = byDay.get(key) || 0;
    elapsedScreens += peak;
    elapsedUnits += unitsForDay(peak, m, floor);
  }

  const accruedCents = Math.round((elapsedUnits * m.unitPriceCents) / invoice.days_in_month);

  return Object.assign({}, invoice, {
    partial: true,
    days_elapsed: today,
    license_days: elapsedScreens,
    unit_days: elapsedUnits,
    avg_screens: round2(elapsedScreens / today),
    amount_cents: accruedCents,
    amount: accruedCents / 100,
    // O mes inteiro se nada mudar daqui: media de unidades por dia x preco da unidade.
    // NAO multiplica pelos dias do mes de novo -- o preco ja e mensal, e foi assim que uma
    // conta de R$ 200 virou R$ 6.200 uma vez.
    projected_amount: round2(((elapsedUnits / today) * m.unitPriceCents) / 100),
  });
}

module.exports = {
  spDay, spMonth, daysInMonth, previousMonth, MONTH_RE,
  recordDailyPeaks, computeInvoice, currentMonthPreview, planFor,
  isBillable, billingMode, INTERNAL_BILLING_TYPE,
};
