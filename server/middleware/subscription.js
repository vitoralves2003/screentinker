const { db } = require('../db/database');
const config = require('../config');

const TRIAL_DAYS = 14;

/*
 * QUANTO ESPACO ESTE CLIENTE TEM, DE VERDADE.
 *
 * O teto nao e uma coluna: e max_storage_mb + storage_mb_per_unit x unidades, limitado por
 * storage_mb_cap quando ele existe. "Unidade" e sempre a mesma coisa que o plano cobra --
 * a tela no Pro, o pacote no Master -- para nao haver duas definicoes de unidade no produto.
 *
 * ISSO EXISTE PARA O MASTER NAO TER MENOS ESPACO QUE O PRO. Com um teto fixo de 25 GB, um
 * Pro de 26 telas (26 GB) passaria na frente de um Master de 40, que paga o dobro: subir de
 * plano REDUZIRIA o armazenamento, e ninguem descobriria isso antes de um cliente reclamar.
 *
 * O MINIMO DE UMA UNIDADE tambem e deliberado. Um cliente que acabou de assinar e ainda nao
 * ligou a primeira tela tem zero unidades, e sem esse minimo o teto dele seria zero -- ou
 * seja, ele nao conseguiria subir o primeiro arquivo antes de ter a tela na parede, que e
 * exatamente a ordem inversa de como um cliente comeca. Nao custa nada: armazenamento e
 * cobranca sao contas separadas, e a cobranca continua olhando so as telas que existiram.
 */
function effectiveStorageMB(plan, scope) {
  if (!plan) return 0;
  if (plan.max_storage_mb === -1) return -1;                       // ilimitado, passa direto

  const perUnit = plan.storage_mb_per_unit || 0;
  if (!perUnit) return plan.max_storage_mb;                        // teto fixo: Free e Gestao

  let screens = 0;
  if (scope && scope.workspaceId) {
    screens = db.prepare('SELECT COUNT(*) c FROM devices WHERE workspace_id = ?').get(scope.workspaceId).c;
  } else if (scope && scope.userId) {
    screens = db.prepare('SELECT COUNT(*) c FROM devices WHERE user_id = ?').get(scope.userId).c;
  }

  const units = plan.package_size > 0 ? Math.ceil(screens / plan.package_size) : screens;
  let limit = (plan.max_storage_mb || 0) + perUnit * Math.max(1, units);
  if (plan.storage_mb_cap > 0 && limit > plan.storage_mb_cap) limit = plan.storage_mb_cap;
  return limit;
}

function getUserPlan(userId) {
  const user = db.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly,
           p.widgets_enabled, p.sublists_enabled, p.layouts_enabled, p.gestao_enabled,
           p.min_devices, p.price_per_device, p.currency,
           -- Sem estas tres, effectiveStorageMB nao ve o teto por unidade e devolve
           -- max_storage_mb cru -- que no Pro e no Master e ZERO, e bloqueia todo upload.
           p.storage_mb_per_unit, p.storage_mb_cap, p.package_size
    FROM users u
    JOIN plans p ON u.plan_id = p.id
    WHERE u.id = ?
  `).get(userId);

  // O teto de armazenamento e calculado, nunca lido cru: ver effectiveStorageMB acima.
  if (user) user.max_storage_mb = effectiveStorageMB(user, { userId });

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
    max_storage_mb: effectiveStorageMB(plan, { workspaceId: ws.id }),
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
    /*
     * FALTAVA, e a falta era invisivel: este mapa e uma lista FIXA de campos, entao uma coluna
     * ausente vira `undefined` em vez de erro. O plano master tem gestao_enabled=1 no banco e
     * /subscription/me respondia false -- e a tela que depende disso simplesmente nao apareceria,
     * sem nada quebrar em lugar nenhum.
     */
    gestao_enabled: plan.gestao_enabled,
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
      error: `Armazenamento cheio: ${usedMB} MB de ${plan.max_storage_mb} MB no plano `
        + `${plan.plan_display_name}. Apague arquivos ou contrate um pacote de 5 GB.`,
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
function requirePlanFeature(flag, label, planoMinimo = 'Pró') {
  return function planFeatureGate(req, res, next) {
    if (config.selfHosted) return next();

    const plan = getRequestPlan(req);
    if (!plan || !plan[flag]) {
      return res.status(403).json({
        error: `${label} faz parte do plano ${planoMinimo} ou superior.`,
        code: 'FEATURE_LOCKED',
        feature: flag,
        plan: plan?.plan_name,
      });
    }
    next();
  };
}

const checkWidgetsEnabled  = requirePlanFeature('widgets_enabled',  'Widgets');
/*
 * A FRASE QUE O CLIENTE FREE LE, e ela estava errada em tres coisas ao mesmo tempo.
 *
 * Era "Playlist sub-lists requires the Premium plan or above": em ingles, depois de o produto
 * ter ficado so em portugues; falando de "sub-lists", um conceito que ninguem precisa
 * aprender para usar o produto; e citando um plano PREMIUM que nao existe -- os planos sao
 * Free, Pro, Master e Gestao avulsa.
 *
 * Uma recusa que nomeia um plano inexistente nao e so feia: ela manda a pessoa procurar algo
 * que nao esta a venda.
 */
const checkSublistsEnabled = requirePlanFeature(
  'sublists_enabled',
  'Adicionar uma lista a uma tela',
  'Pró',
);
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

/*
 * THE DUNNING GATE — what "suspended" actually costs the tenant.
 *
 * Until now it cost nothing. checkActiveSubscription below has existed, correct and exported,
 * since the billing work landed, and was never mounted on a single route: a tenant marked
 * suspended in the database carried on uploading, publishing and pairing screens exactly as
 * before. The collection lever was a flag nothing read.
 *
 * WHY THIS REFUSES BY METHOD RATHER THAN BY ROUTE. Two reasons, and the first is the important
 * one: a suspended tenant MUST still be able to sign in, read their own account and reach the
 * payment link. A gate that refuses everything refuses the one action that ends the suspension,
 * which turns a five-day-late invoice into a support call and then into a lost customer. The
 * second is that an allowlist of write routes is a list somebody has to remember to add to; a
 * method check covers the route added next year by construction.
 *
 * WHAT IS DELIBERATELY NOT HERE: the screens. Play logging arrives over the device socket, not
 * this API, and content already downloaded keeps playing. That is the whole point of the first
 * stage — the shopkeeper's window stays lit while their panel stops accepting changes. Stage two
 * (CUT) is enforced in ws/deviceSocket.js, where the screens actually connect.
 */
const DUNNING_BLOCKED = new Set(['suspended', 'cut']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function dunningGate(req, res, next) {
  // Self-hosted installs are not invoiced at all, so there is nothing to enforce.
  if (config.selfHosted) return next();
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.workspaceId) return next();

  /*
   * Read the workspace row directly rather than going through getRequestPlan(). That helper
   * falls back to the OWNER's user record when a workspace has no plan of its own, and
   * users.subscription_status is a different column with a different history — it defaults to
   * 'active' and is only ever written by the old Stripe path. Reading it here would mean a
   * legacy workspace could never be suspended, silently, for exactly the tenants most likely to
   * be on an old plan.
   */
  const ws = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(req.workspaceId);
  if (!ws || !DUNNING_BLOCKED.has(ws.subscription_status)) return next();

  return res.status(403).json({
    error: ws.subscription_status === 'cut'
      ? 'Acesso interrompido por fatura em aberto. Regularize o pagamento para voltar a operar.'
      : 'Painel bloqueado por fatura vencida. As telas seguem exibindo o conteúdo já publicado.',
    code: 'SUBSCRIPTION_SUSPENDED',
    status: ws.subscription_status,
  });
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
  if (plan.subscription_status === 'suspended' || plan.subscription_status === 'cut') {
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
  effectiveStorageMB,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  requirePlanFeature,
  checkWidgetsEnabled,
  checkSublistsEnabled,
  checkLayoutsEnabled,
  checkActiveSubscription,
  dunningGate
};
