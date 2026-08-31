const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { getUserPlan, getUserDeviceCount, getUserStorageMB,
        getRequestPlan, getWorkspaceDeviceCount, getWorkspaceStorageMB } = require('../middleware/subscription');
// This router is mounted WITHOUT resolveTenancy (GET /plans is public and must stay
// unauthenticated), so the routes that need a workspace attach it themselves.
const { resolveTenancy } = require('../lib/tenancy');
const asaas = require('../services/asaas');
const tenantBilling = require('../lib/tenant-billing');
const config = require('../config');
// The fiscal profile is auditable data about a real company: who changed it, and from where.
const { logActivity, getClientIp } = require('../services/activity');

// Get all plans
router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order ASC').all();
  res.json(plans);
});

// Get the current subscription for the caller's active workspace (falling back to their own
// plan when they have no workspace context). The *_enabled flags are what the UI gates the
// widget catalogue and sub-list option on, so they have to be here.
router.get('/me', requireAuth, resolveTenancy, (req, res) => {
  const plan = getRequestPlan(req);
  if (!plan) return res.status(404).json({ error: 'No plan found' });

  const deviceCount = req.workspaceId ? getWorkspaceDeviceCount(req.workspaceId) : getUserDeviceCount(req.user.id);
  const storageMB = req.workspaceId ? getWorkspaceStorageMB(req.workspaceId) : getUserStorageMB(req.user.id);
  // The month IN PROGRESS: licence-days accrued so far and what they cost, so the customer
  // watches the bill form instead of meeting it on the 1st. Null on the free tier.
  const preview = req.workspaceId ? tenantBilling.currentMonthPreview(req.workspaceId) : null;
  // The most recent closed months, newest first — what is actually owed and whether it is paid.
  const invoices = req.workspaceId ? db.prepare(
    `SELECT month, license_days, days_in_month, avg_screens, amount_cents, currency,
            due_date, status, asaas_charge_id, invoice_url, paid_at,
            -- Only the two the customer can use. nfse_status and nfse_error are the operator's
            -- business: a tenant can do nothing with "SYNCHRONIZED", and nothing at all with a
            -- municipal rejection except worry about it.
            nfse_number, nfse_pdf_url
       FROM workspace_invoices WHERE workspace_id = ? ORDER BY month DESC LIMIT 6`
  ).all(req.workspaceId) : [];

  res.json({
    plan: {
      id: plan.plan_id,
      name: plan.plan_name,
      display_name: plan.plan_display_name,
      max_devices: plan.max_devices,
      min_devices: plan.min_devices,
      max_storage_mb: plan.max_storage_mb,
      remote_control: !!plan.remote_control,
      remote_url: !!plan.remote_url,
      priority_support: !!plan.priority_support,
      // Loop OS feature gates — mirror of middleware/subscription.js's checks.
      widgets_enabled: !!plan.widgets_enabled,
      sublists_enabled: !!plan.sublists_enabled,
      layouts_enabled: !!plan.layouts_enabled,
      /*
       * Etapa 6: a tela precisa saber se este cliente TEM Gestao, para so entao oferecer o campo
       * que liga uma midia a um contrato. Sem Gestao nao ha contrato nenhum, e um campo que so
       * pode ficar vazio e uma pergunta sem resposta possivel.
       *
       * Junto dos irmaos de propósito: e a mesma linha de plans, e esta e a resposta que o
       * frontend ja le para decidir o que oferecer.
       */
      gestao_enabled: !!plan.gestao_enabled,
      price_monthly: plan.price_monthly,
      price_yearly: plan.price_yearly,
      price_per_device: plan.price_per_device,
      currency: plan.currency,
    },
    usage: {
      devices: deviceCount,
      devices_limit: plan.max_devices,
      storage_mb: storageMB,
      storage_limit_mb: plan.max_storage_mb,
    },
    // The month in progress. `amount` is what has accrued to today; `projected_amount` is what
    // the full month costs if nothing changes — the number someone wants before adding a screen.
    current_month: preview ? {
      month: preview.month,
      days_elapsed: preview.days_elapsed,
      days_in_month: preview.days_in_month,
      license_days: preview.license_days,
      avg_screens: preview.avg_screens,
      min_devices: preview.min_devices,
      price_per_device: preview.price_per_device,
      amount: preview.amount,
      projected_amount: preview.projected_amount,
      currency: preview.currency,
    } : null,
    // Closed months. amount_cents is integer centavos — divide at the edge, never store money
    // as a float.
    invoices: invoices.map((i) => ({ ...i, amount: i.amount_cents / 100 })),
    subscription: {
      status: plan.subscription_status,
      ends: plan.subscription_ends,
      provider: config.billingProvider,
      // Billing is in arrears: each month is its own charge, so there is no running
      // subscription object to surface here any more.
      due_day: config.billing.dueDay,
      suspend_after_days: config.billing.suspendAfterDays,
      stripe_customer_id: plan.stripe_customer_id,
      stripe_subscription_id: plan.stripe_subscription_id,
      asaas_customer_id: plan.asaas_customer_id,
    },
    trial: {
      active: plan.trial_active || false,
      days_left: plan.trial_days_left || 0,
      end: plan.trial_end ? new Date(plan.trial_end * 1000).toISOString() : null,
      plan: plan.trial_plan || null,
    },
    self_hosted: config.selfHosted,
    // Whether this workspace is invoiced at all. False for an exempt one — its screens still
    // count and its plan still gates features, it is simply never charged. Told plainly rather
    // than left to be inferred from an absent "this month" card, which reads like a bug.
    billed: req.workspaceId ? tenantBilling.isBillable(req.workspaceId) : true,
  });
});

// --- Plan selection -----------------------------------------------------------------------
//
// Choosing a plan is now a LOCAL act, not a call to the payment provider: there is no
// subscription object to open. The workspace records which plan it is on, licence-days accrue,
// and the month is invoiced after it ends (services/tenant-invoicing.js). That is also why
// switching plans is instant and needs no proration logic here — the day the plan changed is
// simply the day the rate changed, and the monthly close does the arithmetic.

function requireWorkspaceAdmin(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context.' });
  if (req.workspaceRole !== 'workspace_admin' && !req.orgRole && !req.isPlatformAdmin) {
    return res.status(403).json({ error: 'Only a workspace admin can change the subscription.' });
  }
  next();
}

router.post('/plan', requireAuth, resolveTenancy, requireWorkspaceAdmin, async (req, res) => {
  const { plan_id, tax_id, billing_email } = req.body || {};
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);

  // A paid plan needs a payer. Asaas refuses to open a customer without a CPF/CNPJ, and
  // discovering that at the end of the month — with a bill already owed and no way to charge
  // it — is far worse than refusing here.
  const paid = plan.price_per_device > 0;
  const taxId = tax_id ? String(tax_id).replace(/\D/g, '') : ws.billing_tax_id;
  if (paid && !taxId) return res.status(400).json({ error: 'CPF/CNPJ é obrigatório para contratar um plano pago', code: 'TAX_ID_REQUIRED' });

  db.prepare(`UPDATE workspaces
                 SET plan_id = ?, billing_tax_id = COALESCE(?, billing_tax_id),
                     billing_contact_email = COALESCE(?, billing_contact_email),
                     updated_at = strftime('%s','now')
               WHERE id = ?`)
    .run(plan_id, taxId || null, billing_email || null, req.workspaceId);

  // Open the Asaas customer now rather than at close time, so a bad tax id surfaces while the
  // operator is still looking at the form. Best-effort: the monthly close retries it.
  if (paid && asaas.configured()) {
    try { await asaas.ensureCustomer(req.workspaceId); }
    catch (err) { console.warn(`[billing] could not pre-create Asaas customer for ${req.workspaceId}: ${err.message}`); }
  }

  /*
   * WRITTEN TO THE LOG BY HAND, because the automatic logger never sees this router.
   *
   * activityLogger is mounted in server.js AFTER /api/subscription, deliberately: auth has its own
   * inline writers and payment webhooks do not belong in an activity log. A customer changing what
   * they pay is neither of those, and it was swept up in the same exemption.
   *
   * WHAT THAT COST. A tenant self-selected a plan with a twenty-screen floor forty-three seconds
   * after signing up, and the only trace was the plan_id itself. Reconstructing who did it, when,
   * and from where meant comparing a workspace's created_at against its updated_at and guessing.
   * A row that decides R$ 400 a month has to say who set it.
   */
  logActivity(req.user.id, 'subscription_plan_changed',
    `${ws.plan_id || '—'} -> ${plan_id}`, null, getClientIp(req), req.workspaceId);

  // Record the licence count against today immediately: the plan the workspace is on when the
  // month closes is what prices every day of it, so the change should be visible at once.
  try { tenantBilling.recordDailyPeaks(); } catch { /* the sampler retries */ }

  res.json({
    plan_id,
    display_name: plan.display_name,
    price_per_device: plan.price_per_device,
    min_devices: plan.min_devices,
    currency: plan.currency,
    current_month: tenantBilling.currentMonthPreview(req.workspaceId),
  });
});

/*
 * ===================== THE TENANT'S OWN COMPANY DETAILS =====================
 *
 * WHAT THIS IS FOR. A charge needs a name and a tax id, and that is all the system ever asked for.
 * A nota fiscal needs the rest: the legal name on the registration and a full address. There was
 * nowhere to put either, so the day the first emission was attempted it would have failed against
 * a municipal web service with a message nobody in this product could act on.
 *
 * WHOSE PAGE THIS IS. The tenant's own — they are the only ones who know their inscrição municipal
 * and whether the address on the registration is still where they trade. requireWorkspaceAdmin,
 * not platform staff: this is their data about themselves.
 */
const brFiscal = require('../lib/br-fiscal');

/* The columns this endpoint owns, and the Asaas field each becomes. Written once so the reader
 * and the writer below cannot disagree about the shape. */
const PROFILE_FIELDS = [
  'billing_legal_name', 'billing_trade_name', 'billing_tax_id', 'billing_municipal_inscription',
  'billing_postal_code', 'billing_address', 'billing_address_number',
  'billing_complement', 'billing_province', 'billing_phone', 'billing_contact_email',
];

router.get('/billing-profile', requireAuth, resolveTenancy, requireWorkspaceAdmin, (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });

  const ws = db.prepare(
    `SELECT name, asaas_customer_id, ${PROFILE_FIELDS.join(', ')} FROM workspaces WHERE id = ?`
  ).get(req.workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  res.json({
    ...ws,
    // The workspace's display name, so the form can show what the nota fiscal WOULD carry when no
    // legal name has been entered — rather than an empty field the reader has to guess about.
    fallback_name: ws.name,
    tax_id_kind: brFiscal.taxIdKind(ws.billing_tax_id),
    // Whether Asaas already holds a copy. Shown because the state that confuses people is having
    // corrected something here while the document still carries the old value.
    synced: !!ws.asaas_customer_id,
  });
});

router.put('/billing-profile', requireAuth, resolveTenancy, requireWorkspaceAdmin, async (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const b = req.body || {};

  /*
   * VALIDATED HERE, AT THE KEYBOARD, because the alternative is discovering it at emission time —
   * weeks later, with the customer already paid and the person who mistyped it long gone from the
   * page. Both documents carry check digits precisely so this is catchable now.
   */
  const taxId = b.billing_tax_id === undefined ? undefined : brFiscal.digits(b.billing_tax_id);
  if (taxId !== undefined && taxId !== '' && !brFiscal.isValidTaxId(taxId)) {
    return res.status(400).json({ error: 'CPF/CNPJ inválido — confira os dígitos.', code: 'INVALID_TAX_ID' });
  }

  const cep = b.billing_postal_code === undefined ? undefined : brFiscal.digits(b.billing_postal_code);
  if (cep !== undefined && cep !== '' && !brFiscal.isValidCEP(cep)) {
    return res.status(400).json({ error: 'CEP inválido — são oito dígitos.', code: 'INVALID_CEP' });
  }

  if (b.billing_contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.billing_contact_email).trim())) {
    return res.status(400).json({ error: 'E-mail de cobrança inválido.', code: 'INVALID_EMAIL' });
  }

  /*
   * An omitted field is left alone; a field sent EMPTY is cleared. The difference matters: the form
   * sends everything it renders, so "" is a deliberate erasure by somebody looking at the field,
   * while absence means a caller that never had it.
   */
  const sets = [];
  const values = [];
  for (const col of PROFILE_FIELDS) {
    if (b[col] === undefined) continue;
    let v = b[col] === null ? '' : String(b[col]).trim();
    if (col === 'billing_tax_id') v = taxId;
    if (col === 'billing_postal_code') v = cep;
    sets.push(`${col} = ?`);
    values.push(v === '' ? null : v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para salvar.' });

  db.prepare(`UPDATE workspaces SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(...values, req.workspaceId);

  /*
   * Push it to Asaas now, and REPORT whether that worked.
   *
   * Best-effort-and-silent is what made the old behaviour so hard to unpick: the address is right
   * on this screen and wrong on the document, with nothing anywhere explaining the gap. The save
   * has already happened either way — this only says whether the copy Asaas holds matches it.
   */
  let synced = false;
  let syncError = null;
  const ws = db.prepare('SELECT billing_tax_id FROM workspaces WHERE id = ?').get(req.workspaceId);
  if (asaas.configured() && ws?.billing_tax_id) {
    try { await asaas.syncCustomer(req.workspaceId); synced = true; }
    catch (err) {
      syncError = err.message;
      console.warn(`[billing] customer sync failed for ${req.workspaceId}: ${err.message}`);
    }
  }

  /*
   * THE TENANT TAKES THE COMPANY'S NAME, automatically and without asking.
   *
   * Chosen deliberately over suggesting it. The name is what identifies a customer in support —
   * "the Padaria" has to find something called the Padaria — and a rename that waits for somebody
   * to press a button is a rename that mostly does not happen.
   *
   * WHAT THIS COSTS, stated plainly because it is a real cost: a customer who had named their
   * workspace themselves loses that name. It was weighed and accepted; findability in support won.
   * They can rename it again afterwards, and this only fires when the company name itself changes.
   *
   * The TRADE name, falling back to the legal one. "Alves Comércio de Alimentos LTDA" belongs on a
   * nota fiscal, not in somebody's sidebar every day for the next five years.
   */
  const named = db.prepare('SELECT name, billing_trade_name, billing_legal_name FROM workspaces WHERE id = ?').get(req.workspaceId);
  const wanted = (named.billing_trade_name || '').trim() || (named.billing_legal_name || '').trim();
  let renamed = null;
  if (wanted && wanted !== named.name) {
    db.prepare("UPDATE workspaces SET name = ?, updated_at = strftime('%s','now') WHERE id = ?").run(wanted, req.workspaceId);
    renamed = wanted;
    logActivity(req.user.id, 'workspace_renamed_from_company', `${named.name} -> ${wanted}`, null, getClientIp(req), req.workspaceId);
  }

  logActivity(req.user.id, 'billing_profile_updated', sets.length + ' campo(s)', null, getClientIp(req), req.workspaceId);
  res.json({ ok: true, synced, sync_error: syncError, renamed });
});

// What the workspace owes for a closed month, with the licence-day evidence behind it.
router.get('/invoices', requireAuth, resolveTenancy, (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const rows = db.prepare(
    `SELECT month, plan_id, license_days, days_in_month, avg_screens, price_per_device,
            amount_cents, currency, due_date, status, asaas_charge_id, paid_at
       FROM workspace_invoices WHERE workspace_id = ? ORDER BY month DESC LIMIT 24`
  ).all(req.workspaceId);
  res.json(rows.map((r) => ({ ...r, amount: r.amount_cents / 100 })));
});

// Admin: assign plan to user
router.post('/assign', requireAuth, requireSuperAdmin, (req, res) => {
  const { user_id, plan_id } = req.body;
  if (!user_id || !plan_id) return res.status(400).json({ error: 'user_id and plan_id required' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare("UPDATE users SET plan_id = ?, subscription_status = 'active', updated_at = strftime('%s','now') WHERE id = ?")
    .run(plan_id, user_id);

  res.json({ success: true, plan: plan.display_name });
});

// Admin: update plan details
router.put('/plans/:id', requireAuth, requireAdmin, (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const { display_name, max_devices, max_storage_mb, remote_control, remote_url,
          priority_support, price_monthly, price_yearly, active } = req.body;

  const updates = [];
  const values = [];
  if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
  if (max_devices !== undefined) { updates.push('max_devices = ?'); values.push(max_devices); }
  if (max_storage_mb !== undefined) { updates.push('max_storage_mb = ?'); values.push(max_storage_mb); }
  if (remote_control !== undefined) { updates.push('remote_control = ?'); values.push(remote_control ? 1 : 0); }
  if (remote_url !== undefined) { updates.push('remote_url = ?'); values.push(remote_url ? 1 : 0); }
  if (priority_support !== undefined) { updates.push('priority_support = ?'); values.push(priority_support ? 1 : 0); }
  if (price_monthly !== undefined) { updates.push('price_monthly = ?'); values.push(price_monthly); }
  if (price_yearly !== undefined) { updates.push('price_yearly = ?'); values.push(price_yearly); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Admin: create custom plan
router.post('/plans', requireAuth, requireAdmin, (req, res) => {
  const { id, name, display_name, max_devices, max_storage_mb, remote_control,
          remote_url, priority_support, price_monthly, price_yearly } = req.body;

  if (!id || !name || !display_name) return res.status(400).json({ error: 'id, name, and display_name required' });

  const existing = db.prepare('SELECT id FROM plans WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Plan ID already exists' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM plans').get().max_order || 0;

  db.prepare(`
    INSERT INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url,
                       priority_support, price_monthly, price_yearly, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, display_name, max_devices || 2, max_storage_mb || 500,
         remote_control ? 1 : 0, remote_url ? 1 : 0, priority_support ? 1 : 0,
         price_monthly || 0, price_yearly || 0, maxOrder + 1);

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  res.status(201).json(plan);
});

// Stripe webhook (if configured)
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!config.stripeSecretKey) return res.status(404).json({ error: 'Stripe not configured' });

  // TODO: Implement Stripe webhook handling
  // - customer.subscription.created -> activate plan
  // - customer.subscription.updated -> update plan
  // - customer.subscription.deleted -> downgrade to free
  // - invoice.payment_succeeded -> extend subscription
  // - invoice.payment_failed -> mark as past_due

  res.json({ received: true });
});

module.exports = router;
