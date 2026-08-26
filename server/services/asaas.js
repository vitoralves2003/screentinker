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
/*
 * The key, the endpoint and the webhook token are read HERE, per call, not captured at load.
 * They are editable from Administration now, and a value captured when the module was required
 * would mean the operator saving a key and nothing happening until somebody restarted the
 * container — which is precisely the friction the screen exists to remove.
 */
const integrations = require('../lib/integration-settings');
const { spDay } = require('../lib/tenant-billing');
const { db } = require('../db/database');

const TIMEOUT_MS = 15000;

function configured() {
  return !!integrations.asaas().apiKey;
}

async function asaasFetch(path, { method = 'GET', body } = {}) {
  if (!configured()) throw new Error('ASAAS_API_KEY not configured');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const cfg = integrations.asaas();
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        access_token: cfg.apiKey,
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
/*
 * The Asaas customer body for a workspace — the ONE place that decides what they are told about a
 * tenant, so creating and updating cannot describe the same customer differently.
 *
 * Everything past the tax id exists for the nota fiscal rather than the charge. A charge needs a
 * name and a document; an emission needs the legal name and a full address, and a municipal web
 * service rejects the whole thing when either is missing.
 *
 * A blank field is OMITTED, never sent as ''. Asaas treats an empty string as a value and would
 * overwrite a good address with nothing the first time somebody saved the form having filled in
 * only their phone number.
 */
function customerBody(ws) {
  const owner = ws.created_by
    ? db.prepare('SELECT email, name FROM users WHERE id = ?').get(ws.created_by)
    : null;
  const email = ws.billing_contact_email || owner?.email;
  if (!email) throw new Error('workspace has no billing contact email');

  const body = {
    // The legal name when there is one: a nota fiscal carries the name on the registration, not
    // the "Padaria do Zé" a shopkeeper typed when they signed up.
    name: ws.billing_legal_name || ws.name,
    email,
    cpfCnpj: String(ws.billing_tax_id).replace(/\D/g, ''),
    externalReference: ws.id,
  };

  for (const [field, value] of [
    ['municipalInscription', ws.billing_municipal_inscription],
    ['postalCode', ws.billing_postal_code],
    ['address', ws.billing_address],
    ['addressNumber', ws.billing_address_number],
    ['complement', ws.billing_complement],
    ['province', ws.billing_province],
    ['phone', ws.billing_phone],
  ]) {
    const v = value == null ? '' : String(value).trim();
    if (v) body[field] = v;
  }

  return body;
}

/*
 * The Asaas customer for a workspace: created if absent, UPDATED if present.
 *
 * The update half is why this is not still called ensureCustomer internally. It returned early on
 * any stored id, so a tenant who corrected their address — or supplied one for the first time,
 * because none was ever asked for — changed a row in our database and nothing else. Asaas kept the
 * original, and Asaas is what the nota fiscal is built from. The fix would have looked like a
 * mystery: the address is right on the screen and wrong on the document.
 */
async function syncCustomer(workspaceId) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  if (!ws.billing_tax_id) throw new Error('workspace has no billing_tax_id (CPF/CNPJ) — cannot open an Asaas customer');

  const body = customerBody(ws);

  if (ws.asaas_customer_id) {
    // A failed update must not lose the customer we already have. The id stays; the charge still
    // works; only the newest address has not landed, and the next save retries it.
    await asaasFetch(`/customers/${ws.asaas_customer_id}`, { method: 'POST', body });
    return ws.asaas_customer_id;
  }

  const customer = await asaasFetch('/customers', { method: 'POST', body });
  db.prepare('UPDATE workspaces SET asaas_customer_id = ? WHERE id = ?').run(customer.id, workspaceId);
  return customer.id;
}

/*
 * Kept as the name every caller already uses, and as the honest description of what a charge
 * needs: a customer that EXISTS. Charging must not be blocked, or slowed, by pushing an address
 * change that has nothing to do with it.
 */
async function ensureCustomer(workspaceId) {
  const ws = db.prepare('SELECT asaas_customer_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (ws && ws.asaas_customer_id) return ws.asaas_customer_id;
  return syncCustomer(workspaceId);
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
/*
 * The date Asaas will accept for this charge.
 *
 * Asaas refuses a due date before today — "Não é permitido data de vencimento inferior a hoje"
 * — with a 400. The invoice due date is the 5th of the publishing month, so ANY charge created
 * late arrives already refused: a server that was down over the close, an Asaas outage, or the
 * three-month catch-up in closeDueMonths() picking up an older month. The retry then fails
 * identically forever, and it only warns, so the tenant is suspended for a debt that never
 * became payable. Observed exactly that on the July invoice.
 *
 * Today, in São Paulo, because that is the clock the invoice was cut on and the one Asaas
 * bills in — a UTC "today" is yesterday in Brazil for three hours every night, which is
 * precisely the window a nightly retry runs in.
 */
function chargeableDueDate(dueDate) {
  const today = spDay();
  return !dueDate || dueDate < today ? today : dueDate;
}

async function createInvoiceCharge(invoice) {
  const customerId = await ensureCustomer(invoice.workspace_id);

  return asaasFetch('/payments', {
    method: 'POST',
    body: {
      customer: customerId,
      // UNDEFINED lets the payer choose Pix, boleto or card on the Asaas invoice page.
      billingType: integrations.asaas().billingType,
      value: invoice.amount_cents / 100,
      dueDate: chargeableDueDate(invoice.due_date), // YYYY-MM-DD, never in the past
      description: `Loop OS ${invoice.plan_name} — ${invoice.month} — ${invoice.avg_screens} tela(s) em média (${invoice.license_days} dias-licença)`,
      externalReference: `${invoice.workspace_id}:${invoice.month}`,
    },
  });
}

// --- nota fiscal (NFS-e) --------------------------------------------------------------------

/*
 * Ask Asaas to issue the nota fiscal for a charge that has been PAID.
 *
 * WHY IT HANGS OFF THE CHARGE. Passing `payment` lets Asaas take the recipient, the amount and the
 * reference from the charge it already holds, so there is no second copy of the number to disagree
 * with the first. The alternative — issuing against a customer with a value typed in here — is how
 * a document ends up stating an amount the customer never paid.
 *
 * WHY ONLY AFTER PAYMENT. A nota fiscal is a declaration that a service was rendered and PAID for.
 * Issuing on the charge instead would generate tax on money that may never arrive, and cancelling
 * an NFS-e is a municipal procedure with a deadline, not a delete.
 */
async function createNfse(invoice, cfg) {
  const description = (cfg.description || 'Licenciamento de software para sinalização digital — {month}')
    .replace('{month}', invoice.month)
    .replace('{screens}', String(invoice.avg_screens ?? ''));

  const body = {
    payment: invoice.asaas_charge_id,
    serviceDescription: description,
    observations: `Loop Player — competência ${invoice.month}`,
    externalReference: `${invoice.workspace_id}:${invoice.month}`,
    value: invoice.amount_cents / 100,
    deductions: cfg.deductions || 0,
    // Today, in São Paulo. The competência is stated in the description; the effective date is
    // when the document is issued, and a date in the past is refused the same way a charge is.
    effectiveDate: spDay(),
    municipalServiceCode: cfg.serviceCode,
    taxes: { retainIss: !!cfg.retainIss, ...cfg.taxes },
  };
  if (cfg.serviceName) body.municipalServiceName = cfg.serviceName;

  return asaasFetch('/invoices', { method: 'POST', body });
}

/* Read one back — how a document that moved to AUTHORIZED (or ERROR) hours later is reconciled
 * when the webhook never arrived. */
async function getNfse(nfseId) {
  return asaasFetch(`/invoices/${nfseId}`);
}

// Read a charge back. Used to recover the payment link for a charge that was created before
// the link was stored — the id is the only thing that survived, and re-issuing would bill the
// customer twice for one month.
async function getCharge(chargeId) {
  if (!chargeId) return null;
  return asaasFetch(`/payments/${encodeURIComponent(chargeId)}`);
}

async function cancelCharge(chargeId) {
  if (!chargeId) return null;
  return asaasFetch(`/payments/${chargeId}`, { method: 'DELETE' });
}

/*
 * WHOSE ACCOUNT IS THIS KEY? — what the panel's "test" button asks.
 *
 * A key that merely parses tells you nothing; the failure worth catching is a VALID key belonging
 * to the wrong account, or a production key against the sandbox endpoint. So the probe returns the
 * account's own name and CNPJ for the operator to read back, rather than a green tick.
 */
async function whoAmI() {
  const acc = await asaasFetch('/myAccount/commercialInfo');
  return {
    name: acc.name || acc.companyName || acc.tradingName || null,
    cpfCnpj: acc.cpfCnpj || null,
    email: acc.email || null,
  };
}

module.exports = {
  syncCustomer,
  createNfse,
  getNfse,
  whoAmI,
  configured,
  asaasFetch,
  ensureCustomer,
  createInvoiceCharge,
  getCharge,
  cancelCharge,
};
