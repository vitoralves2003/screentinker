'use strict';

/*
 * THE UPSTREAM PLANS ARE GONE — and the guard that stops that going wrong.
 *
 * Starter, Pro and Enterprise came from ScreenTinker, priced in USD, describing a product this one
 * does not sell. Marked inactive they still filled a third of the admin plans table with tiers
 * nobody could buy and nobody recognised, which a reader has to check before learning each is
 * irrelevant — every time they open the page.
 *
 * ── WHY DELETING A PLAN IS NOT A COSMETIC CHANGE ─────────────────────────────────────────────
 * lib/tenant-plan.js resolves a tenant's plan by JOINing plans. Delete a row somebody is on and
 * the JOIN yields nothing, so the COALESCE falls through to 'free' — silently handing a paid
 * customer the free tier's limits and pricing their month at zero. On a table nobody watches.
 *
 * So the migration deletes only when NOTHING points at any of them, and it is all-or-nothing:
 * one reference anywhere and all three stay. This test is the record of that rule, because the
 * tempting "simplification" is to drop the NOT EXISTS clauses that make it look complicated.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-plans-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'legacy-plans-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { db } = require('../db/database');

/*
 * 'pro' SAIU DESTA LISTA, e por um motivo que precisa estar escrito.
 *
 * O projeto original tinha starter/pro/enterprise. Hoje 'pro' e o id do NOSSO plano Pro --
 * R$ 25 por tela, em real, ativo e vendido. Guardar 'pro' aqui faria este teste exigir que
 * o produto apagasse o proprio plano a cada boot.
 *
 * A migracao que apagava os tres tambem saiu de db/database.js pelo mesmo motivo: ela teria
 * apagado o Pro em qualquer instalacao onde ninguem estivesse nele, e havia uma segunda que
 * o marcaria como inativo e em dolar.
 */
const LEGACY = ['starter', 'enterprise'];

test('uma instalação nova não nasce com os planos estrangeiros', () => {
  const rows = db.prepare(
    `SELECT id FROM plans WHERE id IN (${LEGACY.map(() => '?').join(',')})`
  ).all(...LEGACY);
  assert.deepEqual(rows, [], 'starter/enterprise não podem existir num banco novo');
});

/*
 * 'teste' É UM ESTADO, NÃO UM PRODUTO — e por isso é o único que pode estar inativo.
 *
 * Ele é o grátis mais a Gestão, por 14 dias (ver teste-da-gestao.test.js). active = 0 é o que o
 * esconde da lista de venda e impede que alguém o escolha à mão — routes/subscription.js filtra
 * por active nos dois lugares. getUserPlan resolve por JOIN em plan_id e não filtra, então o
 * estado continua valendo.
 *
 * A exceção é NOMEADA, e o teste exige que ela seja a única. Uma isenção em branco ("ignore os
 * inativos") apagaria a guarda inteira: qualquer plano abandonado passaria a caber nela.
 */
const ESTADO_NAO_VENDAVEL = ['teste'];

test('e o que sobra é vendável, em real', () => {
  const rows = db.prepare('SELECT id, currency, active FROM plans ORDER BY sort_order').all();
  assert.ok(rows.length >= 3, 'os três planos do produto têm de estar lá');

  for (const r of rows) {
    assert.equal(r.currency, 'BRL', `${r.id} não está em real`);

    if (ESTADO_NAO_VENDAVEL.includes(r.id)) {
      assert.equal(r.active, 0,
        `${r.id} é um estado e NÃO pode aparecer à venda`);
      continue;
    }
    assert.equal(r.active, 1, `${r.id} está inativo — um plano que ninguém pode contratar`);
  }
});

test('o seed não os traz de volta no próximo boot', () => {
  /*
   * A migração apaga; o seed reinseriria. Os dois vivem em arquivos diferentes e nada os obriga a
   * concordar, então isto lê o schema — o comportamento "some e volta a cada reinício" seria
   * invisível em qualquer teste que só olhasse o banco depois de UM boot.
   */
  // OS DOIS ARQUIVOS. A semente saiu de schema.sql e foi para a lista de migracoes de
  // database.js -- o schema e exec-ado antes dos ALTER TABLE, e um INSERT que cite uma
  // coluna nova falha ali num banco que ja existia. Olhar so um dos dois deixaria o
  // "some e volta no proximo boot" invisivel exatamente como antes.
  const schema = ['schema.sql', 'database.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'))
    .join('\n')
    .split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//')).join('\n');

  for (const id of LEGACY) {
    assert.ok(!new RegExp(`\\('${id}'`).test(schema), `schema.sql ainda semeia '${id}'`);
  }
});

test('MAS UM PLANO EM USO NÃO É APAGADO', () => {
  /*
   * A regra inteira. Apagar um plano em que alguém está faz tenant-plan.js cair para 'free': o
   * cliente perde os limites que paga e o mês dele é precificado a zero, sem nada em tela nenhuma
   * dizendo que aconteceu.
   *
   * A GUARDA É POR LINHA, não pelo conjunto. A primeira versão deste teste exigia "tudo ou nada"
   * — porque foi assim que EU descrevi a query no comentário, e não é o que ela faz: os NOT EXISTS
   * são correlacionados, então cada plano é julgado pelas próprias referências. O que a query faz
   * é melhor do que o que eu tinha escrito, então o que mudou foi a descrição.
   *
   * Reproduzido rodando a MESMA instrução da migração contra um banco onde um workspace aponta
   * para um deles. Reescrevê-la aqui seria testar a cópia; então é a query, palavra por palavra.
   */
  /*
   * O ALVO MUDOU, A REGRA NAO. A remocao de starter/pro/enterprise saiu de database.js --
   * 'pro' virou o id do nosso proprio plano, e aquela instrucao o teria apagado. A migracao
   * que sobrou apaga premium e corporate, as bandas antigas que viraram pro e master, e
   * carrega exatamente as mesmas clausulas de seguranca. E ela que este teste protege agora.
   */
  db.prepare(`INSERT INTO plans (id,name,display_name,max_devices,max_storage_mb,currency,active)
              VALUES ('premium','premium','Premium',-1,15360,'BRL',1),
                     ('corporate','corporate','Corporativo',-1,51200,'BRL',1)`).run();

  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-lp','lp@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-lp','O','u-lp')").run();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_by,plan_id)
              VALUES ('ws-lp','o-lp','Cliente antigo','u-lp','premium')`).run();

  db.prepare(`DELETE FROM plans
     WHERE id IN ('premium','corporate')
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.plan_id = plans.id)
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.plan_id = plans.id)`).run();

  const left = db.prepare(
    "SELECT id FROM plans WHERE id IN ('premium','corporate') ORDER BY id"
  ).all().map((r) => r.id);

  assert.deepEqual(left, ['premium'],
    'o plano em uso fica; o que ninguém usa vai embora');

  // E o cliente continua resolvendo para o plano dele, que é o ponto de tudo isto.
  const { planIdFor } = require('../lib/tenant-plan');
  assert.equal(planIdFor('ws-lp'), 'premium', 'o cliente não pode ter caído para free');
});
