'use strict';

/*
 * TODA ABA DE CONFIGURAÇÕES DECLARA A QUEM PERTENCE: conta, gestao ou operacao.
 *
 * É o contrato da unificação de Configurações (plano fechado com o Vitor em 01/09). A fileira
 * é servida por montarAbas, e o grupo é o que vai permitir às abas DA CONTA existirem para
 * todo assinante enquanto as de módulo seguem atrás do plano.
 *
 * ── O QUE ESTA SUÍTE IMPEDE ─────────────────────────────────────────────────────────────
 * Uma aba nova nascer sem grupo. O campo viaja até a fileira e, adiante, decide visibilidade —
 * uma aba `grupo: undefined` não é "sem dono": é uma aba que cada consumidor classificaria de
 * um jeito. Foi assim que o `?aba=` da 5b ficou escrito e nunca lido: nenhum teste perguntava.
 *
 * A base é isolada em memória e injetada no cache do require — o mesmo desenho de
 * admin-plans-visibility.test.js. montarAbas recebe o plano pronto, então a base nem é lida
 * por ele; a injeção existe só para o require da rota não abrir o arquivo de verdade.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-grupo-abas';
// Sem GESTAO_URL, desenhaGestao é false e as abas da Gestão nem entram — o teste mediria só
// metade da fileira. A URL é falsa de propósito: montarAbas monta href, não navega.
process.env.GESTAO_URL = 'http://gestao.teste.invalid';

const db = new Database(':memory:');
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { montarAbas } = require('../routes/configuracoes');

const GRUPOS = ['conta', 'gestao', 'operacao'];
const OP = 'http://operacao.teste.invalid';

function abasDe(plano) {
  return montarAbas({ plano, papel: 'TITULAR', dono: true, op: OP }).abas;
}

const AMBOS = { operacao_enabled: 1, gestao_enabled: 1 };
const SO_OPERACAO = { operacao_enabled: 1, gestao_enabled: 0 };
const SO_GESTAO = { operacao_enabled: 0, gestao_enabled: 1 };

test('toda aba servida declara um grupo válido, nos três perfis de plano', () => {
  for (const plano of [AMBOS, SO_OPERACAO, SO_GESTAO]) {
    const abas = abasDe(plano);
    assert.ok(abas.length > 0, 'a fileira não pode vir vazia com um módulo contratado');
    for (const a of abas) {
      assert.ok(
        GRUPOS.includes(a.grupo),
        `a aba "${a.id}" veio com grupo "${a.grupo}" — toda aba declara conta, gestao ou operacao`,
      );
    }
  }
});

test('com os dois módulos, os dois grupos aparecem — e "operacao" é vazio HOJE', () => {
  const grupos = new Set(abasDe(AMBOS).map((a) => a.grupo));
  assert.ok(grupos.has('conta'), 'as abas da conta existem');
  assert.ok(grupos.has('gestao'), 'as abas do módulo Gestão existem');
  /*
   * Medido em 01/09: a Operação não tem configuração de módulo — as quatro abas dela são
   * todas DA CONTA. Se este assert quebrar é porque alguém criou a primeira aba de módulo da
   * Operação, e aí ele deve ser atualizado de caso zero para caso um, não removido.
   */
  assert.ok(!grupos.has('operacao'), 'o grupo operacao é vazio hoje, por medição');
});

test('sem o módulo Gestão, nenhuma aba do grupo gestao é servida', () => {
  const abas = abasDe(SO_OPERACAO);
  assert.equal(abas.filter((a) => a.grupo === 'gestao').length, 0);
  // ...mas as da conta continuam — é a definição do grupo.
  assert.ok(abas.some((a) => a.grupo === 'conta'));
});

test('as abas da conta existem nos três perfis — são de todo assinante', () => {
  for (const plano of [AMBOS, SO_OPERACAO, SO_GESTAO]) {
    const daConta = abasDe(plano).filter((a) => a.grupo === 'conta').map((a) => a.id);
    /*
     * `conta` entrou aqui na Etapa 2, quando virou dupla: antes ela era só da Operação e um
     * assinante só-Gestão não tinha ONDE trocar a senha. Agora as três populações a veem.
     */
    /*
     * `atividade` entrou na Etapa 3, quando também virou dupla. O fixture chama montarAbas
     * com dono: true — para quem não é dono ela continua fora, e isso é da regra do dono,
     * não do grupo.
     */
    for (const obrigatoria of ['assinatura', 'pessoas', 'conta', 'atividade']) {
      assert.ok(
        daConta.includes(obrigatoria),
        `"${obrigatoria}" falta no plano ${JSON.stringify(plano)}: ${daConta.join(', ')}`,
      );
    }
  }
});

/*
 * ── EMPRESA É DA CONTA, E A PORTA JÁ DISTINGUE ─────────────────────────────────────────
 * Este teste guardava o estado anterior (empresa presa no grupo gestao) e existia para
 * ficar vermelho quando o grupo mudasse — mudou em 01/09, na Etapa 7, JUNTO da isenção
 * @ContaDoProduto no guarda da Gestão (porta-da-conta.spec.ts, do outro lado, prova que a
 * porta deixa a conta passar e recusa o módulo).
 *
 * O que se trava agora é o estado novo: empresa no grupo conta, presente para os TRÊS
 * perfis de plano — inclusive só-Operação, que era exatamente quem a porta barrava.
 */
test('empresa é da conta e aparece nos três perfis', () => {
  for (const plano of [AMBOS, SO_OPERACAO, SO_GESTAO]) {
    const empresa = abasDe(plano).find((a) => a.id === 'empresa');
    assert.ok(empresa, `empresa falta no plano ${JSON.stringify(plano)}`);
    assert.equal(empresa.grupo, 'conta');
  }
});

/*
 * ── E O GRUPO DA CONTA VEM ANTES DO GRUPO DO MÓDULO ────────────────────────────────────
 * Empresa sempre foi a primeira aba; ao entrar no grupo da conta, o grupo veio junto para a
 * frente. Se alguém devolver as gerais para o fim, a fileira reordena para todo mundo — e
 * isso deve ser decisão, não acidente de ordenação de listas.
 */
test('a fileira lê conta primeiro, módulo depois', () => {
  const grupos = abasDe(AMBOS).map((a) => a.grupo);
  const ultimaConta = grupos.lastIndexOf('conta');
  const primeiraGestao = grupos.indexOf('gestao');
  assert.ok(primeiraGestao === -1 || ultimaConta < primeiraGestao,
    `abas fora de ordem: ${abasDe(AMBOS).map((a) => a.id + ':' + a.grupo).join(', ')}`);
});
