const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

// Audience marker for the pre-TOTP token minted by below.
// Session tokens (generateToken, and the recovery token from scripts/reset-admin.js)
// carry NO `aud`, so verifyToken can refuse anything that does. That way a token minted
// for one narrow purpose can only be redeemed through its own accessor, and a future
// hand-rolled verify site that forgets a check fails CLOSED instead of accepting a
// half-authenticated token.
/*
 * ESTE GUARDA FICA, mesmo sem ninguém emitir mais um token destes.
 *
 * A segunda etapa foi removida, então nenhum token intermediário novo nasce. Mas os que já
 * foram emitidos continuam válidos até expirar, e um deles é meio-autenticado por definição:
 * a senha foi conferida e o segundo fator não. Aceitá-lo como sessão seria dar acesso a quem
 * parou no meio do caminho.
 *
 * Custa quatro linhas e cobre a janela. Quando ela passar, sai sozinho.
 */
const MFA_TOKEN_AUDIENCE = 'st:mfa';

// Raised when a token is cryptographically valid but is not a usable session: the TOTP
// step is outstanding, the user row is gone, or a forced password change is pending.
// `code` lets each caller map the outcome onto the status/body it already returned, so
// no existing response shape changes.
class SessionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SessionError';
    this.code = code;
  }
}

// Phase 2.1: JWT now optionally carries the user's current workspace_id so
// the tenancy middleware can resolve scope without an extra DB lookup on
// every request. Callers that don't know the workspace yet (legacy paths,
// recovery tokens) pass null and the tenancy resolver falls back to the
// user's first accessible workspace.
/*
 * O TOKEN DA SESSÃO — e ele passou a carregar de quem é a conta e qual é o papel.
 *
 * ── POR QUE ESTES CAMPOS NOVOS ───────────────────────────────────────────────────────────
 * Este token é agora a ÚNICA sessão do produto: a Gestão o aceita direto, em vez de trocá-lo
 * por um dela através de um token federado de 60 segundos. Para isso ela precisa das mesmas
 * três coisas que o token de troca carregava — a organização, o papel e se é acesso de
 * suporte —, porque o banco dela não tem workspaces para deduzi-las.
 *
 * Não é informação nova: é a mesma que a entrada federada já entregava. O que muda é que ela
 * viaja UMA vez, no token que a pessoa já tem, em vez de num segundo token pedido a cada
 * travessia.
 *
 * ── POR QUE CALCULADO AQUI, E NÃO PASSADO POR QUEM CHAMA ─────────────────────────────────
 * `generateToken` é chamado de quatro lugares em routes/auth.js e de VINTE E QUATRO testes.
 * Mudar a assinatura quebraria os vinte e quatro — e num dia em que algo falhasse, ninguém
 * saberia se foi a sessão nova ou a mudança de assinatura.
 *
 * Os dois argumentos que ele já recebe bastam: organização e papel derivam de (usuário,
 * workspace), e este arquivo já tem o banco. Quem chama não muda uma linha.
 *
 * ── O QUE ISTO CONGELA, E POR QUE ESTÁ BEM ───────────────────────────────────────────────
 * O papel é decidido no momento em que o token nasce. Se alguém for rebaixado depois, o token
 * antigo continua dizendo TITULAR até expirar ou até um novo ser emitido.
 *
 * Isso NÃO é uma regressão: hoje a Gestão grava o papel na linha do usuário dela na entrada
 * federada, e ele fica lá até a próxima entrada — o que dura mais. E as travas que importam
 * não dependem deste campo: a Operação recalcula canAdmin a cada requisição, e a Gestão
 * continua recusando pela sua própria porta.
 */
// Quanto vale uma sessao de quem esta atendendo a conta de outra empresa. Ver o comentario
// dentro de generateToken, no jwt.sign.
const SESSAO_DE_SUPORTE = '30m';

function generateToken(user, currentWorkspaceId) {
  const extra = {};

  if (currentWorkspaceId) {
    try {
      const ws = db.prepare('SELECT id, organization_id FROM workspaces WHERE id = ?').get(currentWorkspaceId);
      if (ws && ws.organization_id) {
        const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ws.organization_id);
        extra.organization_id = ws.organization_id;
        extra.organization_name = (org && org.name) || '';

        /*
         * TITULAR é canAdmin, e canAdmin é um OU de TRÊS fontes: papel de plataforma, papel na
         * organização e papel no workspace. Reimplementar a conta aqui criaria um segundo
         * critério de "quem administra" — e dois critérios que concordam hoje discordam depois
         * que alguém mexer num deles. canAdminWorkspace é o que já responde isso.
         */
        const { canAdminWorkspace } = require('../lib/permissions');
        const tenantPlan = require('../lib/tenant-plan');
        extra.papel = canAdminWorkspace(db, user, ws) ? 'TITULAR' : 'OPERADOR';

        /*
         * ACESSO DE SUPORTE: quem chegou a este workspace por ser administrador de plataforma,
         * e não por ser membro dele. A Gestão pinta a barra de vermelho com isto, e o registro
         * precisa distinguir "o dono abriu o financeiro" de "nós abrimos o financeiro dele".
         */
        const membro = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(ws.id, user.id);
        extra.acting_as = !membro && isPlatformRole(user.role);

        /*
         * A GESTÃO É UM DIREITO DO PLANO, e este passou a ser o lugar que carrega a resposta.
         *
         * A trava vivia em POST /api/auth/federation/gestao, que era a única porta para o outro
         * módulo e por isso o único lugar que precisava decidir. Essa porta deixou de existir:
         * com uma sessão só, o navegador fala com a API da Gestão direto.
         *
         * Sem mover a trava junto, apagar a rota entregaria clientes, contratos e financeiro a
         * quem está no plano Free — e em silêncio, porque o menu já esconde os itens e ninguém
         * clicaria para descobrir. Esconder um botão nunca foi a trava; era isto aqui.
         *
         * Quem DECIDE continua sendo a Operação, que é onde plano e cobrança moram. Quem
         * RECUSA agora é o guarda da Gestão, que é onde fica a porta. O token é o que liga um
         * ao outro, do mesmo jeito que já faz com o papel.
         *
         * O administrador de plataforma passa: é ele quem dá suporte, e o plano do cliente não
         * deveria decidir se o dono do sistema consegue ajudar.
         */
        const plano = tenantPlan.planRowFor(ws.id);
        extra.gestao_enabled = isPlatformRole(user.role) || !!(plano && plano.gestao_enabled);
        /*
         * Fase B da migração de backend: as rotas da Operação portadas para a outra casa
         * leem o plano DO TOKEN, no mesmo padrão de gestao_enabled — o token traz a
         * resposta pronta; quem decide continua sendo este lado, onde plano e cobrança
         * moram. Token antigo não traz os campos e o outro lado trata como "não tem".
         */
        extra.operacao_enabled = isPlatformRole(user.role) || !!(plano && plano.operacao_enabled);
        extra.layouts_enabled = isPlatformRole(user.role) || !!(plano && plano.layouts_enabled);
        extra.widgets_enabled = isPlatformRole(user.role) || !!(plano && plano.widgets_enabled);
      }
    } catch (e) {
      /*
       * Sem os campos extras o token continua sendo uma sessão VÁLIDA da Operação — só não
       * abre a Gestão. Deixar de emitir sessão porque uma consulta acessória falhou seria
       * trocar "metade do produto" por "nenhum".
       */
    }
  }

  /*
   * SESSAO DE SUPORTE DURA 30 MINUTOS, NAO SETE DIAS.
   *
   * Esta regra vinha da rota de travessia, que emitia uma sessao curta para quem entrava na
   * Gestao de um cliente. O comentario dela dizia o motivo, e ele nao mudou: um acesso a
   * contratos, cobrancas e extrato bancario de OUTRA empresa nao deveria continuar aberto
   * depois que a pessoa parou de olhar.
   *
   * Apagar aquela rota apagaria isto junto, e a sessao de suporte passaria a durar o mesmo
   * que a de um cliente comum -- config.jwtExpiry, que sao SETE DIAS. Nada daria erro; a
   * janela so ficaria trezentas e trinta e seis vezes maior, e ninguem teria como notar.
   *
   * Aqui e o lugar certo para ela morar: e onde se sabe que este acesso e de suporte, e vale
   * para a Operacao tambem. Antes so encurtava a sessao da Gestao -- ver as telas de outra
   * empresa ficava aberto a semana inteira.
   */
  const prazo = extra.acting_as ? SESSAO_DE_SUPORTE : config.jwtExpiry;

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name || '',
      role: user.role,
      current_workspace_id: currentWorkspaceId || null,
      ...extra,
    },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: prazo }
  );
}

// Verify a SESSION token. Rejects any token carrying an audience: those are minted for a
// single narrower purpose and must go through their own accessor (),
// never through a session path.
function verifyToken(token) {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (decoded && decoded.aud !== undefined) {
    // The pre-TOTP audience is a KNOWN narrow purpose: report it as such so callers can
    // still tell the client to complete MFA rather than "your token is broken". Any other
    // audience is unrecognised here and refused generically - the fail-closed default.
    const aud = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
    if (aud.includes(MFA_TOKEN_AUDIENCE)) throw new SessionError('mfa_required');
    throw new SessionError('invalid_audience', 'token is scoped to another purpose');
  }
  return decoded;
}

// Synthetic user record for recovery tokens (scripts/reset-admin.js). Not
// persisted; only exists for the lifetime of the request.
function recoveryUser(decoded) {
  return {
    id: decoded.id,
    email: decoded.email || 'admin@localhost',
    name: 'Recovery Admin',
    role: decoded.role || 'platform_admin',
    auth_provider: 'recovery',
    avatar_url: null,
    plan_id: 'enterprise'
  };
}

// THE single definition of "this token is a usable session, and here is whose it is".
// requireAuth below is a thin wrapper over it, and every site that verifies a JWT by
// hand calls it too (the status backup/export/import routes, the screenshot + content
// gates, the dashboard socket handshake) - so those checks cannot drift apart from
// requireAuth's again.
//
// Returns { user, decoded, viaRecovery }. Throws:
//   - a jsonwebtoken error            bad signature / expired / malformed
//   - SessionError 'invalid_audience' token minted for a narrower purpose (pre-TOTP)
//   - SessionError 'mfa_required'     password accepted, TOTP step NOT completed. #100
//     (tightening #1): if this check is missing, password-alone yields a working session
//     and TOTP is decorative.
//   - SessionError 'user_not_found'   the token's user id no longer exists
//   - SessionError 'password_change_required'  #7: forced first-login change outstanding,
//     enforced SERVER-SIDE so a provisioned temp password doesn't work indefinitely.
//
// allowPasswordChange lets requireAuth keep its two exempt endpoints (the change itself,
// PUT /api/auth/me, and logout) while every other caller stays hard-denied.
function resolveSessionUser(token, { allowPasswordChange = false, sourceIp = null } = {}) {
  const decoded = verifyToken(token);
  // Recovery identities are synthetic (scripts/reset-admin.js) and have no users row, so
  // they skip the users lookup — but they are NOT accepted on the strength of the claim
  // alone. A `recovery: true` JWT is only honoured while a matching grant row exists,
  // unexpired and unused (lib/recovery-grant), which is what makes break-glass revocable
  // (DELETE the row), enumerable, and single-use. Redemption stamps used_at, so the same
  // token cannot be replayed.
  if (decoded.recovery) {
    const grants = require('../lib/recovery-grant');
    if (!decoded.jti || !grants.redeem(decoded.jti, { sourceIp })) {
      throw new SessionError('recovery_grant_invalid');
    }
    return { user: recoveryUser(decoded), decoded, viaRecovery: true };
  }
  if (decoded.mfa_pending) throw new SessionError('mfa_required');
  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?').get(decoded.id);
  if (!user) throw new SessionError('user_not_found');
  if (user.must_change_password && !allowPasswordChange) {
    throw new SessionError('password_change_required');
  }
  return { user, decoded, viaRecovery: false };
}

// Express middleware - requires valid JWT
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // #7: while must_change_password is set, allow only reading/updating one's own profile
  // (PUT /api/auth/me clears the flag) and logout; block everything else.
  const url = (req.originalUrl || '').split('?')[0].replace(/\/$/, '');
  const allowPasswordChange = url === '/api/auth/me' || url === '/api/auth/logout';

  let session;
  try {
    session = resolveSessionUser(authHeader.split(' ')[1], { allowPasswordChange, sourceIp: req.ip || null });
  } catch (err) {
    if (err.code === 'mfa_required') return res.status(401).json({ error: 'mfa_required' });
    // No grant, spent, expired or revoked — indistinguishable from any other bad token.
    if (err.code === 'recovery_grant_invalid') return res.status(401).json({ error: 'Invalid or expired token' });
    if (err.code === 'user_not_found') return res.status(401).json({ error: 'User not found' });
    if (err.code === 'password_change_required') return res.status(403).json({ error: 'password_change_required' });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = session.user;
  // Tenancy middleware reads this on the resolver step.
  req.jwtWorkspaceId = session.viaRecovery ? null : (session.decoded.current_workspace_id || null);
  next();
}

// (optionalAuth removed: it was exported but never mounted on any route, and it carried
// its own copy of the token-resolution logic - a different user column list, no forced-
// password-change check. A "set req.user if a token happens to be present" middleware is
// reintroducible on top of resolveSessionUser in a few lines if a route ever needs one.)

// Phase 2.1: role rename. Phase 1 renamed 'superadmin' to 'platform_admin' and
// dropped the in-between 'admin' role. These two guards are widened to accept
// either spelling so existing callers keep working without per-route edits.
// New code should prefer requirePlatformAdmin / requireOrgAdmin / workspace
// role guards from server/lib/permissions.js.
//
// Issue #14 (role normalization): the data migration in db/database.js collapses
// any legacy 'superadmin' -> 'platform_admin' and 'admin' -> 'user'. 'superadmin'
// is kept in PLATFORM_ROLES purely as back-compat belt-and-suspenders (recovery
// tokens, stray strings) - no row should carry it post-migration. Owner-level
// power lives here in PLATFORM_ROLES; anything not in this set is denied.

const PLATFORM_ROLES = ['superadmin', 'platform_admin'];
const ELEVATED_ROLES = ['admin', 'superadmin', 'platform_admin'];

// isPlatformRole: single predicate for "is this string a platform-owner role".
// Use this instead of a bare `role === 'platform_admin'` so a stray 'superadmin'
// is never silently treated as lower-privileged (the act-as bug fixed in #14).
// NOTE: this is the OWNER tier only - it deliberately does NOT include
// 'platform_operator' (issue #13), which is cross-org staff, not an owner.
function isPlatformRole(role) {
  return PLATFORM_ROLES.includes(role);
}

// Issue #13: platform_operator is cross-org STAFF - it can see and act-as into
// every org and read/write workspace-scoped resources there, but holds NO
// owner-level power (no billing, no org/workspace deletion, no user/role
// management, no shared/template asset curation, no branding). The owner powers
// stay gated on PLATFORM_ROLES / isPlatformRole, which operator is deliberately
// NOT a member of - so every owner capability is deny-by-default for operators,
// and any NEW owner endpoint added later inherits that denial automatically.
//
// PLATFORM_STAFF / isPlatformStaff is the union used ONLY for cross-org
// VISIBILITY + act-as + workspace-scoped read/write. It must never gate an
// owner action.
const PLATFORM_STAFF = ['superadmin', 'platform_admin', 'platform_operator'];
function isPlatformStaff(role) {
  return PLATFORM_STAFF.includes(role);
}

function requireAdmin(req, res, next) {
  if (!req.user || !ELEVATED_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !PLATFORM_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

// Preferred alias for new code.
const requirePlatformAdmin = requireSuperAdmin;

module.exports = { generateToken, verifyToken, resolveSessionUser, SessionError, MFA_TOKEN_AUDIENCE, requireAuth, requireAdmin, requireSuperAdmin, requirePlatformAdmin, isPlatformRole, isPlatformStaff, PLATFORM_ROLES, PLATFORM_STAFF, ELEVATED_ROLES };
