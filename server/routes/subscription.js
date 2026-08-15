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
const config = require('../config');

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
  // What the NEXT invoice would be at today's screen count — null on the free tier.
  const quote = asaas.priceFor(deviceCount);

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
    // Per-screen quote for the current headcount: which band it lands in and the total.
    quote: quote ? {
      screens: quote.screens,
      band: quote.band.id,
      band_display_name: quote.band.display_name,
      price_per_device: quote.band.price_per_device,
      total: quote.total,
      currency: quote.currency,
    } : null,
    subscription: {
      status: plan.subscription_status,
      ends: plan.subscription_ends,
      provider: config.billingProvider,
      stripe_customer_id: plan.stripe_customer_id,
      stripe_subscription_id: plan.stripe_subscription_id,
      asaas_customer_id: plan.asaas_customer_id,
      asaas_subscription_id: plan.asaas_subscription_id,
    },
    trial: {
      active: plan.trial_active || false,
      days_left: plan.trial_days_left || 0,
      end: plan.trial_end ? new Date(plan.trial_end * 1000).toISOString() : null,
      plan: plan.trial_plan || null,
    },
    self_hosted: config.selfHosted,
  });
});

// --- Asaas subscription lifecycle ---------------------------------------------------------
// Opening and cancelling a paid subscription are explicit, workspace-admin actions. Moving
// BETWEEN paid bands is not here on purpose — that happens automatically as screens are added
// or removed (services/asaas.js onDeviceCountChanged).

function requireWorkspaceAdmin(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context.' });
  if (req.workspaceRole !== 'workspace_admin' && !req.orgRole && !req.isPlatformAdmin) {
    return res.status(403).json({ error: 'Only a workspace admin can change the subscription.' });
  }
  next();
}

router.post('/asaas/subscribe', requireAuth, resolveTenancy, requireWorkspaceAdmin, async (req, res) => {
  if (config.billingProvider !== 'asaas') return res.status(409).json({ error: `BILLING_PROVIDER is '${config.billingProvider}', not 'asaas'` });
  if (!asaas.configured()) return res.status(503).json({ error: 'Asaas not configured' });

  // The payer's CPF/CNPJ is required by Asaas and is captured here rather than at signup,
  // since a workspace only needs it at the moment it starts paying.
  const { tax_id, billing_email } = req.body || {};
  if (tax_id) {
    db.prepare("UPDATE workspaces SET billing_tax_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(String(tax_id).replace(/\D/g, ''), req.workspaceId);
  }
  if (billing_email) {
    db.prepare("UPDATE workspaces SET billing_contact_email = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(billing_email, req.workspaceId);
  }

  try {
    const result = await asaas.subscribe(req.workspaceId);
    res.status(201).json({
      subscription_id: result.subscription.id,
      plan: result.band.id,
      screens: result.screens,
      total: result.total,
      currency: result.currency,
    });
  } catch (err) {
    console.error(`[asaas] subscribe failed for workspace ${req.workspaceId}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

router.post('/asaas/cancel', requireAuth, resolveTenancy, requireWorkspaceAdmin, async (req, res) => {
  if (!asaas.configured()) return res.status(503).json({ error: 'Asaas not configured' });
  try {
    const done = await asaas.cancelSubscription(req.workspaceId);
    if (!done) return res.status(404).json({ error: 'No active subscription for this workspace' });
    res.json({ success: true });
  } catch (err) {
    console.error(`[asaas] cancel failed for workspace ${req.workspaceId}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
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
