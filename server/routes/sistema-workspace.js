'use strict';

/*
 * QUAL É O WORKSPACE DESTA ORGANIZAÇÃO — a única pergunta que só esta casa sabe responder.
 *
 * ── por que ela existe ──────────────────────────────────────────────────────────────────────
 * A tabela `workspaces` mora aqui, no SQLite, e não foi para o Postgres na migração. A casa nova
 * guarda `workspace_id` em tudo o que é da Operação (content, playlists, devices, layouts,
 * widgets) e não tem como DERIVAR esse id: ela recebe o workspace do token de quem está logado,
 * e num fluxo de sistema — a ativação de um contrato por webhook — não há ninguém logado.
 *
 * ── o defeito que ela conserta ──────────────────────────────────────────────────────────────
 * A lista do contrato era criada por `POST /api/sistema/contratos/:id/lista`, que grava AQUI. O
 * corte de 03/09 levou `/api/playlists` inteiro para a casa nova: desde então a lista nascia num
 * banco que ninguém mais lê. Medido em 05/09 — a lista existia no SQLite, com o rótulo correto,
 * e o produto inteiro não a enxergava.
 *
 * Agora esta casa só RESPONDE, e quem cria é o lado onde as playlists de fato vivem.
 *
 * ── e por que ela não aceita o workspace como parâmetro ─────────────────────────────────────
 * Pela mesma razão que `sistemaAuth` não o lê do token: deixar o chamador dizer em qual
 * workspace escrever seria deixá-lo escolher, e o id de um contrato de um cliente pararia a
 * mídia de outro. A organização é a única coisa que ele afirma; o alcance dela é decidido aqui.
 */

const express = require('express');
/* O módulo exporta { db, ... } — pegar o objeto inteiro daria um `db.prepare is not a function`
   só na primeira chamada, e não no arranque. */
const { db } = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  /*
   * O DONO da workspace vai junto porque `playlists.user_id` é NOT NULL do outro lado também, e
   * num fluxo de sistema não há pessoa. Sem ele, a criação falharia só no caminho do cron — que é
   * o menos exercitado — e com uma mensagem de restrição de banco.
   */
  const dono = db.prepare('SELECT created_by FROM workspaces WHERE id = ?').get(req.workspaceId);

  res.json({
    workspace_id: req.workspaceId,
    owner_id: dono?.created_by || null,
  });
});

module.exports = router;
