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
 * ── O RODAPÉ, QUE ANTES NÃO VINHA DAQUI ─────────────────────────────────────────────────
 * Este comentário dizia que o rodapé (Configurações, Ajuda) não era servido, porque "cada
 * módulo tem a sua própria tela de configurações e inventar aqui uma tela unificada que não
 * existe seria prometer no menu o que o produto não tem".
 *
 * Isso deixou de ser verdade: a tela de configurações passou a ser uma só, servida por
 * routes/configuracoes.js. E manter o rodapé fixo em cada lado cobrou o preço de sempre — um
 * administrador de plataforma via "Administração" DUAS VEZES, uma vinda daqui e outra escrita
 * à mão no HTML, apontando para o mesmo lugar.
 *
 * `Configurações` continua fora desta lista, e por um motivo que não mudou: é a tela do
 * PRÓPRIO módulo em que a pessoa está, com rota local (`#/settings` de um lado,
 * `/configuracoes` do outro). Um href absoluto aqui mandaria quem está na Gestão atravessar
 * para a Operação só para abrir uma tela que existe dos dois lados.
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

/* A base das páginas React. Vazia quando a infraestrutura não está configurada — e aí quem
   cai de volta nas telas antigas é a INFRAESTRUTURA, nunca o plano. */
function baseGestao() {
  return (config.gestaoUrl || '').replace(/\/+$/, '');
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
  // O mesmo desenho que a Operação já usava no rodapé, para a Ajuda não mudar de cara ao
  // passar a ser servida.
  ajuda: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
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

/*
 * DE QUEM É ESTA TELA — um nome só, para um cliente só.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────────────────────────
 * A barra da Operação escrevia "Vitor" (o nome do workspace) e a da Gestão escrevia "Vitor's
 * organization" (o nome da organização), para a mesma pessoa, na mesma sessão, no mesmo
 * produto. Cada porta calculava o seu, e havia um comentário aqui defendendo cada um.
 *
 * ── POR QUE ERAM DOIS ────────────────────────────────────────────────────────────────────
 * Porque o produto tinha dois conceitos para o mesmo dono. Medido antes de decidir:
 *
 *     Operação    workspace_id em 23 tabelas   organization_id em 6, sendo 4 de SSO
 *     Gestão      organizationId em 50 dos 59 modelos   a palavra "workspace": zero
 *     produção    4 organizações, 4 workspaces — um para um
 *
 * Não eram dois conceitos com dois trabalhos: era um tenant com um nome em cada sistema. Por
 * decisão do Vitor, passa a ser um: um cliente é uma operação, e duas redes de telas separadas
 * são dois clientes. Reconciliar dois rótulos era consertar o sintoma.
 *
 * ── QUAL DOS DOIS NOMES SOBREVIVEU ───────────────────────────────────────────────────────
 * O da organização, porque é o que tem significado fora da tela: é a razão social que sai no
 * contrato e na fatura, e é a chave dos 50 modelos da Gestão. O nome do workspace vira uma
 * coluna parada — não apagada, pelo mesmo motivo das colunas fiscais: apagar coluna no mesmo
 * passo em que se muda leitura transforma um conserto em dois problemas.
 *
 * A queda para o nome do workspace existe só para o caso de uma organização sem nome. Uma
 * barra sem título é melhor que uma barra que não carrega, e as duas são piores que um nome.
 *
 * @param {string|null} orgId
 * @param {{id:string,name:string}|null} workspaceAtual  null quando quem pergunta fala pela
 *        organização (a porta federada) e não por um workspace já resolvido. Deixou de
 *        importar para o nome — importa só para os ids.
 * @param {boolean} suporte
 */
function montarLugar({ orgId, workspaceAtual, suporte }) {
  const nome = nomeDaOrganizacao(orgId) || (workspaceAtual ? workspaceAtual.name : null);
  if (!nome) return null;

  return {
    nome,
    organizacao_id: orgId || null,
    workspace_id: workspaceAtual ? workspaceAtual.id : null,
    suporte: !!suporte,
  };
}

function montarMenu({ plano, papel, plataforma, op, atencaoTelas, workspace, lugar, testeDoInquilino }) {
  // Sem plano resolvido não há o que oferecer, e oferecer tudo seria pior que oferecer nada.
  const temOperacao = !!(plano && plano.operacao_enabled);
  const temGestao = !!(plano && plano.gestao_enabled);

  const ge = baseGestao();

  const secoes = [];

  if (temOperacao) {
    /*
     * ── O FLIP, aprovado pelo Vitor em 02/09 ─────────────────────────────────────────────
     * O primeiro flip foi desfeito em 01/09 porque eu tinha REDESENHADO as telas na
     * portagem ("preciso que apenas flipe mas não altere o design de nada"). As páginas
     * foram refeitas por paridade de IDENTIDADE — o mesmo código das views antigas,
     * hospedado — ele comparou lado a lado e aprovou. Telas inclui o detalhe
     * (#/device/<id>) na mesma página.
     *
     * A queda para as telas antigas é por INFRAESTRUTURA (gestaoUrl ausente), nunca por
     * plano — a mesma regra das abas de conta em configuracoes.js.
     */
    const itensOperacao = [
      { id: 'telas', rotulo: 'Telas', href: ge ? `${ge}/telas` : `${op}/app#/devices`, modulo: 'operacao' },
      { id: 'arquivos', rotulo: 'Arquivos', href: ge ? `${ge}/arquivos` : `${op}/app#/content`, modulo: 'operacao' },
      { id: 'playlists', rotulo: 'Playlists', href: ge ? `${ge}/playlists` : `${op}/app#/playlists`, modulo: 'operacao' },
    ];

    /*
     * LAYOUTS ESTAVA ESCONDIDO PELO CRITÉRIO ERRADO.
     *
     * Ele vivia nos transversais, atrás de `plataforma` — só administrador da plataforma via.
     * Mas o servidor nunca o tratou assim: quem guarda POST /layouts e a duplicação é
     * `checkLayoutsEnabled`, que pergunta `plan.layouts_enabled`. É uma FUNCIONALIDADE DE
     * PLANO, igual a operacao_enabled e gestao_enabled, e não uma tela de dono.
     *
     * Medido nos quatro planos antes de mudar:
     *
     *     free    layouts=0        gestao  layouts=0  (nem tem Operação)
     *     pro     layouts=1        master  layouts=1
     *
     * Ou seja, todo cliente Pró e Master paga por Layouts e nenhum deles conseguia chegar lá
     * pela barra — a coluna LAYOUT aparece na lista de Telas, então a funcionalidade era
     * visível e a porta, não. O inverso do "botão que mente": um botão que falta.
     *
     * Fica AQUI, depois de Playlists, porque é da Operação: define como a tela se divide para
     * exibir o que as playlists tocam.
     */
    if (plano && plano.layouts_enabled) {
      itensOperacao.push({ id: 'layouts', rotulo: 'Layouts', href: `${op}/app#/layouts`, modulo: 'operacao' });
    }

    secoes.push({ id: 'operacao', titulo: 'Operação', itens: itensOperacao });
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
  /*
   * RELATÓRIOS SAIU DA BARRA — por enquanto, a pedido do Vitor.
   *
   * A ROTA CONTINUA VIVA. `#/reports` abre normalmente, e um endereço salvo continua
   * funcionando — é o mesmo tratamento que agenda, widgets, video walls e quiosque já tinham.
   * Sair da barra não é deixar de existir.
   *
   * O item era transversal porque a página passou a cobrir os dois módulos. Quando voltar,
   * volta aqui, com esta mesma condição — e o mapa de rótulos em app.js ainda guarda
   * `relatorios: 'nav.reports'` justamente para a tradução não precisar ser reescrita.
   */
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
    /*
     * LAYOUTS NÃO ESTÁ MAIS AQUI. Subiu para a seção Operação, atrás de `layouts_enabled`, que
     * é o critério que o servidor sempre usou para ele.
     *
     * Se tivesse ficado nos dois lugares, um administrador de plataforma com plano Master
     * veria "Layouts" DUAS VEZES, apontando para a mesma rota — que é literalmente o defeito
     * do "Administração" duplicado que a barra servida veio encerrar. A regra é uma: cada item
     * é empurrado de um lugar só.
     */
    transversais.push({ id: 'administracao', rotulo: 'Administração', href: `${op}/app#/admin`, modulo: 'operacao' });
  }

  /*
   * ONDE O LOGIN CAI, e para onde o logo leva.
   *
   * Deixa de ser sempre a Operação. Para um Master, abrir em #/devices é abrir numa página
   * que mostra as telas e esconde os contratos e o dinheiro — enquanto o painel da Gestão já
   * reúne os dois lados, inclusive o cartão de Telas.
   */
  const inicio = (temGestao && ge)
    ? `${ge}/dashboard`
    : (ge ? `${ge}/telas` : `${op}/app#/devices`);

  return {
    inicio,
    secoes,
    transversais: carimbarIcones(secoes, transversais),
    /*
     * O RODAPÉ, servido para os dois desenharem o mesmo.
     *
     * Só Ajuda por enquanto — Configurações fica de fora de propósito (ver o cabeçalho): é a
     * tela do próprio módulo, com rota local em cada lado.
     *
     * A Ajuda vive na Operação e sempre viveu; o que muda é a Gestão passar a alcançá-la em
     * vez de simplesmente não ter. Nivelar por cima, como o Vitor pediu.
     */
    rodape: [
      { id: 'ajuda', rotulo: 'Ajuda', href: `${op}/app#/help`, modulo: 'operacao', icone: TRACO.ajuda },
    ],
    // Só faz sentido para quem tem telas. Para os demais, a barra não mostra nada aqui.
    atencao_telas: temOperacao ? atencaoTelas : 0,
    /*
     * O TESTE DA GESTÃO, e quanto falta dele.
     *
     * Vai no menu pelo mesmo motivo de atencao_telas, que o cabeçalho já defende: um aviso
     * na tela de Assinatura só informa quem foi até a tela de Assinatura, e quem está usando
     * a Gestão no dia 13 não vai lá. A barra alcança os dois módulos e todas as telas.
     *
     * NULO quando não há teste, e não um objeto com zeros: a barra decide desenhar pela
     * presença, e um objeto sempre presente a obrigaria a saber a regra de quando mostrar.
     */
    teste: testeDoInquilino,
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
    /*
     * QUEM É A PESSOA — servido porque era daqui que vinha a outra divergência.
     *
     * A barra da Operação escrevia `user` e a da Gestão escrevia `TITULAR`, para a mesma
     * pessoa. Não eram dois valores errados: eram dois VOCABULÁRIOS, cada lado usando o seu,
     * porque ninguém dizia qual valia.
     *
     * Vale este. TITULAR/OPERADOR descreve o que a pessoa pode fazer no produto; `user`
     * descreve uma linha da tabela de usuários, que é assunto do banco e não de quem olha a
     * tela. As duas portas chegam ao mesmo valor sem combinar nada: o navegador por
     * gestaoRole(), a federação pelo papel que ela própria recebeu daqui na entrada.
     *
     * O NOME não vem daqui, de propósito. Cada hospedeiro já tem a sessão da pessoa e os dois
     * já mostravam o mesmo nome — construir um caminho federado para transportar identidade
     * resolveria um problema que não existe, e criaria uma segunda fonte para um dado que
     * hoje tem uma só.
     */
    usuario: {
      papel,
      papel_rotulo: papel === 'OPERADOR' ? 'OPERADOR' : 'TITULAR',
    },
    /*
     * DE QUEM É ESTA TELA. Ver montarLugar, acima, para por que existe e o que decide.
     *
     * Convive por ora com `workspace`, logo acima, que é a forma antiga e a única que a Gestão
     * lê hoje. Duas formas do mesmo dado é exatamente o que causa divergência — então isto é
     * explicitamente temporário: a Etapa 4 apaga `workspace` quando ninguém mais o ler.
     */
    lugar: lugar || null,
  };
}

// A porta do navegador: sessão da Operação, workspace já resolvido por resolveTenancy.
router.get('/', (req, res) => {
  const { attentionCount } = require('../lib/fleet-attention');

  res.json(montarMenu({
    plano: tenantPlan.planRowFor(req.workspaceId),
    // Pela MESMA regra que resolve o plano — ver lib/tenant-plan.js.
    testeDoInquilino: tenantPlan.testeFor(req.workspaceId),
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
    lugar: montarLugar({
      orgId: req.organizationId,
      workspaceAtual: req.workspace || null,
      suporte: !!req.actingAs,
    }),
  }));
});

module.exports = router;
module.exports.montarMenu = montarMenu;
module.exports.montarLugar = montarLugar;
module.exports.baseOperacao = baseOperacao;
module.exports.baseGestao = baseGestao;
module.exports.nomeDaOrganizacao = nomeDaOrganizacao;
