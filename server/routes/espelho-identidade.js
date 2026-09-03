'use strict';

/*
 * O ESPELHO DE IDENTIDADE — a única resposta que a casa nova não tem como dar sozinha
 * (Fase C, 02/09).
 *
 * O gateway das telas mudou de casa, mas três decisões dele leem IDENTIDADE/COBRANÇA,
 * que ficam neste SQLite até a migração delas: o corte por inadimplência (workspaces.
 * subscription_status = 'cut'), o limite de telas do plano (checkDeviceAccess) e o papel
 * vivo de quem opera o dashboard (um usuário rebaixado não pode manter o controle da
 * frota pelo resto de um JWT de 7 dias).
 *
 * Esta rota serve o retrato inteiro de uma vez — quatro usuários e quatro workspaces
 * hoje; centenas amanhã ainda é UMA resposta pequena por minuto. A casa nova puxa a
 * cada 60s e guarda em memória: a janela de rebaixamento cai de 7 dias para 1 minuto,
 * e a tolerância do corte de inadimplência é ≤60s — melhor que hoje num caso, igual no
 * outro. FALHA ABERTA como os contratos: workspace que o espelho não tem não corta.
 *
 * O /dashboard do gateway (02/09) precisa de mais três fatos, todos deste SQLite:
 *   acessos              em quais workspaces cada usuário entra e com que papel — é o que
 *                        dashboardSocket.js perguntava a lib/tenancy a cada conexão
 *                        (accessibleWorkspaceIds + accessContext); calculado AQUI, pela
 *                        mesma lib, para as duas casas responderem igual
 *   must_change_password o resolveSessionUser recusa a sessão com 'password_change_required'
 *   widget_sandbox_isolation_disabled   por workspace (vem da organização) — decide o
 *                        widget_allow_same_origin que o player recebe no payload
 *
 * As ROTAS DE TELAS (/api/devices, /api/provision/pair — 02/09) pedem mais quatro, também
 * deste SQLite até a migração de identidade/cobrança:
 *   email, name          por usuário — o owner_email/owner_name que a lista de telas mostra
 *   plano                por workspace, a LINHA CRUA de plans (planRowFor: workspace.plan_id →
 *                        plano do dono → free) — a casa nova calcula o limite de telas do pair
 *                        e o effectiveStorageMB do /overview contando telas no POSTGRES, porque
 *                        a contagem daqui congela no corte
 *   invoice_notice       por workspace, o aviso de fatura do /overview (noticeFor), que lê
 *                        workspace_invoices — tabela que fica aqui
 *
 * Porta de sistema, como /api/sistema/contratos: só o token de sistema entra.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { getUserPlan } = require('../middleware/subscription');
const { accessibleWorkspaceIds, accessContext } = require('../lib/tenancy');
const { planRowFor } = require('../lib/tenant-plan');
const { noticeFor } = require('../lib/invoice-notice');

/* O subconjunto de plans que as rotas de telas leem — o resto (preços, flags de módulo) fica. */
function planoCru(workspaceId) {
  try {
    const p = planRowFor(workspaceId);
    if (!p) return null;
    return {
      id: p.id, name: p.name, display_name: p.display_name, max_devices: p.max_devices,
      max_storage_mb: p.max_storage_mb, storage_mb_per_unit: p.storage_mb_per_unit || 0,
      storage_mb_cap: p.storage_mb_cap || 0, package_size: p.package_size || 0,
      // remote_url: o gate de checkRemoteUrl (POST /api/content/remote e uma funcionalidade
      // de plano Pro+). Ele viaja a partir do corte de /api/content, porque a rota passa a ser
      // servida pela casa nova e a trava viveria la. Sem este campo o corte a APAGARIA em
      // silencio: a rota responderia 201 para todo mundo, e nada acusaria.
      remote_url: p.remote_url ? 1 : 0,
    };
  } catch (_) { return null; }
}

router.get('/', (req, res) => {
  const linhas = db.prepare(`
    SELECT w.id, w.organization_id, w.subscription_status,
           COALESCE(o.widget_sandbox_isolation_disabled, 0) AS widget_sandbox_isolation_disabled
    FROM workspaces w
    LEFT JOIN organizations o ON o.id = w.organization_id
  `).all();
  const porId = new Map(linhas.map((w) => [w.id, w]));
  const workspaces = linhas.map((w) => {
    let invoice_notice = null;
    try { invoice_notice = noticeFor(w.id); } catch (_) { /* nunca derruba o espelho pela fatura */ }
    return {
      id: w.id,
      subscription_status: w.subscription_status,
      widget_sandbox_isolation_disabled: w.widget_sandbox_isolation_disabled ? 1 : 0,
      plano: planoCru(w.id),
      invoice_notice,
    };
  });

  const usuarios = db.prepare('SELECT id, email, name, role, must_change_password FROM users').all().map((u) => {
    let plano = null;
    try {
      const p = getUserPlan(u.id);
      if (p) {
        plano = {
          plan_name: p.plan_name,
          max_devices: p.max_devices,
          trial_started: p.trial_started || null,
          trial_active: !!p.trial_active,
        };
      }
    } catch (_) { /* usuário sem plano resolve como nulo — o gate trata como permitido */ }

    const acessos = [];
    for (const wid of accessibleWorkspaceIds(u.id, u.role)) {
      const ws = porId.get(wid);
      if (!ws) continue;
      const ctx = accessContext(u.id, u.role, ws);
      if (!ctx) continue;
      acessos.push({ workspace_id: wid, workspace_role: ctx.workspaceRole, acting_as: !!ctx.actingAs });
    }

    return { id: u.id, email: u.email, name: u.name || null, role: u.role, plano, must_change_password: u.must_change_password ? 1 : 0, acessos };
  });

  res.json({ workspaces, usuarios, gerado_em: Math.floor(Date.now() / 1000) });
});

module.exports = router;
