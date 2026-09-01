'use strict';

/*
 * WHICH PLAN IS THIS TENANT ON — the single answer.
 *
 * THE BUG THIS EXISTS TO END. The product had three implementations of this question and they
 * disagreed with each other in production:
 *
 *   GET /devices/overview  read organizations.plan_id  ->  premium   (what the customer SAW)
 *   middleware/subscription  read workspaces.plan_id   ->  corporate (what was UNLOCKED)
 *   lib/tenant-billing       read workspaces.plan_id   ->  corporate (what was CHARGED)
 *
 * So the home page said "15,0 GB no plano Premium" while the invoice charged Corporativo at
 * R$20/screen with a 20-screen floor — R$400 a month to a tenant running two screens. A price
 * decided by a column that no screen in the product displays is not a pricing bug, it is a
 * product that cannot be sold: the customer reads one number and receives another.
 *
 * THE RULE, now stated once: THE TENANT IS THE WORKSPACE. workspaces.plan_id is the truth,
 * because that is the column the invoice has always been computed from — moving billing to
 * agree with the UI would have silently re-priced every existing customer, while moving the UI
 * to agree with billing only corrects what is displayed.
 *
 * organizations.plan_id is NOT read here, and must not be read anywhere else. It still exists
 * (dropping a column that signup writes buys nothing) but it no longer decides anything.
 *
 * THE OWNER FALLBACK IS LOAD-BEARING, not defensive tidiness. A workspace created before the
 * tenancy migration carries plan_id = NULL and inherits its creator's plan; both of the old
 * resolvers did this, and removing it would drop every one of those tenants to Free — handing
 * out a downgrade to paying customers and, worse, invoicing them nothing for it.
 */

const { db } = require('../db/database');

/*
 * The plan id for a workspace. Always returns something: 'free' is the floor.
 *
 * Errs toward the PAID side on purpose. An unknown plan id resolving to 'free' would serve paid
 * features and never invoice them, and silent under-billing is the failure you find months later
 * in a bank statement. A row that names a plan which no longer exists falls through to the owner
 * rather than to free.
 */
function planIdFor(workspaceId) {
  if (!workspaceId) return 'free';
  const row = db.prepare(`
    SELECT COALESCE(wp.id, up.id, 'free') AS plan_id
      FROM workspaces w
      LEFT JOIN plans wp ON wp.id = w.plan_id
      LEFT JOIN users u  ON u.id = w.created_by
      LEFT JOIN plans up ON up.id = u.plan_id
     WHERE w.id = ?
  `).get(workspaceId);
  return row ? row.plan_id : 'free';
}

/* The whole plans row, for callers that need the limits and prices rather than just the id. */
function planRowFor(workspaceId) {
  const id = planIdFor(workspaceId);
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id)
    || db.prepare("SELECT * FROM plans WHERE id = 'free'").get();
}

/*
 * The same rule as an SQL fragment, for aggregates that cannot afford a query per workspace.
 *
 * `wsAlias` is the workspaces table already in the caller's FROM. Returns { join, expr } — the
 * LEFT JOINs to add and the expression that yields the plan id. Suffixed aliases so a query can
 * use it more than once without colliding.
 */
function resolvedPlanSql(wsAlias, suffix = '') {
  const wp = `wp${suffix}`, uo = `uo${suffix}`, up = `up${suffix}`;
  return {
    join: `LEFT JOIN plans ${wp} ON ${wp}.id = ${wsAlias}.plan_id
           LEFT JOIN users ${uo} ON ${uo}.id = ${wsAlias}.created_by
           LEFT JOIN plans ${up} ON ${up}.id = ${uo}.plan_id`,
    expr: `COALESCE(${wp}.id, ${up}.id, 'free')`,
  };
}

/*
 * QUANTO FALTA DO TESTE DESTE INQUILINO — nulo quando não há teste.
 *
 * Mora aqui, e não no chamador, pela mesma razão que o resto deste arquivo: a pergunta "este
 * inquilino está em teste?" é a mesma pergunta que "qual é o plano dele", e duas respostas
 * separadas divergem no dia em que uma delas é consertada.
 *
 * O TESTE É DO WORKSPACE, não de quem está olhando. Ler trial_started do usuário da sessão
 * mostraria a um operador convidado o contador do próprio cadastro, e não o do assinante em
 * cuja conta ele está trabalhando. A data vem do mesmo dono que o fallback acima já nomeia.
 *
 * A EXPIRAÇÃO NÃO É DECIDIDA AQUI: quem rebaixa é getUserPlan (middleware/subscription), e
 * este cálculo apenas devolve nulo quando o prazo passou. Dois lugares escrevendo o fim do
 * teste seria a mesma divergência que este arquivo existe para ter acabado.
 */
const DIAS_DE_TESTE = 14;

function testeFor(workspaceId) {
  if (planIdFor(workspaceId) !== 'teste') return null;

  const dono = db.prepare(`
    SELECT u.trial_started
      FROM workspaces w
      JOIN users u ON u.id = w.created_by
     WHERE w.id = ?
  `).get(workspaceId);

  if (!dono || !dono.trial_started) return null;

  const fim = dono.trial_started + DIAS_DE_TESTE * 86400;
  const agora = Math.floor(Date.now() / 1000);
  if (agora >= fim) return null;

  return { dias_restantes: Math.max(1, Math.ceil((fim - agora) / 86400)), fim };
}

module.exports = { planIdFor, planRowFor, resolvedPlanSql, testeFor };
