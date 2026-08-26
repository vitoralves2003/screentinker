'use strict';

/*
 * EVERY CUSTOMER, IN ONE LIST, WITH THE THINGS YOU LOOK A CUSTOMER UP FOR.
 *
 * The admin page carried two disconnected tables — every user, flat and forever-growing, and every
 * organisation with its workspaces nested underneath. Neither answered the question the page
 * exists for: who are my customers, what are they on, and do they owe me anything. Answering it
 * meant reading both tables and joining them in your head.
 *
 * ── THE TENANT IS THE WORKSPACE ──────────────────────────────────────────────────────────────
 * Not the organisation. The workspace is what holds a plan, screens and invoices; it is what
 * lib/tenant-plan.js resolves against and what lib/billing-summary.js counts. In production every
 * organisation has exactly one workspace and exactly one member, so the organisation layer names
 * nothing and is simply not shown. The column stays — per-customer SSO is configured against it,
 * and a chain with several branches would need it — but the word leaves the screen.
 *
 * ── AND A SIGNUP IS NOT A CUSTOMER ───────────────────────────────────────────────────────────
 * Somebody who registered, got a tenant and never added a screen is a lead or an abandoned
 * attempt. Mixed into the same list they are indistinguishable from people who pay, which is most
 * of what made the old page feel like noise. Marked here, separated on screen.
 */

const { db } = require('../db/database');
const { spDay } = require('./tenant-billing');
const { resolvedPlanSql } = require('./tenant-plan');

/*
 * One row per tenant.
 *
 * Deliberately a handful of queries rather than one query with six correlated subqueries: this
 * page is read by one person a few times a day, and the version that a stranger can follow is
 * worth more here than the version that saves four milliseconds.
 */
function tenants() {
  const { join, expr } = resolvedPlanSql('w');

  const rows = db.prepare(`
    SELECT w.id, w.name, w.created_at, w.subscription_status,
           w.billing_legal_name, w.billing_trade_name, w.billing_tax_id,
           w.billing_contact_email, w.asaas_customer_id,
           ${expr} AS plan_id,
           p.display_name AS plan_name,
           p.price_per_device,
           p.max_devices,
           (SELECT COUNT(*) FROM devices d WHERE d.workspace_id = w.id) AS device_count
      FROM workspaces w
      ${join}
      LEFT JOIN plans p ON p.id = ${expr}
     ORDER BY w.created_at DESC`).all();

  // Members, in one pass. A per-row query here is what turns a page into a hundred queries the
  // day the hundredth customer signs up.
  const membersByWs = new Map();
  for (const m of db.prepare(`
    SELECT wm.workspace_id, wm.role, u.id, u.name, u.email, u.auth_provider, u.last_login
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
     ORDER BY u.name, u.email`).all()) {
    if (!membersByWs.has(m.workspace_id)) membersByWs.set(m.workspace_id, []);
    membersByWs.get(m.workspace_id).push({
      id: m.id, name: m.name, email: m.email, role: m.role,
      auth_provider: m.auth_provider, last_login: m.last_login,
    });
  }

  /*
   * What each tenant owes, split the same three ways as the cash screen — and for the same reason:
   * "never charged" is the operator's own failure and looks exactly like delinquency in any total
   * that merges them.
   */
  const today = spDay();
  const owedByWs = new Map();
  for (const i of db.prepare(`
    SELECT workspace_id, amount_cents, due_date, invoice_url
      FROM workspace_invoices
     WHERE status NOT IN ('paid','void') AND amount_cents > 0`).all()) {
    if (!owedByWs.has(i.workspace_id)) {
      owedByWs.set(i.workspace_id, { overdue_cents: 0, not_invoiced_cents: 0, due_cents: 0 });
    }
    const b = owedByWs.get(i.workspace_id);
    if (!i.invoice_url) b.not_invoiced_cents += i.amount_cents;
    else if (i.due_date && i.due_date < today) b.overdue_cents += i.amount_cents;
    else b.due_cents += i.amount_cents;
  }

  const everInvoiced = new Set(
    db.prepare('SELECT DISTINCT workspace_id FROM workspace_invoices').all().map((r) => r.workspace_id)
  );

  return rows.map((r) => {
    const owed = owedByWs.get(r.id) || { overdue_cents: 0, not_invoiced_cents: 0, due_cents: 0 };
    return {
      id: r.id,
      name: r.name,
      legal_name: r.billing_legal_name,
      trade_name: r.billing_trade_name,
      tax_id: r.billing_tax_id,
      billing_email: r.billing_contact_email,
      created_at: r.created_at,
      plan_id: r.plan_id,
      plan_name: r.plan_name || r.plan_id,
      price_per_device: r.price_per_device || 0,
      device_count: r.device_count,
      max_devices: r.max_devices,
      subscription_status: r.subscription_status || 'active',
      has_asaas_customer: !!r.asaas_customer_id,
      members: membersByWs.get(r.id) || [],
      ...owed,
      outstanding_cents: owed.overdue_cents + owed.not_invoiced_cents + owed.due_cents,
      /*
       * A signup that never became a customer: no screen, no plan with a price, and no invoice in
       * its whole history. All three, because any one alone catches somebody real — a paying
       * customer between panels has no screens today, and a first month has no invoice yet.
       */
      dormant: r.device_count === 0 && !(r.price_per_device > 0) && !everInvoiced.has(r.id),
    };
  });
}

module.exports = { tenants };
