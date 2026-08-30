'use strict';

/*
 * AS ABAS DE CONFIGURAÇÕES — uma definição, dois desenhistas.
 *
 * Irmão de routes/menu.js, e pelo mesmo motivo. Hoje existem duas telas de configurações:
 * uma na Operação (Conta, Assinatura, Membros, Atividade) e outra na Gestão (Empresa,
 * Serviços, Implantação, Integrações, Régua de cobrança, Minha assinatura, Usuários). Quem
 * usa o produto não tem por que saber que são dois sistemas — para ele é uma configuração só,
 * e é isso que este endpoint passa a responder.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────────────────────────
 * A tela da Gestão mostra as sete abas para TODO MUNDO, inclusive "Minha assinatura", "Régua
 * de cobrança" e "Usuários" para um OPERADOR — o papel cuja definição inteira é não ver o
 * Financeiro. O servidor recusa as ações (@Roles(TITULAR) em users, organizations e
 * collection-rules), então nada vaza de fato: o que se vê são portas que não abrem.
 *
 * Isso é pior do que parece, e o próprio código deste produto já diz por quê, em
 * views/dashboard.js: "um botão que mente é pior que um botão que falta, porque o operador
 * conclui que o sistema está quebrado em vez de concluir que aquilo não é com ele".
 *
 * ── O QUE ESTE ENDPOINT NÃO FAZ ──────────────────────────────────────────────────────────
 * Não muda a autorização de nada. Quem decide o que cada papel PODE fazer continua sendo o
 * servidor de cada lado, rota por rota. Aqui só se decide o que aparece — e aparecer de menos
 * é seguro, enquanto aparecer de mais é a mentira descrita acima.
 *
 * Também não junta abas. "Assinatura" existe dos dois lados porque é uma assinatura só,
 * partida ao meio: a Operação diz quanto é (dias-licença × telas), a Gestão cobra (fatura do
 * Asaas). Juntar as duas numa aba só é trabalho próprio, com decisão de produto no meio, e
 * está no plano como etapa separada. Enquanto não acontece, esta lista as mostra como são —
 * duas — em vez de fingir uma unificação que não existe.
 */

const express = require('express');
const router = express.Router();
const tenantPlan = require('../lib/tenant-plan');
const config = require('../config');
const { gestaoRole } = require('../lib/permissions');

/*
 * QUEM VÊ CADA ABA.
 *
 * `titular: true` esconde a aba de um OPERADOR. O critério não é gosto: são as abas onde
 * mora dinheiro ou administração de pessoas, que é exatamente a fronteira que o par
 * TITULAR/OPERADOR existe para desenhar (ver gestaoRole em lib/permissions.js — TITULAR é
 * literalmente canAdmin).
 *
 * As abas SEM `titular` continuam visíveis para todos, como são hoje. Escondê-las seria
 * remover, em silêncio, acesso que as pessoas já têm — e isso precisa de decisão de quem
 * vende o produto, não de quem escreve o endpoint.
 */
const ABAS_OPERACAO = [
  { id: 'conta', rotulo: 'Conta', destino: '#/settings?aba=account' },
  { id: 'assinatura-plano', rotulo: 'Plano e consumo', destino: '#/settings?aba=billing', titular: true },
  { id: 'membros', rotulo: 'Membros', destino: '#/settings?aba=members', titular: true },
  /*
   * O registro de atividade é do DONO da conta, não de todo titular, e quem responde isso é
   * o servidor numa pergunta própria (isActivityAvailable, em views/settings.js). Não dá para
   * decidir aqui sem repetir essa regra num segundo lugar — então a aba sai da lista e a tela
   * da Operação continua resolvendo como sempre resolveu.
   */
];

const ABAS_GESTAO = [
  { id: 'empresa', rotulo: 'Empresa', destino: '/configuracoes' },
  { id: 'servicos', rotulo: 'Serviços', destino: '/configuracoes' },
  { id: 'implantacao', rotulo: 'Implantação', destino: '/configuracoes' },
  { id: 'integracoes', rotulo: 'Integrações', destino: '/configuracoes/integracoes' },
  { id: 'regua', rotulo: 'Régua de cobrança', destino: '/configuracoes', titular: true },
  { id: 'assinatura-fatura', rotulo: 'Minha assinatura', destino: '/configuracoes', titular: true },
  { id: 'usuarios', rotulo: 'Usuários', destino: '/configuracoes', titular: true },
];

/*
 * Monta a lista para um cliente. Chamado de duas portas, como montarMenu: pelo navegador da
 * Operação e pela API da Gestão em nome de um cliente dela.
 *
 * @param {object|null} plano   linha de plans, com operacao_enabled / gestao_enabled
 * @param {'TITULAR'|'OPERADOR'} papel
 * @param {string} op           base da Operação (http://host)
 * @returns {{ abas: Array<{id,rotulo,href,modulo}> }}
 */
function montarAbas({ plano, papel, op }) {
  const temOperacao = !!(plano && plano.operacao_enabled);
  const temGestao = !!(plano && plano.gestao_enabled);
  const ge = (config.gestaoUrl || '').replace(/\/+$/, '');
  const titular = papel === 'TITULAR';

  const abas = [];
  const permitida = (a) => !a.titular || titular;

  if (temOperacao) {
    for (const a of ABAS_OPERACAO.filter(permitida)) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${op}/app${a.destino}`, modulo: 'operacao' });
    }
  }

  // Mesma condição que o menu usa: sem GESTAO_URL não há para onde apontar, e uma aba que
  // leva a lugar nenhum é pior que uma aba ausente.
  if (temGestao && ge) {
    for (const a of ABAS_GESTAO.filter(permitida)) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${ge}${a.destino}`, modulo: 'gestao' });
    }
  }

  return { abas };
}

// A porta do navegador: sessão da Operação, workspace já resolvido por resolveTenancy.
router.get('/', (req, res) => {
  res.json(montarAbas({
    plano: tenantPlan.planRowFor(req.workspaceId),
    papel: gestaoRole(req),
    op: require('./menu').baseOperacao(req),
  }));
});

module.exports = router;
module.exports.montarAbas = montarAbas;
