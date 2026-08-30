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

/*
 * AS ABAS DE CONFIGURAÇÕES, pedidas pela Gestão em nome de um cliente dela.
 *
 * Mesma porta e mesmo motivo do menu logo acima: o navegador da Gestão não consegue se
 * identificar aqui, então quem pergunta é a API dela.
 *
 * Sem esta rota, a tela de configurações da Gestão só conheceria as abas dela — que é
 * exatamente o defeito que o endpoint existe para fechar, um andar acima: quem usa o produto
 * não tem por que descobrir, abrindo duas telas, que são dois sistemas.
 */
router.get('/configuracoes', (req, res) => {
  const orgId = req.federationOrgId;
  const { montarAbas } = require('./configuracoes');
  const { baseOperacao } = require('./menu');
  const tenantPlan = require('../lib/tenant-plan');

  const workspaces = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId);
  let plano = null;
  for (const w of workspaces) if (!plano) plano = tenantPlan.planRowFor(w.id);

  res.json(montarAbas({
    plano,
    // O papel vem no token, afirmado pela Gestão — que o recebeu de nós na entrada federada.
    // Mesma cadeia do menu; na dúvida, o mais restrito.
    papel: req.federationPapel === 'OPERADOR' ? 'OPERADOR' : 'TITULAR',
    op: baseOperacao(req),
  }));
});

/*
 * PLANO E CONSUMO, para a Gestão mostrar ao lado da fatura.
 *
 * Uma assinatura, duas telas. A Operação sabe o que o cliente contratou e quanto ele já
 * consumiu no mês (dias-licença × telas); a Gestão sabe o que foi faturado e como pagar.
 * Quem quisesse entender a própria conta precisava abrir as duas — e descobrir, no caminho,
 * que são dois sistemas.
 *
 * ── POR QUE UM ENDPOINT PRÓPRIO E NÃO /subscription/me ───────────────────────────────────
 * Aquele é a resposta para o NAVEGADOR do dono da conta e carrega bem mais: perfil de
 * cobrança, faturas fechadas, provedor, limites por recurso. Repassar tudo aquilo pela
 * federação seria mandar para outro sistema um monte de coisa que ele não usa — e cada campo
 * mandado é um campo que alguém pode passar a depender sem querer.
 *
 * Aqui vai o mínimo que a outra tela desenha: qual é o plano, quanto já correu neste mês, e
 * quanto o mês inteiro custa se nada mudar. É esse último número que alguém quer antes de
 * ligar mais uma tela.
 *
 * Por ORGANIZAÇÃO, como as demais rotas deste arquivo: uma organização pode ter mais de um
 * workspace, e o consumo do mês é a soma deles.
 */
router.get('/assinatura', (req, res) => {
  const orgId = req.federationOrgId;
  const tenantPlan = require('../lib/tenant-plan');
  // A prévia do mês em curso mora em tenant-billing, não em tenant-plan: um responde "o que
  // ele contratou" e o outro "quanto isso deu até hoje". É o mesmo par que routes/subscription.js
  // usa para montar a tela do dono da conta.
  const tenantBilling = require('../lib/tenant-billing');

  const workspaces = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId);
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
    // `id` e `display_name`, e não `plan_id`: a linha vem de planRowFor, que devolve a linha
    // de `plans` como ela é. Escrevi `plan_id` primeiro e o campo saiu do JSON em silêncio,
    // porque JSON.stringify apaga `undefined` em vez de reclamar.
    plano: plano ? { id: plano.id, nome: plano.display_name } : null,
    // Null, e não zero, quando não há prévia: zero diria "este mês não custou nada", que é
    // uma afirmação sobre dinheiro que ninguém verificou.
    mes: temPrevia ? {
      referencia: mes,
      telas_media: telas,
      acumulado,
      projetado,
      moeda: moeda || 'BRL',
    } : null,
  });
});

/*
 * QUEM TEM ACESSO A ESTA CONTA — para a Gestão mostrar, sem inventar a lista dela.
 *
 * ── O DEFEITO QUE ISTO CONSERTA ──────────────────────────────────────────────────────────
 * A aba de Usuários da Gestão listava a tabela `User` do Postgres dela, que só ganha uma
 * linha quando alguém ATRAVESSA pela primeira vez. Quem foi convidado aqui e ainda não entrou
 * lá simplesmente não aparecia — e uma lista de "quem tem acesso" que omite pessoas com
 * acesso responde errado a pergunta que ela existe para responder.
 *
 * Pior: aquela aba também escrevia. Criar alguém por lá gerava um usuário que não existe
 * aqui, e que por isso não entra em lugar nenhum — o login próprio da Gestão está fechado.
 * Uma pessoa cadastrada e incapaz de entrar.
 *
 * A fonte é esta, e sempre foi: o papel já é copiado daqui para lá a cada entrada federada.
 * Faltava a LISTA seguir o mesmo caminho.
 *
 * ── POR ORGANIZAÇÃO, SEM REPETIR PESSOA ──────────────────────────────────────────────────
 * Uma organização pode ter vários workspaces, e a mesma pessoa costuma estar em mais de um.
 * A lista é de PESSOAS, não de vínculos: repetir alguém porque ele participa de dois lugares
 * transformaria uma equipe de três numa lista de sete.
 *
 * O papel devolvido é o que a Gestão entende (TITULAR/OPERADOR), traduzido aqui pelo mesmo
 * critério da entrada federada — quem administra em qualquer workspace da organização é
 * titular. Mandar `workspace_admin` para lá obrigaria a Gestão a aprender o vocabulário
 * deste lado.
 */
router.get('/pessoas', (req, res) => {
  const orgId = req.federationOrgId;

  const linhas = db.prepare(`
    SELECT u.id AS user_id, u.email, u.name, wm.role AS papel_ws, NULL AS papel_org
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      JOIN workspaces w ON w.id = wm.workspace_id
     WHERE w.organization_id = ?
    UNION ALL
    SELECT u.id, u.email, u.name, NULL, om.role
      FROM organization_members om
      JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ?
  `).all(orgId, orgId);

  const porPessoa = new Map();
  for (const l of linhas) {
    const admin = l.papel_ws === 'workspace_admin'
      || l.papel_org === 'org_owner' || l.papel_org === 'org_admin';

    const ja = porPessoa.get(l.user_id);
    if (!ja) {
      porPessoa.set(l.user_id, { id: l.user_id, email: l.email, nome: l.name || '', titular: admin });
    } else if (admin) {
      // Basta administrar em UM lugar para ser titular. Sem isto, a ordem em que as linhas
      // saem do banco decidiria o papel de quem tem mais de um vínculo.
      ja.titular = true;
    }
  }

  const pessoas = [...porPessoa.values()]
    .map((p) => ({ ...p, papel: p.titular ? 'TITULAR' : 'OPERADOR' }))
    .sort((a, b) => a.email.localeCompare(b.email));

  // Convites pendentes vão junto, marcados: alguém que já recebeu convite e ainda não entrou
  // faz parte da resposta a "quem tem acesso a esta conta" -- e omiti-lo é como a mesma
  // pessoa acaba convidada duas vezes.
  /*
   * Não há coluna `accepted_at`: aceitar um convite APAGA a linha. Então uma linha que ainda
   * existe e não venceu é, por definição, um convite pendente. Escrevi a consulta com
   * `accepted_at IS NULL` de primeira e o SQLite aceitou a coluna inexistente sem reclamar
   * até a hora de rodar.
   */
  const convites = db.prepare(`
    SELECT i.email, i.role
      FROM workspace_invites i
      JOIN workspaces w ON w.id = i.workspace_id
     WHERE w.organization_id = ? AND i.expires_at > strftime('%s','now')
  `).all(orgId);

  res.json({
    pessoas,
    pendentes: convites.map((c) => ({
      email: c.email,
      papel: c.role === 'workspace_admin' ? 'TITULAR' : 'OPERADOR',
    })),
    // Para onde a Gestão manda quem quiser convidar, mudar papel ou remover: as ações vivem
    // aqui, e é aqui que elas funcionam.
    gerenciar: `${require('./menu').baseOperacao(req)}/app#/settings?aba=members`,
  });
});

module.exports = router;
