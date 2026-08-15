const { db } = require('../db/database');
const config = require('../config');

const TRIAL_DAYS = 14;

function getUserPlan(userId) {
  const user = db.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly,
           p.widgets_enabled, p.sublists_enabled, p.layouts_enabled,
           p.min_devices, p.price_per_device, p.currency
    FROM users u
    JOIN plans p ON u.plan_id = p.id
    WHERE u.id = ?
  `).get(userId);

  // No user row (or no joinable plan) — return null so callers treat it as unrestricted
  // (checkDeviceAccess: `if (!plan) return { allowed: true }`). Previously the else branch
  // below dereferenced an undefined `user` ("Cannot set properties of undefined"), which — once
  // a claimed device's reclaim runs checkDeviceAccess — was swallowed by the caller's try/catch
  // and silently dropped the device to the provision-fresh path instead of reclaiming it.
  if (!user) return null;

  // Check if trial has expired
  if (user.trial_started) {
    const trialEnd = user.trial_started + (TRIAL_DAYS * 86400);
    const now = Math.floor(Date.now() / 1000);
    user.trial_active = now < trialEnd;
    user.trial_days_left = Math.max(0, Math.ceil((trialEnd - now) / 86400));
    user.trial_end = trialEnd;

    // Auto-downgrade an EXPIRED trial to free. Keyed on "no real paid subscription"
    // (stripe_subscription_id IS NULL) plus "still on the plan the trial granted"
    // (plan_id === trial_plan) — deliberately NOT on subscription_status.
    //
    // TRAP — do not reintroduce a subscription_status guard here: that column DEFAULTs to
    // 'active' and is only ever changed by Stripe webhook events. A `subscription_status !==
    // 'active'` check is therefore ALWAYS false for trial users who never touch Stripe — the
    // entire population this is meant to catch — so the downgrade never fired and every signup
    // kept Pro free forever.
    //
    // The `plan_id === user.trial_plan` clause is load-bearing: it protects comped / hand-
    // granted plans (e.g. an enterprise plan set manually, where plan_id !== trial_plan) from
    // being silently downgraded. Grandfathered users (trial_started IS NULL) never reach this
    // block at all.
    if (!user.trial_active && !user.stripe_subscription_id && user.plan_id === user.trial_plan && user.plan_name !== 'free') {
      db.prepare("UPDATE users SET plan_id = 'free', trial_started = NULL WHERE id = ?").run(userId);
      // Re-fetch with free plan
      return getUserPlan(userId);
    }
  } else {
    user.trial_active = false;
    user.trial_days_left = 0;
  }

  return user;
}

function getUserDeviceCount(userId) {
  return db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(userId).count;
}

function getUserStorageMB(userId) {
  const result = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE user_id = ?').get(userId);
  return Math.ceil(result.total / (1024 * 1024));
}

// --- Workspace-scoped plan resolution ----------------------------------------------------
//
// Loop OS sells per WORKSPACE: the workspace owns the screens and is what gets invoiced.
// Plans historically hung off users.plan_id, which means a paid owner who invites a
// colleague on the free tier would have that colleague's uploads judged against the
// COLLEAGUE's plan. workspaces.plan_id fixes that; NULL there means "inherit from the
// workspace owner", so every workspace created before this column behaves exactly as before.
//
// Returns the same shape as getUserPlan() so both feed the same checks.
function getWorkspacePlan(workspaceId) {
  if (!workspaceId) return null;

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return null;

  // No plan of its own — fall back to the owner's, preserving pre-Loop-OS behaviour.
  if (!ws.plan_id) return ws.created_by ? getUserPlan(ws.created_by) : null;

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(ws.plan_id);
  if (!plan) return ws.created_by ? getUserPlan(ws.created_by) : null;

  return {
    plan_id: plan.id,
    plan_name: plan.name,
    plan_display_name: plan.display_name,
    max_devices: plan.max_devices,
    min_devices: plan.min_devices,
    max_storage_mb: plan.max_storage_mb,
    remote_control: plan.remote_control,
    remote_url: plan.remote_url,
    priority_support: plan.priority_support,
    price_monthly: plan.price_monthly,
    price_yearly: plan.price_yearly,
    price_per_device: plan.price_per_device,
    currency: plan.currency,
    widgets_enabled: plan.widgets_enabled,
    sublists_enabled: plan.sublists_enabled,
    layouts_enabled: plan.layouts_enabled,
    subscription_status: ws.subscription_status,
    subscription_ends: ws.subscription_ends,
    asaas_customer_id: ws.asaas_customer_id,
    // No asaas_subscription_id: billing is in arrears, one charge per closed month, so there is
    // no running subscription object. The column stays for now but nothing reads it.
    // A workspace subscription is billed directly; trials are a user-signup concept.
    trial_active: false,
    trial_days_left: 0,
  };
}

// The plan that governs THIS request. resolveTenancy sets req.workspaceId; routes that run
// without it (or before it) fall back to the caller's own plan, which is the pre-existing
// behaviour every current check relies on.
function getRequestPlan(req) {
  return getWorkspacePlan(req.workspaceId) || (req.user ? getUserPlan(req.user.id) : null);
}

function getWorkspaceDeviceCount(workspaceId) {
  return db.prepare('SELECT COUNT(*) as count FROM devices WHERE workspace_id = ?').get(workspaceId).count;
}

function getWorkspaceStorageMB(workspaceId) {
  const result = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE workspace_id = ?').get(workspaceId);
  return Math.ceil(result.total / (1024 * 1024));
}

// Check if the workspace can add more devices.
//
// max_devices is a plain quota again. It used to need an "effective limit" that looked past the
// plan to the top price band, because the plan was DERIVED from the screen count and a Premium
// workspace had to be able to add the screen that promoted it. Plans are now chosen for their
// features and billed per licence-day, so a paid plan simply has no ceiling (-1) and Free's 1
// is a real limit — crossing it means choosing a paid plan, which is an explicit decision.
function checkDeviceLimit(req, res, next) {
  const plan = getRequestPlan(req);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  const limit = plan.max_devices;
  // -1 means unlimited
  if (limit === -1) return next();

  // Count within the WORKSPACE when there is one: screens belong to the workspace that is
  // billed for them, not to whichever member happened to pair them.
  const deviceCount = req.workspaceId ? getWorkspaceDeviceCount(req.workspaceId) : getUserDeviceCount(req.user.id);
  if (deviceCount >= limit) {
    return res.status(403).json({
      error: `Device limit reached (${limit} on ${plan.plan_display_name} plan). Upgrade to add more.`,
      code: 'DEVICE_LIMIT',
      current: deviceCount,
      limit,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if the workspace can upload more content
function checkStorageLimit(req, res, next) {
  const plan = getRequestPlan(req);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // -1 means unlimited
  if (plan.max_storage_mb === -1) return next();

  const usedMB = req.workspaceId ? getWorkspaceStorageMB(req.workspaceId) : getUserStorageMB(req.user.id);
  if (usedMB >= plan.max_storage_mb) {
    return res.status(403).json({
      error: `Storage limit reached (${plan.max_storage_mb}MB on ${plan.plan_display_name} plan). Upgrade for more.`,
      code: 'STORAGE_LIMIT',
      current_mb: usedMB,
      limit_mb: plan.max_storage_mb,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if user has remote control access
function checkRemoteControl(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan || !plan.remote_control) {
    return res.status(403).json({
      error: 'Remote control requires Starter plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

// Check remote URL feature access
function checkRemoteUrl(req, res, next) {
  const plan = getUserPlan(req.user.id);
  if (!plan || !plan.remote_url) {
    return res.status(403).json({
      error: 'Remote URL content requires Pro plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

// --- Loop OS feature gates ---------------------------------------------------------------
//
// One factory for the three plan flags (widgets_enabled / sublists_enabled / layouts_enabled).
// Same 403 + FEATURE_LOCKED contract the remote-control and remote-URL gates already use, so
// the frontend's existing "upgrade required" handling picks these up without changes; `feature`
// is added so the UI can name the specific thing that was blocked.
//
// SELF_HOSTED bypasses every gate — that flag already means "this install is not billed"
// (see checkActiveSubscription below and the enterprise plan handed to the first user).
function requirePlanFeature(flag, label) {
  return function planFeatureGate(req, res, next) {
    if (config.selfHosted) return next();

    const plan = getRequestPlan(req);
    if (!plan || !plan[flag]) {
      return res.status(403).json({
        error: `${label} requires the Premium plan or above.`,
        code: 'FEATURE_LOCKED',
        feature: flag,
        plan: plan?.plan_name,
      });
    }
    next();
  };
}

const checkWidgetsEnabled  = requirePlanFeature('widgets_enabled',  'Widgets');
const checkSublistsEnabled = requirePlanFeature('sublists_enabled', 'Playlist sub-lists');
// Layouts are Corporativo-only, so the generic "Premium or above" wording would be wrong.
function checkLayoutsEnabled(req, res, next) {
  if (config.selfHosted) return next();

  const plan = getRequestPlan(req);
  if (!plan || !plan.layouts_enabled) {
    return res.status(403).json({
      error: 'Layouts require the Corporativo plan.',
      code: 'FEATURE_LOCKED',
      feature: 'layouts_enabled',
      plan: plan?.plan_name,
    });
  }
  next();
}

// Check subscription is active (not expired, not suspended for non-payment)
function checkActiveSubscription(req, res, next) {
  // Workspace-scoped: suspension is recorded on the workspace, which is what gets invoiced.
  const plan = getRequestPlan(req);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // Self-hosted mode doesn't check expiry
  if (config.selfHosted) return next();

  // Suspension outranks the free-plan shortcut below. Billing is in ARREARS, so an unpaid month
  // has ALREADY been delivered — by the time services/tenant-invoicing.js sets this status the
  // grace period past the due date is spent, and refusing further work is the only lever left.
  // Deliberately checked before the free-plan exit: a workspace must not be able to walk away
  // from what it owes by downgrading itself to Free.
  if (plan.subscription_status === 'suspended') {
    return res.status(403).json({
      error: 'Workspace suspended for an overdue invoice. Settle it to restore access.',
      code: 'SUBSCRIPTION_SUSPENDED'
    });
  }

  // Free plan is always active
  if (plan.plan_name === 'free') return next();

  // Check if subscription has expired
  if (plan.subscription_status !== 'active' && plan.subscription_ends && plan.subscription_ends < Math.floor(Date.now() / 1000)) {
    return res.status(403).json({
      error: 'Subscription expired. Please renew to continue.',
      code: 'SUBSCRIPTION_EXPIRED'
    });
  }
  next();
}

module.exports = {
  getUserPlan,
  getUserDeviceCount,
  getUserStorageMB,
  getWorkspacePlan,
  getRequestPlan,
  getWorkspaceDeviceCount,
  getWorkspaceStorageMB,
  checkDeviceLimit,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  requirePlanFeature,
  checkWidgetsEnabled,
  checkSublistsEnabled,
  checkLayoutsEnabled,
  checkActiveSubscription
};
