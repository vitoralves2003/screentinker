'use strict';

// Loop OS tenant billing via Asaas (https://docs.asaas.com).
//
// WHAT IS BILLED: a workspace, for the number of screens it currently has. There is no flat
// monthly price — the amount is always (screens x the band's price_per_device), recomputed
// every time a device is added or removed.
//
// THE BANDS are plan rows with price_per_device > 0, selected FLAT (not marginal): the band
// whose min_devices is the greatest one <= the screen count sets the rate for ALL screens.
// Same shape as tierFor() in lib/billing.js, deliberately — two different rate ladders in one
// codebase should at least be read the same way.
//
//   2-10 screens  -> premium    R$25,00/screen  (11 screens is NOT 10x25 + 1x20)
//   11+ screens   -> corporate  R$20,00/screen  (it is 11x20)
//
// Crossing between PAID bands is automatic: the customer already consented to per-screen
// billing, so their 11th screen simply re-prices the subscription and moves plan_id. Crossing
// OUT OF FREE is not — that is a new paid relationship and goes through subscribe() from an
// explicit user action.
//
// Everything here is best-effort with respect to the request that triggered it: a failure to
// reach Asaas must never block adding or removing a screen. Errors are logged and the local
// state is left for the next sync to reconcile.

const config = require('../config');
const { db } = require('../db/database');

const TIMEOUT_MS = 15000;

// --- pricing ------------------------------------------------------------------------------

// The paid band for a screen count, or null when below the lowest band (i.e. free tier).
function bandForScreens(screens) {
  const bands = db.prepare(
    'SELECT * FROM plans WHERE active = 1 AND price_per_device > 0 ORDER BY min_devices ASC'
  ).all();
  let chosen = null;
  for (const b of bands) if (screens >= b.min_devices) chosen = b;
  return chosen;
}

// The highest ceiling any paid band allows (-1 when the top band is uncapped). Used by the
// device-limit check so a paying workspace can grow past its CURRENT band's max_devices —
// that number is the top of a price bracket, not a quota.
function paidCeiling() {
  const top = db.prepare(
    'SELECT max_devices FROM plans WHERE active = 1 AND price_per_device > 0 ORDER BY min_devices DESC LIMIT 1'
  ).get();
  return top ? top.max_devices : 0;
}

// Money is computed in integer centavos and only divided at the end, so a per-screen price
// like 25.00 over 11 screens can't drift into 274.99999999999994.
function priceFor(screens) {
  const band = bandForScreens(screens);
  if (!band) return null;
  const cents = Math.round(band.price_per_device * 100) * screens;
  return { band, screens, currency: band.currency, total: cents / 100 };
}

function screenCount(workspaceId) {
  return db.prepare('SELECT COUNT(*) AS c FROM devices WHERE workspace_id = ?').get(workspaceId).c;
}

// --- HTTP ---------------------------------------------------------------------------------

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
      // so an HTML error page can't dump a screenful into the log.
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

// --- subscriptions ------------------------------------------------------------------------

function nextDueDate() {
  const d = new Date(Date.now() + config.asaas.dueDays * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Open a paid subscription for a workspace at its current screen count. Explicit user action
// only — never called from the device hooks.
async function subscribe(workspaceId) {
  const screens = screenCount(workspaceId);
  const price = priceFor(screens);
  if (!price) throw new Error(`${screens} screen(s) is below the lowest paid band — nothing to charge`);

  const customerId = await ensureCustomer(workspaceId);

  const sub = await asaasFetch('/subscriptions', {
    method: 'POST',
    body: {
      customer: customerId,
      billingType: config.asaas.billingType,
      value: price.total,
      nextDueDate: nextDueDate(),
      cycle: 'MONTHLY',
      description: `Loop OS ${price.band.display_name} — ${screens} tela(s)`,
      externalReference: workspaceId,
    },
  });

  db.prepare(`UPDATE workspaces
                SET asaas_subscription_id = ?, plan_id = ?, subscription_status = 'pending',
                    updated_at = strftime('%s','now')
              WHERE id = ?`).run(sub.id, price.band.id, workspaceId);

  return { subscription: sub, ...price };
}

// Re-price an EXISTING subscription against the live screen count, moving the workspace
// between paid bands as needed. No-op for workspaces that have no subscription (free tier) —
// they are not charged and their plan is only changed by an explicit subscribe().
async function syncSubscription(workspaceId) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws || !ws.asaas_subscription_id) return null;

  const screens = screenCount(workspaceId);
  const price = priceFor(screens);

  // Dropped below the paid floor (e.g. the last screens were removed). Leave the subscription
  // alone rather than guessing: cancelling is a commercial decision, and a workspace at 1
  // screen may just be mid-migration. Flag it for whoever handles dunning.
  if (!price) {
    console.warn(`[asaas] workspace ${workspaceId} fell to ${screens} screen(s), below the paid floor — subscription left untouched`);
    return null;
  }

  await asaasFetch(`/subscriptions/${ws.asaas_subscription_id}`, {
    method: 'PUT',
    body: {
      value: price.total,
      description: `Loop OS ${price.band.display_name} — ${screens} tela(s)`,
      // Asaas requires the cycle on update; re-sending the same one keeps the schedule.
      cycle: 'MONTHLY',
      updatePendingPayments: true,
    },
  });

  if (ws.plan_id !== price.band.id) {
    db.prepare("UPDATE workspaces SET plan_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(price.band.id, workspaceId);
    console.log(`[asaas] workspace ${workspaceId} moved ${ws.plan_id} -> ${price.band.id} (${screens} screens)`);
  }

  return price;
}

async function cancelSubscription(workspaceId) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws || !ws.asaas_subscription_id) return null;

  await asaasFetch(`/subscriptions/${ws.asaas_subscription_id}`, { method: 'DELETE' });
  db.prepare(`UPDATE workspaces
                SET asaas_subscription_id = NULL, plan_id = 'free', subscription_status = 'cancelled',
                    updated_at = strftime('%s','now')
              WHERE id = ?`).run(workspaceId);
  return true;
}

// --- device-count hook --------------------------------------------------------------------

// Called after a device is added or removed. Deliberately fire-and-forget: provisioning a
// screen must not wait on (or fail because of) the payment provider. If the sync is lost the
// next device change re-syncs, and the amount is recomputed from live state each time rather
// than incremented, so a dropped call cannot make the price drift.
function onDeviceCountChanged(workspaceId, reason) {
  if (!workspaceId) return;
  if (config.billingProvider !== 'asaas' || !configured() || config.selfHosted) return;

  setImmediate(() => {
    syncSubscription(workspaceId).catch((err) => {
      console.error(`[asaas] re-price after ${reason} failed for workspace ${workspaceId}: ${err.message}`);
    });
  });
}

module.exports = {
  bandForScreens,
  paidCeiling,
  priceFor,
  screenCount,
  configured,
  ensureCustomer,
  subscribe,
  syncSubscription,
  cancelSubscription,
  onDeviceCountChanged,
};
