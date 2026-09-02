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
 * Porta de sistema, como /api/sistema/contratos: só o token de sistema entra.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { getUserPlan } = require('../middleware/subscription');

router.get('/', (req, res) => {
  const workspaces = db.prepare(
    'SELECT id, subscription_status FROM workspaces',
  ).all();

  const usuarios = db.prepare('SELECT id, role FROM users').all().map((u) => {
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
    return { id: u.id, role: u.role, plano };
  });

  res.json({ workspaces, usuarios, gerado_em: Math.floor(Date.now() / 1000) });
});

module.exports = router;
