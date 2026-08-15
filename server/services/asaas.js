'use strict';

// Loop OS tenant billing via Asaas (https://docs.asaas.com).
//
// WHAT IS BILLED: a workspace, in ARREARS, for the licence-days it actually held. The month
// closes on its last day, the invoice is published on the 1st and falls due on the 5th. The
// amount is computed by lib/tenant-billing.js; this module only talks to Asaas.
//
// WHY A CHARGE AND NOT A SUBSCRIPTION. An Asaas subscription carries a FIXED value, so it can
// only bill something known in advance. A prorated bill is not known until the month it covers
// has ended — so each month produces its own charge instead. That is the whole reason the
// earlier fixed-value subscription (and the re-pricing on every device change that went with
// it) is gone: there is no longer a running amount to keep in sync, only a closed month to
// invoice.
//
// Everything here is best-effort with respect to the caller. A workspace's invoice row is
// written locally FIRST and the Asaas charge attached afterwards, so an outage at the payment
// provider delays the charge without losing the bill — services/tenant-invoicing.js retries.

const config = require('../config');
const { db } = require('../db/database');

const TIMEOUT_MS = 15000;

function configured() {
  return !!config.asaas.apiKey;
}

async function asaasFetch(path, { method = 'GET', body } = {}) {
  if (!configured()) throw new Error('ASAAS_API_KEY not configured');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.asaas.baseUrl}${path}`, {
      method,
      headers: {
        access_token: config.asaas.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* Asaas can return an HTML error page */ }

    if (!res.ok) {
      // Asaas puts the useful part in errors[].description; fall back to the raw body, capped
      // so an HTML error page cannot dump a screenful into the log.
      const detail = json?.errors?.map((e) => e.description).join('; ') || text.slice(0, 200);
      throw new Error(`Asaas ${method} ${path} -> ${res.status}: ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// --- customers ----------------------------------------------------------------------------

// Create the Asaas customer for a workspace, or return the one already linked. The tax id is
// required by Asaas and has no sensible default, so this throws rather than inventing one.
async function ensureCustomer(workspaceId) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  if (ws.asaas_customer_id) return ws.asaas_customer_id;

  if (!ws.billing_tax_id) throw new Error('workspace has no billing_tax_id (CPF/CNPJ) — cannot open an Asaas customer');

  const owner = ws.created_by
    ? db.prepare('SELECT email, name FROM users WHERE id = ?').get(ws.created_by)
    : null;
  const email = ws.billing_contact_email || owner?.email;
  if (!email) throw new Error('workspace has no billing contact email');

  const customer = await asaasFetch('/customers', {
    method: 'POST',
    body: {
      name: ws.name,
      email,
      cpfCnpj: String(ws.billing_tax_id).replace(/\D/g, ''),
      externalReference: workspaceId,
    },
  });

  db.prepare('UPDATE workspaces SET asaas_customer_id = ? WHERE id = ?').run(customer.id, workspaceId);
  return customer.id;
}

// --- charges ------------------------------------------------------------------------------

/*
 * Issue one month's invoice as an Asaas charge.
 *
 * externalReference carries "<workspaceId>:<month>", which is what makes a retry safe to
 * reason about: if this module succeeded but the caller failed to record the id, the charge is
 * identifiable in Asaas rather than anonymous. The caller's own UNIQUE(workspace_id, month) is
 * the actual guard against issuing twice.
 */
async function createInvoiceCharge(invoice) {
  const customerId = await ensureCustomer(invoice.workspace_id);

  return asaasFetch('/payments', {
    method: 'POST',
    body: {
      customer: customerId,
      // UNDEFINED lets the payer choose Pix, boleto or card on the Asaas invoice page.
      billingType: config.asaas.billingType,
      value: invoice.amount_cents / 100,
      dueDate: invoice.due_date,                    // YYYY-MM-DD
      description: `Loop OS ${invoice.plan_name} — ${invoice.month} — ${invoice.avg_screens} tela(s) em média (${invoice.license_days} dias-licença)`,
      externalReference: `${invoice.workspace_id}:${invoice.month}`,
    },
  });
}

async function cancelCharge(chargeId) {
  if (!chargeId) return null;
  return asaasFetch(`/payments/${chargeId}`, { method: 'DELETE' });
}

module.exports = {
  configured,
  asaasFetch,
  ensureCustomer,
  createInvoiceCharge,
  cancelCharge,
};
