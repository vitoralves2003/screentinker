'use strict';

/*
 * OS RESUMOS QUE A GESTÃO MOSTRA — servidos ao navegador, sem federação.
 *
 * ── DE ONDE ISTO VEIO ────────────────────────────────────────────────────────────────────
 * Estas três respostas viviam em routes/federation.js, atrás de um token assinado entre
 * servidores. A viagem era: navegador → API da Gestão → token de federação → aqui.
 *
 * Os três saltos existiam por uma frase que era verdade em 2026 e deixou de ser: "o navegador
 * da Gestão não tem como se identificar aqui — origens diferentes não compartilham sessão".
 * A Fase B pôs os dois módulos atrás da MESMA ORIGEM. O navegador chega aqui com a sessão da
 * Operação que já está no localStorage dele, e não precisa de intermediário nenhum.
 *
 * ── O QUE MUDOU NO CÓDIGO, E O QUE NÃO ───────────────────────────────────────────────────
 * Uma linha por rota: `req.federationOrgId` virou `req.organizationId`. O primeiro vinha do
 * token; o segundo vem de resolveTenancy, que é quem resolve o tenant de toda rota
 * autenticada. É o MESMO id — a organização do workspace de quem está logado.
 *
 * A forma da resposta não mudou nem um campo. Era o contrato que a tela da Gestão já lia, e
 * mudar as duas coisas de uma vez tornaria impossível saber qual delas quebrou.
 *
 * ── POR QUE AQUI E NÃO EM /api/devices, /api/subscription ────────────────────────────────
 * Porque não são as telas nem a assinatura: são RESUMOS, montados para um cartão de painel.
 * `/api/devices` devolve a frota; isto devolve "3 telas, 1 fora do ar, 113 MB de 25 GB". Pôr
 * um resumo dentro do recurso que ele resume é como um dia alguém muda o recurso e quebra o
 * cartão sem perceber que havia dois leitores.
 *
 * ── POR ORGANIZAÇÃO, E NÃO POR WORKSPACE ────────────────────────────────────────────────
 * A soma percorre todos os workspaces da organização, como a versão federada fazia. Hoje é
 * sempre um só (um cliente é uma operação — ver montarLugar em routes/menu.js), mas somar
 * continua sendo a resposta certa se um dia houver dois, e custa uma linha.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { gestaoRole } = require('../lib/permissions');

/*
 * SO O TITULAR VE DINHEIRO E QUEM TEM ACESSO A CONTA.
 *
 * Esta trava existia como @Roles(TITULAR) nas rotas da Gestao, e ela QUASE se perdeu na
 * mudanca: escrevi no comentario que "ela mora na Operacao agora" antes de ela morar, e as
 * rotas novas subiram com requireAuth e mais nada. Um OPERADOR teria lido a previa de cobranca
 * e a lista de pessoas.
 *
 * E o modo de falha era silencioso dos dois lados: a lista servida ja esconde as abas de
 * Assinatura e Pessoas de um OPERADOR, entao ele nunca clicaria e ninguem veria. Uma trava que
 * so existe na tela nao e trava -- e o que a substituiu aqui e a unica coisa que impede a
 * leitura direta.
 *
 * gestaoRole deriva de canAdmin, que e um OU de tres fontes (plataforma, organizacao e
 * workspace). Nao ha um segundo criterio de "quem administra" neste produto, e este e ele.
 */
function soTitular(req, res, next) {
  if (gestaoRole(req) === 'TITULAR') return next();
  return res.status(403).json({ error: 'Somente o titular', code: 'FORBIDDEN' });
}

// Quantas telas a lista mostra antes de virar "mais N". Um cartao que cresce sem limite quebra
// a coluna no dia em que o cliente tem trinta telas fora do ar -- que e justamente o dia em que
// ele mais precisa que a tela funcione.
const LIMITE_LISTA = 3;

router.get('/telas', (req, res) => {
  const orgId = req.organizationId;

  const workspaces = orgId
    ? db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId)
    : [];

  if (!workspaces.length) {
    return res.json({
      organization_id: orgId, modulo_operacao: false,
      total: 0, online: 0, offline: 0,
      attention: [], attention_total: 0, hours_unconfigured: 0,
      storage_used_mb: 0, storage_limit_mb: 0, plan: null,
    });
  }

  /*
   * OS NUMEROS SAO OS MESMOS DA VISAO GERAL.
   *
   * fleetOf + livenessPass + attentionFor sao exatamente as funcoes que a pagina de Operacao
   * usa. Recontar aqui com uma consulta propria seria criar uma segunda resposta para "quantas
   * telas estao no ar" -- e duas respostas que concordam hoje discordam depois que alguem
   * mexer numa delas. Ja aconteceu neste produto com a pergunta "qual plano".
   */
  const { fleetOf, livenessPass, attentionFor } = require('../lib/fleet-attention');
  const { effectiveStorageMB, getWorkspaceStorageMB } = require('../middleware/subscription');
  const tenantPlan = require('../lib/tenant-plan');

  let total = 0, online = 0, unconfigured = 0;
  let usedMb = 0, limitMb = 0;
  let semLimite = false;
  const attention = [];
  let planoNome = null;
  let temOperacao = false;

  for (const w of workspaces) {
    const devices = fleetOf(w.id);
    const pass = livenessPass(devices);

    total += devices.length;
    online += pass.online;

    const a = attentionFor(w.id, devices, pass.offlineRows);
    for (const item of (a.attention || [])) attention.push(item);
    unconfigured += a.unconfigured || 0;

    const plano = tenantPlan.planRowFor(w.id);
    if (plano && !planoNome) planoNome = plano.display_name;
    // Basta UM workspace com o modulo para o cliente ter telas.
    if (plano && plano.operacao_enabled) temOperacao = true;

    usedMb += getWorkspaceStorageMB(w.id);
    const teto = effectiveStorageMB(plano, { workspaceId: w.id });
    // -1 e o jeito do plano dizer "sem limite". Somar -1 a um total daria um numero MENOR que
    // a soma, que e a maneira mais silenciosa possivel de mentir sobre espaco.
    if (teto === -1) semLimite = true; else limitMb += teto;
  }

  /*
   * PARA ONDE CADA NUMERO LEVA — decidido aqui, nao na Gestao.
   *
   * O cartao mostra numeros que sao respostas nossas; os links que os abrem tambem tem de ser
   * nossos. Se a Gestao montasse '/app#/devices?f=atencao' por conta propria, ela passaria a
   * conhecer a estrutura de rotas da Operacao, e mudar essa estrutura aqui quebraria um cartao
   * do outro lado sem que nada neste repositorio acusasse.
   */
  const op = require('./menu').baseOperacao(req);
  const ge = require('./menu').baseGestao();
  /* Flip aprovado em 02/09: os links levam às páginas React (/gestao/telas hospeda a lista
     antiga, que lê os mesmos filtros do hash). A queda para o app antigo é por
     INFRAESTRUTURA (gestaoUrl ausente), nunca por plano. */
  const links = ge ? {
    total: `${ge}/telas`,
    online: `${ge}/telas#/devices?f=no-ar`,
    offline: `${ge}/telas#/devices?f=fora-do-ar`,
    attention: `${ge}/telas#/devices?f=atencao`,
    // Uma tela em particular: a lista filtrada por id, e nao a pagina da tela. Quem clicou num
    // item da lista de atencao esta perguntando "qual e essa", nao "quero opera-la".
    tela: `${ge}/telas#/devices?id=`,
    armazenamento: `${ge}/arquivos`,
  } : {
    total: `${op}/app#/devices`,
    online: `${op}/app#/devices?f=no-ar`,
    offline: `${op}/app#/devices?f=fora-do-ar`,
    attention: `${op}/app#/devices?f=atencao`,
    tela: `${op}/app#/devices?id=`,
    armazenamento: `${op}/app#/content`,
  };

  res.json({
    organization_id: orgId,
    // O plano deste cliente inclui telas? A Gestao usa isto para nao desenhar um cartao de
    // telas para quem nao tem nenhuma e nunca vai ter.
    modulo_operacao: temOperacao,
    links,
    total,
    online,
    offline: total - online,
    // A lista e cortada aqui, mas o TOTAL vai junto: o cartao precisa poder dizer "mais N" sem
    // ter recebido as N.
    attention: attention.slice(0, LIMITE_LISTA),
    attention_total: attention.length,
    hours_unconfigured: unconfigured,
    storage_used_mb: usedMb,
    storage_limit_mb: semLimite ? -1 : limitMb,
    plan: planoNome,
  });
});

router.get('/assinatura', soTitular, (req, res) => {
  const orgId = req.organizationId;
  const tenantPlan = require('../lib/tenant-plan');
  // A previa do mes em curso mora em tenant-billing, nao em tenant-plan: um responde "o que ele
  // contratou" e o outro "quanto isso deu ate hoje". E o mesmo par que routes/subscription.js
  // usa para montar a tela do dono da conta.
  const tenantBilling = require('../lib/tenant-billing');

  const workspaces = orgId
    ? db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId)
    : [];
  if (!workspaces.length) return res.json({ disponivel: false });

  let plano = null;
  let telas = 0;
  let acumulado = 0;
  let projetado = 0;
  let moeda = null;
  let mes = null;
  let temPrevia = false;

  for (const w of workspaces) {
    if (!plano) plano = tenantPlan.planRowFor(w.id);

    let previa = null;
    try { previa = tenantBilling.currentMonthPreview(w.id); } catch (e) { previa = null; }
    if (!previa) continue;

    temPrevia = true;
    mes = mes || previa.month;
    telas += previa.avg_screens || 0;
    acumulado += previa.amount || 0;
    projetado += previa.projected_amount || 0;
    moeda = moeda || previa.currency;
  }

  res.json({
    disponivel: true,
    // `id` e `display_name`, e nao `plan_id`: a linha vem de planRowFor, que devolve a linha de
    // `plans` como ela e. Escrevi `plan_id` primeiro e o campo saiu do JSON em silencio, porque
    // JSON.stringify apaga `undefined` em vez de reclamar.
    plano: plano ? { id: plano.id, nome: plano.display_name } : null,
    // Null, e nao zero, quando nao ha previa: zero diria "este mes nao custou nada", que e uma
    // afirmacao sobre dinheiro que ninguem verificou.
    mes: temPrevia ? {
      referencia: mes,
      telas_media: telas,
      acumulado,
      projetado,
      moeda: moeda || 'BRL',
    } : null,
  });
});

router.get('/pessoas', soTitular, (req, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.json({ pessoas: [], pendentes: [], gerenciar: null });

  const linhas = db.prepare(`
    SELECT u.id AS user_id, u.email, u.name, wm.role AS papel_ws, NULL AS papel_org,
           wm.workspace_id AS ws_id
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      JOIN workspaces w ON w.id = wm.workspace_id
     WHERE w.organization_id = ?
    UNION ALL
    SELECT u.id, u.email, u.name, NULL, om.role, NULL
      FROM organization_members om
      JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ?
  `).all(orgId, orgId);

  const porPessoa = new Map();
  for (const l of linhas) {
    const admin = l.papel_ws === 'workspace_admin'
      || l.papel_org === 'org_owner' || l.papel_org === 'org_admin';

    const ja = porPessoa.get(l.user_id) || porPessoa
      .set(l.user_id, {
        id: l.user_id, email: l.email, nome: l.name || '',
        titular: false, temOrg: false, wsId: null,
      })
      .get(l.user_id);

    // Basta administrar em UM lugar para ser titular. Sem isto, a ordem em que as linhas saem
    // do banco decidiria o papel de quem tem mais de um vinculo.
    if (admin) ja.titular = true;
    /*
     * De onde vem o acesso decide ONDE ele se gerencia. Um vínculo de organização não se
     * edita no nível do workspace (a rota de lá responderia 403) — então quem tem QUALQUER
     * vínculo de organização é gerenciado em #/admin, e a aba da Gestão mostra isso em vez
     * de oferecer um controle que recusaria.
     */
    if (l.papel_org !== null) ja.temOrg = true;
    if (l.ws_id && !ja.wsId) ja.wsId = l.ws_id;
  }

  // `titular` e andaime desta funcao e nao sai na resposta: mandar os dois seria oferecer duas
  // formas de responder a mesma pergunta, e um dia alguem le a errada.
  const pessoas = [...porPessoa.values()]
    .map((p) => ({
      id: p.id,
      email: p.email,
      nome: p.nome,
      papel: p.titular ? 'TITULAR' : 'OPERADOR',
      /*
       * NULO = "não se gerencia aqui", e a aba diz onde. Etapa 4 da unificação: as ações de
       * convidar/mudar papel/remover passaram a viver na aba React da Gestão, que chama as
       * rotas de workspace desta API — e elas só alcançam vínculo DIRETO de workspace.
       */
      gerencia: p.wsId && !p.temOrg ? { workspace_id: p.wsId } : null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));

  /*
   * Convites pendentes vao junto, marcados: alguem que ja recebeu convite e ainda nao entrou
   * faz parte da resposta a "quem tem acesso a esta conta" -- e omiti-lo e como a mesma pessoa
   * acaba convidada duas vezes.
   *
   * Nao ha coluna `accepted_at`: aceitar um convite APAGA a linha. Entao uma linha que ainda
   * existe e nao venceu e, por definicao, um convite pendente. Escrevi a consulta com
   * `accepted_at IS NULL` de primeira e o SQLite aceitou a coluna inexistente sem reclamar ate
   * a hora de rodar.
   */
  const convites = db.prepare(`
    SELECT i.id, i.workspace_id, i.email, i.role
      FROM workspace_invites i
      JOIN workspaces w ON w.id = i.workspace_id
     WHERE w.organization_id = ? AND i.expires_at > strftime('%s','now')
  `).all(orgId);

  res.json({
    pessoas,
    // `pendentes`, e nao `convites`: e o nome do campo que a tela da Gestao ja le. Eu quase o
    // renomeei ao mover, e renomear campo no mesmo passo em que se muda o caminho e como uma
    // tela vazia vira duas horas procurando no lugar errado.
    pendentes: convites.map((c) => ({
      // O id e o workspace entraram na Etapa 4: cancelar um convite e
      // DELETE /workspaces/:ws/invites/:id, e sem os dois a aba nao teria o que chamar.
      id: c.id,
      workspace_id: c.workspace_id,
      email: c.email,
      papel: c.role === 'workspace_admin' ? 'TITULAR' : 'OPERADOR',
    })),
    /*
     * ONDE UM CONVITE NOVO NASCE: o workspace da sessao de quem convida. A organizacao pode
     * ter mais de um workspace; a aba da Gestao convida para o que a pessoa esta usando —
     * que no modelo "um cliente, uma operacao" e o unico.
     */
    workspace_convite: req.workspaceId || null,
    // O caminho antigo para as acoes, que a aba ainda mostra quando algo nao se gerencia la.
    gerenciar: `${require('./menu').baseOperacao(req)}/app#/settings?aba=members`,
  });
});

module.exports = router;
