'use strict';

/*
 * O QUE A GESTAO PERGUNTA SOBRE AS TELAS.
 *
 * Uma rota so, de leitura, confinada a uma organizacao pelo porteiro que ja provou qual e.
 *
 * ── POR ORGANIZACAO, E NAO POR WORKSPACE ─────────────────────────────────────────────────
 * Dentro da Operacao o tenant e o workspace. Mas quem atravessa os dois sistemas e a
 * ORGANIZACAO -- e o id que a Gestao guarda, o mesmo dos dois lados. Uma organizacao pode
 * ter mais de um workspace, entao aqui a conta soma todos eles.
 *
 * ── OS NUMEROS SAO OS MESMOS DA VISAO GERAL ──────────────────────────────────────────────
 * fleetOf + livenessPass + attentionFor sao exatamente as funcoes que a pagina de Operacao
 * usa. Recontar aqui com uma consulta propria seria criar uma segunda resposta para "quantas
 * telas estao no ar" -- e duas respostas que concordam hoje discordam depois que alguem
 * mexer numa delas. Ja aconteceu neste produto com a pergunta "qual plano".
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Quantas telas a lista mostra antes de virar "mais N". Um cartao que cresce sem limite
// quebra a coluna no dia em que o cliente tem trinta telas fora do ar -- que e justamente o
// dia em que ele mais precisa que a tela funcione.
const LIMITE_LISTA = 3;

router.get('/telas', (req, res) => {
  const orgId = req.federationOrgId;

  const workspaces = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId);

  if (!workspaces.length) {
    return res.json({
      organization_id: orgId, modulo_operacao: false,
      total: 0, online: 0, offline: 0,
      attention: [], attention_total: 0, hours_unconfigured: 0,
      storage_used_mb: 0, storage_limit_mb: 0, plan: null,
    });
  }

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
    // Basta UM workspace com o modulo para o cliente ter telas. Exigir que todos tivessem
    // esconderia o cartao de quem tem uma praca no Master e outra em Gestao avulsa.
    if (plano && plano.operacao_enabled) temOperacao = true;

    usedMb += getWorkspaceStorageMB(w.id);
    const teto = effectiveStorageMB(plano, { workspaceId: w.id });
    // -1 e o jeito do plano dizer "sem limite". Somar -1 a um total daria um numero menor
    // que a soma, que e a maneira mais silenciosa possivel de mentir sobre espaco.
    if (teto === -1) semLimite = true; else limitMb += teto;
  }

  /*
   * PARA ONDE CADA NUMERO LEVA — decidido aqui, nao na Gestao.
   *
   * O cartao de telas mostra numeros que sao respostas nossas; os links que os abrem tambem
   * tem de ser nossos. Se a Gestao montasse '/app#/devices?f=atencao' por conta propria, ela
   * passaria a conhecer a estrutura de rotas da Operacao, e mudar essa estrutura aqui
   * quebraria um cartao do outro lado sem que nada neste repositorio acusasse.
   *
   * NAO PRECISA DE TOKEN DE TROCA, ao contrario do caminho inverso. O navegador ja tem a
   * sessao da Operacao nesta origem -- e por aqui que se entra no produto. Federacao existe
   * no sentido Operacao -> Gestao porque o login proprio da Gestao esta fechado; no sentido
   * de volta nao ha nada a provar de novo.
   */
  const op = require('./menu').baseOperacao(req);
  const links = {
    total: `${op}/app#/devices`,
    online: `${op}/app#/devices?f=no-ar`,
    offline: `${op}/app#/devices?f=fora-do-ar`,
    attention: `${op}/app#/devices?f=atencao`,
    // Uma tela em particular: a lista filtrada por id, e nao a pagina da tela. Quem clicou
    // num item da lista de atencao esta perguntando "qual e essa", nao "quero opera-la".
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
    // A lista e cortada aqui, mas o TOTAL vai junto: o cartao precisa poder dizer "mais N"
    // sem ter recebido as N.
    attention: attention.slice(0, LIMITE_LISTA),
    attention_total: attention.length,
    hours_unconfigured: unconfigured,
    storage_used_mb: usedMb,
    storage_limit_mb: semLimite ? -1 : limitMb,
    plan: planoNome,
  });
});

/*
 * O MENU, pedido pela Gestão em nome de um cliente dela.
 *
 * O navegador da Gestão não tem como se identificar aqui — origens diferentes não
 * compartilham sessão —, então quem pergunta é a API dela, pelo mesmo caminho federado do
 * resumo de telas.
 *
 * O PAPEL VEM NO TOKEN, e é a Gestão quem o afirma: ela conhece o usuário autenticado dela,
 * e esse papel foi posto lá por NÓS, na entrada federada. Não é a Gestão inventando um
 * papel — é ela devolvendo o que recebeu.
 *
 * O menu é montado pelo MESMO construtor que serve o navegador da Operação. Se cada porta
 * montasse o seu, a barra mudaria de conteúdo conforme o lado de onde a pessoa a olha.
 */
router.get('/menu', (req, res) => {
  const orgId = req.federationOrgId;
  const { montarMenu, baseOperacao, nomeDaOrganizacao } = require('./menu');
  const tenantPlan = require('../lib/tenant-plan');
  const { attentionCount } = require('../lib/fleet-attention');

  const workspaces = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId);

  // Sem workspace não há plano a resolver, e sem plano o construtor devolve um menu vazio —
  // que é a resposta honesta para "esta organização não tem nada aqui".
  let plano = null;
  let atencao = 0;
  for (const w of workspaces) {
    if (!plano) plano = tenantPlan.planRowFor(w.id);
    atencao += attentionCount(w.id).count || 0;
  }

  res.json(montarMenu({
    plano,
    papel: req.federationPapel === 'OPERADOR' ? 'OPERADOR' : 'TITULAR',
    // Nunca. O administrador de plataforma se autentica na Operação, e o item de
    // Administração aparece para ele por aquela porta — não por esta, que fala em nome de
    // um cliente.
    plataforma: false,
    op: baseOperacao(req),
    atencaoTelas: atencao,
    /*
     * DE QUEM SÃO OS DADOS, para a barra da Gestão poder dizer.
     *
     * Aqui só existe o id da organização — quem pergunta é a API da Gestão, em nome de um
     * cliente dela, e não um navegador com workspace resolvido. Então o nome sai do id, e o
     * `nome` do bloco é o da organização mesmo: uma organização pode ter vários workspaces
     * na Operação, e escolher um deles para exibir seria apontar para um pedaço como se
     * fosse o todo.
     *
     * `suporte` NÃO é decidido aqui. A Gestão sabe, pelo próprio token, se aquela sessão é
     * um acesso de suporte — foi ela que o emitiu com esse marcador. Afirmar daqui exigiria
     * que este lado adivinhasse o que aquele já tem escrito.
     */
    workspace: (() => {
      const nome = nomeDaOrganizacao(orgId);
      return nome ? { id: orgId, nome, organizacao: nome, suporte: false } : null;
    })(),
  }));
});

module.exports = router;
