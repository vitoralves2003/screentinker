'use strict';

/*
 * O MENU DO SISTEMA — uma definição, dois desenhistas.
 *
 * A Operação desenha a barra em HTML e a Gestão a desenha em React. Se cada uma carregasse
 * a sua própria lista de itens, as duas concordariam hoje e divergiriam no dia em que
 * alguém mexesse numa delas — e a que divergisse em silêncio seria a que oferece ao cliente
 * um módulo que ele não comprou. É o mesmo defeito que este produto já teve com "qual
 * plano", e que lib/tenant-plan.js existe para ter encerrado.
 *
 * Então quem responde "o que este cliente vê" é o servidor, uma vez, e os dois frontends
 * apenas desenham.
 *
 * ── O QUE ESTA ROTA NÃO FAZ ──────────────────────────────────────────────────────────────
 * Não devolve contagem em item nenhum. Nada de "Telas 3" ou "Contratos 12": cada número tem
 * lugar no painel, ao lado do que significa e clicável para chegar à lista. Repetido no
 * menu, ele vira um número sem contexto que não leva a lugar nenhum.
 *
 * A única exceção é `atencao_telas`, e ela se justifica sozinha: os números do painel só
 * informam quem está olhando o painel, enquanto este avisa quem está em qualquer outro
 * lugar — que é exatamente quando ninguém iria procurar.
 *
 * Também não devolve o rodapé (Configurações, Ajuda). Cada módulo tem a sua própria tela de
 * configurações, e inventar aqui uma tela unificada que não existe seria prometer no menu o
 * que o produto não tem.
 */

const express = require('express');
const router = express.Router();
const tenantPlan = require('../lib/tenant-plan');
const config = require('../config');
const { isPlatformRole } = require('../middleware/auth');
const { gestaoRole } = require('../lib/permissions');

/*
 * De onde a Operação é servida. Mesmo padrão que server.js já usa duas vezes: a variável de
 * ambiente quando existe, senão o host da própria requisição.
 *
 * A queda para o host funciona nos dois chamadores: quando é a Gestão que pergunta, ela
 * pergunta À Operação, então o host continua sendo o desta aqui.
 */
function baseOperacao(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/*
 * DUAS PORTAS, UM CONSTRUTOR.
 *
 * Esta função é chamada de dois lugares: por GET /api/menu, quando quem pergunta é o
 * navegador com sessão da Operação, e por GET /api/federation/menu, quando quem pergunta é
 * a API da Gestão em nome de um cliente dela — porque o navegador da Gestão não tem como se
 * identificar aqui (origens diferentes não compartilham sessão).
 *
 * O menu é o mesmo nos dois casos, e precisa ser: se cada porta montasse o seu, a barra
 * mudaria de conteúdo conforme o lado de onde a pessoa a olha.
 */
/*
 * O DESENHO DE CADA ITEM, decidido aqui — pelo mesmo motivo que o menu inteiro é.
 *
 * Antes cada front tinha o próprio mapa, e os dois divergiam de duas maneiras ao mesmo tempo:
 * a Gestão só conhecia os ícones dos itens DELA, então Telas, Arquivos, Playlists e
 * Relatórios caíam todos no ícone de contrato (o mesmo desenho, três vezes seguidas, para
 * três coisas diferentes); e mesmo onde os dois tinham ícone, tinham desenhos diferentes para
 * o mesmo item. Duas listas que precisam concordar e ninguém obriga a concordar.
 *
 * Vai o TRAÇO, e não um nome de ícone. Um nome resolveria a metade fácil — a do item sem
 * ícone — e deixaria a outra de pé: nada impediria os dois lados de desenharem coisas
 * diferentes sob o mesmo nome. Mandando o traço, as duas metades ficam impossíveis.
 *
 * São caminhos SVG num viewBox 24×24, traçado sem preenchimento — a convenção que os dois
 * lados já usavam. Cerca de 1 KB no total, uma vez por carga de menu.
 */
const TRACO = {
  telas: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  arquivos: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  playlists: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  relatorios: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  layouts: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  administracao: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clientes: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  contratos: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  financeiro: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  assinaturas: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  mensagens: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

/*
 * Carimba o traço em cada item, uma vez, no fim.
 *
 * Não em cada `push` de item: são seis lugares diferentes que montam listas aqui, e um deles
 * eventualmente esqueceria — e o sintoma seria um item sem ícone, que ninguém nota numa
 * revisão de código e todo mundo vê na barra.
 */
function carimbarIcones(secoes, transversais) {
  const stamp = (i) => ({ ...i, icone: TRACO[i.id] || null });
  for (const s of secoes) s.itens = s.itens.map(stamp);
  return transversais.map(stamp);
}

/*
 * O nome da organização a partir do id. As duas portas precisam dele e chegam a ele por
 * caminhos diferentes: o navegador tem o workspace resolvido, a federação tem só o id que
 * veio no token. Uma consulta, um lugar.
 *
 * Devolve null em vez de lançar: um nome ausente deixa a barra sem subtítulo, e isso é bem
 * melhor que uma barra que não carrega.
 */
function nomeDaOrganizacao(orgId) {
  if (!orgId) return null;
  try {
    const { db } = require('../db/database');
    const row = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
    return (row && row.name) || null;
  } catch (e) {
    return null;
  }
}

function montarMenu({ plano, papel, plataforma, op, atencaoTelas, workspace }) {
  // Sem plano resolvido não há o que oferecer, e oferecer tudo seria pior que oferecer nada.
  const temOperacao = !!(plano && plano.operacao_enabled);
  const temGestao = !!(plano && plano.gestao_enabled);

  const ge = (config.gestaoUrl || '').replace(/\/+$/, '');

  const secoes = [];

  if (temOperacao) {
    secoes.push({
      id: 'operacao',
      titulo: 'Operação',
      itens: [
        { id: 'telas', rotulo: 'Telas', href: `${op}/app#/devices`, modulo: 'operacao' },
        { id: 'arquivos', rotulo: 'Arquivos', href: `${op}/app#/content`, modulo: 'operacao' },
        { id: 'playlists', rotulo: 'Playlists', href: `${op}/app#/playlists`, modulo: 'operacao' },
      ],
    });
  }

  // A Gestão só entra quando o plano a inclui E quando existe uma Gestão neste servidor.
  // Sem GESTAO_URL não há para onde apontar, e um item que leva a lugar nenhum é pior que
  // um item ausente.
  if (temGestao && ge) {
    /*
     * DINHEIRO SÓ PARA O TITULAR.
     *
     * Financeiro e Assinaturas já eram filtrados assim dentro da Gestão, em tempo de
     * execução. A regra vem para cá porque o menu passou a ser servido: deixá-la só no
     * frontend faria este endpoint oferecer o Financeiro a um OPERADOR — e um OPERADOR que
     * não vê o Financeiro é a definição inteira do papel.
     *
     * O papel vem de gestaoRole, derivado de canAdmin, que é o único lugar que responde
     * "quem administra" neste produto.
     */
    const titular = papel === 'TITULAR';

    const itens = [
      { id: 'clientes', rotulo: 'Clientes', href: `${ge}/clientes`, modulo: 'gestao' },
      { id: 'contratos', rotulo: 'Contratos', href: `${ge}/contratos`, modulo: 'gestao' },
    ];
    if (titular) {
      itens.push({ id: 'financeiro', rotulo: 'Financeiro', href: `${ge}/financeiro`, modulo: 'gestao' });
      itens.push({ id: 'assinaturas', rotulo: 'Assinaturas', href: `${ge}/assinaturas`, modulo: 'gestao' });
    }
    itens.push({ id: 'mensagens', rotulo: 'Mensagens', href: `${ge}/mensagens`, modulo: 'gestao' });

    secoes.push({ id: 'gestao', titulo: 'Gestão', itens });
  }

  /*
   * TÍTULO SÓ QUANDO HÁ DOIS. Rotular "Operação" uma lista que é tudo o que existe não
   * informa nada — e ainda insinua que há outra seção logo abaixo, que nunca vem.
   */
  if (secoes.length === 1) secoes[0].titulo = null;

  /*
   * TRANSVERSAIS — o que não pertence a um módulo.
   *
   * Relatórios passou a cobrir o sistema inteiro, então pendurá-lo em Operação ou em Gestão
   * diria que ele é de um dos dois, que é justamente o que ele deixou de ser. Hoje a página
   * cobre só exibição de mídia; os relatórios financeiros entram nela depois, sem que o
   * menu precise mudar de novo.
   */
  const transversais = [];
  if (temOperacao || temGestao) {
    transversais.push({ id: 'relatorios', rotulo: 'Relatórios', href: `${op}/app#/reports`, modulo: 'operacao' });
  }
  /*
   * Do dono da plataforma, não do cliente: não passam por plano nenhum. Ficam aqui para não
   * sumirem da barra quando ela deixar de ser montada em HTML fixo.
   *
   * O critério é superadmin OU platform_admin — o mesmo de isPlatformAdmin() no frontend,
   * que é quem decide isso hoje. NÃO é isPlatformStaff: aquele inclui platform_operator, e
   * um operador de plataforma não vê estes itens. Usar o critério mais largo aqui abriria a
   * porta para alguém que hoje não a enxerga, o que é o tipo de mudança que ninguém pediu e
   * ninguém notaria.
   */
  if (plataforma) {
    transversais.push({ id: 'layouts', rotulo: 'Layouts', href: `${op}/app#/layouts`, modulo: 'operacao' });
    transversais.push({ id: 'administracao', rotulo: 'Administração', href: `${op}/app#/admin`, modulo: 'operacao' });
  }

  /*
   * ONDE O LOGIN CAI, e para onde o logo leva.
   *
   * Deixa de ser sempre a Operação. Para um Master, abrir em #/devices é abrir numa página
   * que mostra as telas e esconde os contratos e o dinheiro — enquanto o painel da Gestão já
   * reúne os dois lados, inclusive o cartão de Telas.
   */
  const inicio = (temGestao && ge) ? `${ge}/dashboard` : `${op}/app#/devices`;

  return {
    inicio,
    secoes,
    transversais: carimbarIcones(secoes, transversais),
    // Só faz sentido para quem tem telas. Para os demais, a barra não mostra nada aqui.
    atencao_telas: temOperacao ? atencaoTelas : 0,
    /*
     * DE QUEM SÃO OS DADOS DESTA TELA.
     *
     * Vai no menu porque é a mesma pergunta que o menu já responde — "o que este cliente vê"
     * — e porque a Gestão não tem como saber sozinha: a tenancy é resolvida aqui, e um nome
     * de organização congelado no login ficaria velho na primeira troca de workspace.
     *
     * Importa mais do que parece. Um administrador de plataforma dando suporte alcança o
     * workspace de um cliente e passa a ver contratos e dinheiro que não são dele. Sem um
     * lugar na tela dizendo de quem é, um acesso de suporte fica indistinguível de um acesso
     * normal — e o erro que isso produz não é uma tela errada, é uma decisão tomada sobre o
     * cliente errado.
     */
    workspace: workspace || null,
  };
}

// A porta do navegador: sessão da Operação, workspace já resolvido por resolveTenancy.
router.get('/', (req, res) => {
  const { attentionCount } = require('../lib/fleet-attention');

  res.json(montarMenu({
    plano: tenantPlan.planRowFor(req.workspaceId),
    papel: gestaoRole(req),
    plataforma: isPlatformRole(req.user && req.user.role),
    op: baseOperacao(req),
    atencaoTelas: req.workspaceId ? (attentionCount(req.workspaceId).count || 0) : 0,
    /*
     * `suporte` vem de req.actingAs, que resolveTenancy já calcula: é verdadeiro quando quem
     * chegou alcançou este workspace por ser administrador de plataforma, e não por ser
     * membro dele. É a diferença entre "estes são os meus dados" e "estes são os dados de um
     * cliente que eu estou atendendo", e a barra precisa dizer qual das duas.
     */
    workspace: req.workspace ? {
      id: req.workspace.id,
      nome: req.workspace.name,
      organizacao: nomeDaOrganizacao(req.organizationId),
      suporte: !!req.actingAs,
    } : null,
  }));
});

module.exports = router;
module.exports.montarMenu = montarMenu;
module.exports.baseOperacao = baseOperacao;
module.exports.nomeDaOrganizacao = nomeDaOrganizacao;
