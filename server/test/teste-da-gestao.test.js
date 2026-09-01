'use strict';

/*
 * O TESTE DE 14 DIAS COBRE SÓ A GESTÃO — e o dia 15 não pode encostar na tela.
 *
 * ── A RAZÃO QUE ESTAVA ESCRITA, E QUE CONTINUA VALENDO ───────────────────────────────────
 * O código recusava trial, com esta frase:
 *
 *   "a trial that expires silently takes features away from a screen already running in
 *    someone's shop"
 *
 * Ela é sobre RECURSO NUMA TELA QUE JÁ RODA. Por isso o plano do teste tem a MESMA cota de tela
 * do grátis: no dia 15 o rebaixamento fecha o módulo de gestão e a tela da padaria não percebe
 * nada. Se um dia alguém der duas telas ao teste, a frase volta a valer — e é este arquivo que
 * deve gritar.
 *
 * ── E O REBAIXAMENTO PRECISA DISPARAR ───────────────────────────────────────────────────
 * Ele só acontece quando plan_id é igual a trial_plan. O comentário em subscription.js conta que
 * uma versão anterior tinha um guard sempre-falso e "every signup kept Pro free forever". Aqui a
 * armadilha equivalente seria trial_plan ficar NULL.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-testegestao-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = '';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');
const { getUserPlan } = require('../middleware/subscription');

const DIA = 86400;
const agora = () => Math.floor(Date.now() / 1000);

const criaUsuario = ({ plano, trialStarted, trialPlan }) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id,email,password_hash,role,plan_id,trial_started,trial_plan)
              VALUES (?,?,'x','user',?,?,?)`)
    .run(id, `t-${id.slice(0, 8)}@t.invalid`, plano, trialStarted, trialPlan);
  return id;
};

before(() => { /* o esquema já semeia os planos */ });
after(() => { try { db.close(); } catch { /* */ } });

test('o plano do teste é o grátis mais a Gestão, e nada mais', () => {
  const teste = db.prepare("SELECT * FROM plans WHERE id = 'teste'").get();
  const free = db.prepare("SELECT * FROM plans WHERE id = 'free'").get();

  assert.ok(teste, 'o plano do teste existe');
  assert.equal(teste.gestao_enabled, 1, 'dá a Gestão — é o ponto do teste');

  /*
   * NADA DA OPERAÇÃO. O Vitor aprovou "teste só na Gestão"; acrescentar widget ou sub-lista aqui
   * traria de volta exatamente o que a recusa de trial evitava — uma tela perdendo recurso no
   * dia 15.
   */
  assert.equal(teste.widgets_enabled, 0, 'não empresta widgets');
  assert.equal(teste.sublists_enabled, 0, 'nem listas dentro de listas');
  assert.equal(teste.layouts_enabled, 0, 'nem layouts');

  assert.equal(teste.max_devices, free.max_devices,
    'A MESMA COTA DE TELA DO GRÁTIS — é isto que faz o dia 15 ser inofensivo para a tela');
});

/*
 * Não pode ser comprado nem escolhido à mão: é um ESTADO, não um produto. getUserPlan resolve por
 * JOIN em plan_id sem filtrar active, então active = 0 esconde da venda sem quebrar a resolução.
 */
test('o plano do teste não está à venda', () => {
  const aVenda = db.prepare('SELECT id FROM plans WHERE active = 1').all().map((p) => p.id);
  assert.ok(!aVenda.includes('teste'), 'não aparece na lista de planos');
});

test('durante o teste, a Gestão está aberta e a tela existe', () => {
  const id = criaUsuario({ plano: 'teste', trialStarted: agora() - 3 * DIA, trialPlan: 'teste' });
  const plano = getUserPlan(id);

  assert.equal(plano.trial_active, true);
  assert.equal(plano.gestao_enabled, 1, 'a Gestão está aberta');
  assert.equal(plano.max_devices, 1, 'e a tela grátis continua lá');
  assert.equal(plano.trial_days_left, 11, '14 menos os 3 já corridos');
});

/*
 * ── O DIA 15 ────────────────────────────────────────────────────────────────────────────
 * O caso que decide se a decisão do Vitor foi respeitada.
 */
test('quando o teste acaba: a Gestão fecha e a TELA CONTINUA', () => {
  const id = criaUsuario({ plano: 'teste', trialStarted: agora() - 15 * DIA, trialPlan: 'teste' });
  const plano = getUserPlan(id);

  assert.equal(plano.plan_id, 'free', 'rebaixou para o grátis');
  assert.equal(plano.gestao_enabled, 0, 'a Gestão fechou');

  assert.equal(plano.max_devices, 1,
    'A TELA CONTINUA. É a razão inteira de o teste cobrir só a Gestão: uma tela que já roda numa '
    + 'loja não pode perder nada no dia 15.');

  const linha = db.prepare('SELECT plan_id, trial_started FROM users WHERE id = ?').get(id);
  assert.equal(linha.plan_id, 'free', 'e ficou gravado, não só calculado');
  assert.equal(linha.trial_started, null, 'o teste foi encerrado, não recalculado a cada leitura');
});

/*
 * ── A ARMADILHA DO trial_plan NULO ──────────────────────────────────────────────────────
 * Com trial_plan NULL o rebaixamento nunca dispara, porque ele exige plan_id === trial_plan. O
 * sintoma seria silencioso e caro: todo cadastro com a Gestão de graça, para sempre. Foi assim,
 * por outro caminho, que "every signup kept Pro free forever".
 */
test('trial_plan nulo faria o teste nunca acabar — por isso ele é gravado', () => {
  const quebrado = criaUsuario({ plano: 'teste', trialStarted: agora() - 15 * DIA, trialPlan: null });
  const plano = getUserPlan(quebrado);

  assert.equal(plano.plan_id, 'teste',
    'CONFIRMA A ARMADILHA: sem trial_plan o rebaixamento não dispara e a Gestão fica de graça');

  // E o cadastro de verdade não cai nela:
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const ocorrencias = (rota.match(/trialStarted \? plan : null/g) || []).length;
  assert.equal(ocorrencias, 2,
    'os DOIS caminhos de cadastro — senha e Google — gravam trial_plan');
});

/*
 * ── AS DUAS PORTAS DÃO O MESMO FUNIL ────────────────────────────────────────────────────
 * Duas entradas com funis diferentes viram dois produtos, e a diferença só apareceria semanas
 * depois: "por que o vizinho tem Gestão e eu não?".
 */
test('entrar por senha e entrar pelo Google dão o mesmo teste', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const ocorrencias = (rota.match(/: 'teste';/g) || []).length;
  assert.equal(ocorrencias, 2, 'os dois caminhos caem no mesmo plano de teste');
});

test('quem já tem plano pago não é rebaixado', () => {
  const id = criaUsuario({ plano: 'master', trialStarted: agora() - 15 * DIA, trialPlan: 'teste' });
  const plano = getUserPlan(id);
  assert.equal(plano.plan_id, 'master',
    'plan_id !== trial_plan protege um plano dado à mão de ser rebaixado sozinho');
});
