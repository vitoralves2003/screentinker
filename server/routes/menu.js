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
const { isPlatformStaff } = require('../middleware/auth');
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

router.get('/', (req, res) => {
  const plano = tenantPlan.planRowFor(req.workspaceId);

  // Sem plano resolvido não há o que oferecer, e oferecer tudo seria pior que oferecer nada.
  const temOperacao = !!(plano && plano.operacao_enabled);
  const temGestao = !!(plano && plano.gestao_enabled);

  const op = baseOperacao(req);
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
    const titular = gestaoRole(req) === 'TITULAR';

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
  // Administração é do dono da plataforma, não do cliente, e não passa por plano nenhum.
  // Fica aqui para não sumir da barra quando ela deixar de ser montada em HTML fixo.
  if (isPlatformStaff(req.user && req.user.role)) {
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

  res.json({
    inicio,
    secoes,
    transversais,
    // Só faz sentido para quem tem telas. Para os demais, a barra não mostra nada aqui.
    atencao_telas: temOperacao && req.workspaceId
      ? (require('../lib/fleet-attention').attentionCount(req.workspaceId).count || 0)
      : 0,
  });
});

module.exports = router;
