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
const { gestaoRole, isOrgOwner } = require('../lib/permissions');

/*
 * A CONTA É DESTA PESSOA? — a mesma pergunta que routes/activity.js faz, escrita uma vez.
 *
 * Copiada de requireTenantOwner, e é para SER a mesma: se as duas responderem diferente, a
 * fileira ofereceria uma aba que a rota recusa, ou esconderia uma que a rota abriria. Um botão
 * que mente é pior que um botão que falta, porque quem clica conclui que o sistema quebrou em
 * vez de concluir que aquilo não é com ele.
 */
function ehDono(req) {
  return !!req.workspaceId && isOrgOwner(req);
}

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
/*
 * ── O GRUPO DE CADA ABA: conta · gestao · operacao ──────────────────────────────────────
 *
 * Decidido com o Vitor em 01/09, no plano da unificação de Configurações. A taxonomia:
 *
 *   conta      todo assinante, qualquer módulo — Conta, Pessoas, Assinatura, Atividade,
 *              Empresa (esta ainda declarada como gestao; ver abaixo)
 *   gestao     só quem contratou o módulo — Serviços, Implantação, Régua, Integrações
 *   operacao   vazio hoje. A Operação não tem configuração de módulo em #/settings: as
 *              quatro abas dela são todas DA CONTA (medido em 01/09 — o SSO mora em #/admin
 *              de propósito, o alerta de e-mail é do perfil). O grupo existe para o dia em
 *              que não for vazio.
 *
 * A tela de Configurações é do PRODUTO, não do módulo Gestão: o plano esconde funcionalidade,
 * nunca a casca. O grupo é o contrato disso — quem GATE continua sendo montarAbas, e a
 * mudança de quem-vê-o-quê viaja com a migração de cada aba, não com esta declaração.
 *
 * EMPRESA está declarada `gestao` DE PROPÓSITO, por ora: a tela dela vive atrás do gate de
 * plano da API da Gestão (jwt-auth.guard recusa token sem gestao_enabled na porta). Declará-la
 * `conta` antes de a porta distinguir módulo de conta ofereceria uma aba que devolve 403 —
 * um botão que mente. Ela muda de grupo na etapa que a torna standalone (Empresa → registro
 * único), junto com a isenção no guarda.
 */
const ABAS_OPERACAO = [
  /*
   * O REGISTRO DE ATIVIDADE ENTROU NA LISTA. Este comentário dizia o contrário, e o motivo
   * era bom até deixar de ser:
   *
   *   "é do DONO da conta, não de todo titular, e quem responde isso é o servidor numa
   *    pergunta própria. Não dá para decidir aqui sem repetir essa regra num segundo lugar."
   *
   * A consequência foi a fileira ficar diferente conforme o lado: esta aba existia na
   * Operação e não na Gestão, porque era a TELA da Operação que perguntava, e a da Gestão não
   * tinha a quem perguntar. Evitar repetir a regra num segundo lugar custou uma divergência
   * visível — que é o defeito que esta etapa fecha.
   *
   * A regra não foi repetida: ela MUDOU DE LUGAR. `dono` é calculado uma vez, por porta, com
   * exatamente o mesmo critério de routes/activity.js (`!!req.workspaceId && isOrgOwner(req)`),
   * e chega aqui pronto. A tela deixa de perguntar.
   */
  { id: 'atividade', rotulo: 'Registro de atividades', destino: '#/settings', dono: true, grupo: 'conta' },
];

const ABAS_GESTAO = [
  // `grupo: 'gestao'` aqui, e não 'conta' — ver a nota de EMPRESA no bloco acima.
  { id: 'empresa', rotulo: 'Empresa', destino: '/configuracoes', grupo: 'gestao' },
  { id: 'servicos', rotulo: 'Serviços', destino: '/configuracoes', grupo: 'gestao' },
  { id: 'implantacao', rotulo: 'Implantação', destino: '/configuracoes', grupo: 'gestao' },
  /*
   * SECAO PROPRIA, nao aba. /configuracoes/integracoes tem cabecalho, sub-abas roteadas e um
   * "Voltar para Configuracoes" -- ela SAI da fileira em vez de trocar o painel dentro dela.
   * Marcar isso evita pendurar nela um `?aba=` que ninguem le.
   */
  { id: 'integracoes', rotulo: 'Integrações', destino: '/configuracoes/integracoes', secao: true, grupo: 'gestao' },
  { id: 'regua', rotulo: 'Régua de cobrança', destino: '/configuracoes', titular: true, grupo: 'gestao' },
];

/*
 * AS ABAS QUE EXISTIAM DUAS VEZES, com dois nomes.
 *
 * "Plano e consumo" (Operação) e "Minha assinatura" (Gestão) eram a mesma assinatura partida
 * ao meio: uma dizia quanto custa, a outra mostrava a fatura. "Membros" e "Usuários" eram as
 * mesmas pessoas. A Fase E juntou o CONTEÚDO das duas — e deixou os dois nomes na fileira, o
 * que tornou a duplicação mais visível em vez de menor.
 *
 * Agora cada uma é UMA aba, e quem a desenha depende do que o cliente comprou:
 *
 *   com Gestão ...... a tela de lá, que já mostra as duas metades juntas
 *   sem Gestão ...... a da Operação, que é o único lugar que ele tem
 *
 * Não é divergência: são populações que não se cruzam. Um Pró não comprou Gestão, e a tela
 * dela não existiria para ele nem como link.
 */
const ABAS_DUPLAS = [
  /*
   * CONTA VIROU DUPLA em 01/09 — Etapa 2 da unificação de Configurações.
   *
   * Ela era só da Operação (#/settings). Agora existe em React na tela da Gestão
   * (conta-settings.tsx), falando com a API da Operação pelo navegador. Quem tem Gestão vê a
   * versão de lá; quem não tem continua na tela da Operação, que fica de pé até a etapa 7
   * daquele plano (settings.js morre por último, com redirecionamento).
   *
   * SEM `titular`: perfil e senha são de todo mundo, operador incluído — como sempre foram.
   */
  {
    id: 'conta',
    rotulo: 'Conta',
    grupo: 'conta',
    naGestao: '/configuracoes',
    naOperacao: '#/settings',
  },
  {
    id: 'assinatura',
    rotulo: 'Assinatura',
    titular: true,
    grupo: 'conta',
    naGestao: '/configuracoes',
    naOperacao: '#/settings',
  },
  {
    id: 'pessoas',
    rotulo: 'Pessoas',
    titular: true,
    grupo: 'conta',
    naGestao: '/configuracoes',
    naOperacao: '#/settings',
  },
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
/*
 * O DESTINO TEM DE DIZER QUAL ABA, senao ele nao e um destino: e a porta do predio.
 *
 * Seis abas apontavam para `/configuracoes` pelado e cinco caiam na errada -- a que abria por
 * padrao do outro lado. E o `?aba=` que as da Operacao ja carregavam nao era lido por ninguem:
 * estava escrito no href e ignorado nas duas telas, entao `#/settings?aba=billing` abria em
 * "Conta" do mesmo jeito.
 *
 * Aqui a marca e posta a partir do ID, e nao escrita a mao em cada linha. Uma aba nova nao tem
 * como esquecer de se apontar -- que e exatamente como estas seis se perderam.
 *
 * Um destino que JA tem query ou que aponta para outra pagina (`/configuracoes/integracoes` e uma
 * secao propria, com cabecalho e volta) fica como esta: ele ja diz aonde vai.
 */
function comAba(aba, destino) {
  if (aba.secao || destino.includes('?')) return destino;
  return destino + '?aba=' + encodeURIComponent(aba.id);
}

function montarAbas({ plano, papel, dono, op }) {
  const temOperacao = !!(plano && plano.operacao_enabled);
  const temGestao = !!(plano && plano.gestao_enabled);
  const ge = (config.gestaoUrl || '').replace(/\/+$/, '');
  const titular = papel === 'TITULAR';

  const abas = [];
  /*
   * DOIS PORTÕES, e eles não são o mesmo.
   *
   * `titular` é canAdmin — quem administra o cliente. `dono` é org_owner — a pessoa a quem a
   * conta pertence. Todo dono é titular; nem todo titular é dono, e a diferença importa
   * exatamente numa aba: o registro de atividade nomeia cada membro e tudo o que ele mudou,
   * que é o tipo de registro que um colega não deveria ler sobre o outro.
   */
  const permitida = (a) => (!a.titular || titular) && (!a.dono || !!dono);

  // Sem GESTAO_URL não há para onde apontar, e uma aba que leva a lugar nenhum é pior que uma
  // aba ausente. Mesma condição que o menu usa.
  const desenhaGestao = temGestao && !!ge;

  if (temOperacao) {
    for (const a of ABAS_OPERACAO.filter(permitida)) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${op}/app${comAba(a, a.destino)}`, modulo: 'operacao', grupo: a.grupo });
    }
  }

  if (desenhaGestao) {
    for (const a of ABAS_GESTAO.filter(permitida)) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${ge}${comAba(a, a.destino)}`, modulo: 'gestao', grupo: a.grupo });
    }
  }

  /*
   * As duplas entram UMA vez, apontando para quem as desenha para este cliente. Ficam por
   * último porque são as mais gerais: quem abre configurações costuma vir atrás do que é
   * específico (integrações, régua) e tropeça nas gerais no caminho.
   *
   * Sem nenhum dos dois módulos não há aba nenhuma — situação que só existe num plano sem
   * direito a nada, e aí a lista vazia é a resposta honesta.
   */
  for (const a of ABAS_DUPLAS.filter(permitida)) {
    if (desenhaGestao) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${ge}${comAba(a, a.naGestao)}`, modulo: 'gestao', grupo: a.grupo });
    } else if (temOperacao) {
      abas.push({ id: a.id, rotulo: a.rotulo, href: `${op}/app${comAba(a, a.naOperacao)}`, modulo: 'operacao', grupo: a.grupo });
    }
  }

  return { abas };
}

// A porta do navegador: sessão da Operação, workspace já resolvido por resolveTenancy.
router.get('/', (req, res) => {
  res.json(montarAbas({
    plano: tenantPlan.planRowFor(req.workspaceId),
    papel: gestaoRole(req),
    dono: ehDono(req),
    op: require('./menu').baseOperacao(req),
  }));
});

module.exports = router;
module.exports.montarAbas = montarAbas;
