'use strict';

/*
 * O TESTE NÃO PODE EXPIRAR EM SILÊNCIO.
 *
 * A objeção que estava escrita no código era: *"um teste que expira em silêncio tira recurso de
 * uma tela que já está rodando na loja de alguém"*. Ela tem duas metades.
 *
 * A primeira já está fechada: o teste cobre só a Gestão, e o plano dele tem a mesma cota de tela
 * do grátis — nenhuma tela perde nada no dia 15 (ver teste-da-gestao.test.js).
 *
 * A segunda é o SILÊNCIO, e é o que este arquivo mede: a pessoa tem de saber que está num teste
 * e quanto falta dele, sem ir procurar.
 *
 * ── E PELA REGRA DO INQUILINO ───────────────────────────────────────────────────────────
 * `lib/tenant-plan.js` existe para ter encerrado três respostas divergentes sobre "qual é o
 * plano deste inquilino", e fixou: O INQUILINO É O WORKSPACE. O contador segue a mesma regra —
 * ler `trial_started` de quem está na sessão mostraria a um operador convidado o contador do
 * próprio cadastro, e não o do assinante em cuja conta ele trabalha.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-avisoteste-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = '';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');
const tenantPlan = require('../lib/tenant-plan');

const DIA = 86400;
const agora = () => Math.floor(Date.now() / 1000);

/*
 * O workspace nasce SEM plan_id de propósito, como o cadastro o cria: o plano vem do dono, pelo
 * fallback que o próprio tenant-plan chama de load-bearing.
 */
const criaInquilino = ({ planoDoDono, trialStarted, planoDoWorkspace = null }) => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();

  db.prepare(`INSERT INTO users (id,email,password_hash,role,plan_id,trial_started,trial_plan)
              VALUES (?,?,'x','user',?,?,?)`)
    .run(userId, `a-${userId.slice(0, 8)}@t.invalid`, planoDoDono, trialStarted,
      trialStarted ? planoDoDono : null);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,plan_id) VALUES (?,?,?,?,?)')
    .run(wsId, orgId, 'WS', userId, planoDoWorkspace);

  return { userId, wsId };
};

before(() => { /* os planos vêm do esquema */ });
after(() => { try { db.close(); } catch { /* */ } });

test('durante o teste, o contador existe e conta os dias que faltam', () => {
  const { wsId } = criaInquilino({ planoDoDono: 'teste', trialStarted: agora() - 2 * DIA });

  const t = tenantPlan.testeFor(wsId);
  assert.ok(t, 'há um teste em andamento');
  assert.equal(t.dias_restantes, 12, '14 menos os 2 já corridos');
});

/*
 * ── O ÚLTIMO DIA AINDA CONTA COMO UM ────────────────────────────────────────────────────
 * Arredondar para baixo mostraria "0 dias restantes" durante as últimas 24 horas — que lê como
 * "já acabou" para quem ainda tem um dia de uso.
 */
test('no último dia, mostra 1 e não 0', () => {
  const { wsId } = criaInquilino({ planoDoDono: 'teste', trialStarted: agora() - 13.5 * DIA });
  assert.equal(tenantPlan.testeFor(wsId).dias_restantes, 1);
});

test('acabado o prazo, o contador some', () => {
  const { wsId } = criaInquilino({ planoDoDono: 'teste', trialStarted: agora() - 15 * DIA });
  assert.equal(tenantPlan.testeFor(wsId), null,
    'nulo, e não "0 dias": a barra decide desenhar pela presença');
});

test('quem não está em teste não vê contador nenhum', () => {
  const { wsId } = criaInquilino({ planoDoDono: 'free', trialStarted: null });
  assert.equal(tenantPlan.testeFor(wsId), null);
});

/*
 * ── A REGRA DO INQUILINO ────────────────────────────────────────────────────────────────
 * Se o workspace tem plano próprio, é ele que manda — mesmo que o dono esteja em teste. Ler o
 * usuário aqui abriria a quarta resposta que tenant-plan existe para ter fechado.
 */
test('o plano do WORKSPACE manda, não o do dono', () => {
  const { wsId } = criaInquilino({
    planoDoDono: 'teste',
    trialStarted: agora() - 2 * DIA,
    planoDoWorkspace: 'master',
  });

  assert.equal(tenantPlan.testeFor(wsId), null,
    'o workspace é o inquilino: pago no workspace, não há teste a anunciar');
});

/* ── E o menu leva isso para a barra, que é o que os dois módulos desenham ────────────── */
test('o menu entrega o contador, pela mesma regra', () => {
  const menu = fs.readFileSync(path.join(__dirname, '..', 'routes', 'menu.js'), 'utf8');

  assert.match(menu, /teste: testeDoInquilino/,
    'o menu devolve o contador');
  assert.match(menu, /tenantPlan\.testeFor\(req\.workspaceId\)/,
    'e o obtém pela mesma regra que resolve o plano — não do usuário da sessão');

  /*
   * Na BARRA, e não numa tela de assinatura: um aviso lá só informa quem foi até lá, e quem está
   * usando a Gestão no dia 13 não vai. É o mesmo argumento que `atencao_telas` já usa neste
   * arquivo, e a razão de o contador viajar no menu.
   */
  assert.match(menu, /atencao_telas/,
    'ao lado do único outro número que o menu carrega, e pelo mesmo motivo');
});

/*
 * ── E A BARRA DESENHA ───────────────────────────────────────────────────────────────────
 * O servidor mandar o contador não é o mesmo que alguém vê-lo. Esta era a lacuna: o campo
 * viajava no menu e nada o desenhava — o aviso não existia, e todos os testes acima passavam.
 *
 * É o formato de defeito que mais escapa aqui: cada metade certa, e a corrente rompida.
 */
test('a barra desenha o contador, e some quando não há teste', () => {
  const barra = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'components', 'loop-sidebar.js'), 'utf8');

  /*
   * `includes` e não `match`: o que se procura aqui é uma STRING literal, e uma expressão
   * regular só acrescentaria escapes que podem sair errados — sem acrescentar poder nenhum.
   * (Esta versão do teste nasceu com os escapes comidos pelo shell, afirmando outra coisa.)
   */
  assert.ok(barra.includes('m.teste && Number(m.teste.dias_restantes)'),
    'lê o campo que o menu manda');

  assert.ok(barra.includes('class="teste"'),
    'e o desenha');

  assert.ok(barra.includes('${teste ? `'),
    'condicionado à presença: sem teste, nenhum elemento — e não um contador zerado');

  /*
   * Recolhida, a barra não tem largura para uma frase. Some — e o title do elemento guarda o
   * texto para quem passar o mouse.
   */
  assert.ok(barra.includes('[recolhida]) .teste'),
    'e some quando a barra está recolhida');
});
