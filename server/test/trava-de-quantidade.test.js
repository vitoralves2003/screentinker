'use strict';

/*
 * A TRAVA DE QUANTIDADE — o contrato permite N mídias, e a N+1 é recusada.
 *
 * ── POR QUE O ESPELHO, E NÃO UMA PERGUNTA À GESTÃO ──────────────────────────────────────
 * A trava morde no caminho mais quente do produto. Uma chamada de rede aqui faria a Gestão fora
 * do ar — o que acontece a cada deploy dela — impedir o assinante de mexer nos próprios
 * arquivos. Então a Gestão empurra o número, e a Operação lê local.
 *
 * ── E ELE FALHA ABERTO ──────────────────────────────────────────────────────────────────
 * Contrato sem linha não tem limite. O contrário — ausência lida como zero — pararia todo
 * contrato que a Operação ainda não conhece, que hoje são todos os 65. É a mesma escolha de
 * `contratos_suspensos`, e pela mesma razão: o estrago de errar para o lado fechado aparece na
 * parede de uma loja, não num log.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-travaqtd-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');

let ctx;

before(() => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')")
    .run(userId, `tq-${userId.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

const criaArquivo = (contrato, { ativo = 1, expira = null } = {}) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,contrato_id,is_active,expires_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, ctx.userId, ctx.wsId, id.slice(0, 6) + '.png', '/tmp/x.png', 'image/png', contrato, ativo, expira);
  return id;
};

/* A mesma contagem que a rota faz. Se ela mudar de critério, este teste tem de mudar junto. */
const emUso = (contrato, excluindo) => db.prepare(`
  SELECT COUNT(*) c FROM content
   WHERE contrato_id = ? AND workspace_id = ? AND id != ?
     AND is_active = 1 AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
`).get(contrato, ctx.wsId, excluindo || '').c;

test('o espelho guarda o limite, e some quando não há nenhum', () => {
  const contrato = 'ctr-' + crypto.randomBytes(3).toString('hex');

  db.prepare(`INSERT INTO contratos_limites (contrato_id, workspace_id, max_midias, max_segundos)
              VALUES (?,?,?,?)`).run(contrato, ctx.wsId, 3, 15);

  const lido = db.prepare(
    'SELECT max_midias, max_segundos FROM contratos_limites WHERE contrato_id = ? AND workspace_id = ?',
  ).get(contrato, ctx.wsId);
  assert.equal(lido.max_midias, 3);
  assert.equal(lido.max_segundos, 15);

  /*
   * Um contrato pode ter quantidade sem duração — o Vitor separou as duas: a quantidade recusa
   * para todos, a duração morde no portal do anunciante. As colunas são independentes por isso.
   */
  db.prepare('UPDATE contratos_limites SET max_segundos = NULL WHERE contrato_id = ?').run(contrato);
  assert.equal(
    db.prepare('SELECT max_segundos FROM contratos_limites WHERE contrato_id = ?').get(contrato).max_segundos,
    null,
    'a duração pode não existir sem levar a quantidade junto',
  );
});

/*
 * ── SIMULTÂNEAS, E NÃO UPLOADS ──────────────────────────────────────────────────────────
 * Contar uploads faria "substituir" custar uma vaga: trocar a peça de setembro pela de outubro
 * seria recusado por causa de um arquivo que ninguém mais vê. O plano diz "mídias simultâneas",
 * e é isso que a contagem tem de significar.
 */
test('a contagem ignora o que está desativado e o que venceu', () => {
  const contrato = 'ctr-' + crypto.randomBytes(3).toString('hex');

  criaArquivo(contrato);                                  // conta
  criaArquivo(contrato);                                  // conta
  criaArquivo(contrato, { ativo: 0 });                    // desativado: não conta
  criaArquivo(contrato, { expira: 1000 });                // vencido em 1970: não conta

  assert.equal(emUso(contrato), 2,
    'só o que está no ar ocupa vaga — senão substituir uma mídia custaria uma');
});

test('o arquivo que está sendo editado não conta contra ele mesmo', () => {
  const contrato = 'ctr-' + crypto.randomBytes(3).toString('hex');
  const a = criaArquivo(contrato);
  criaArquivo(contrato);

  assert.equal(emUso(contrato, a), 1,
    'reeditar um arquivo que já é do contrato não pode ser recusado por causa dele próprio');
});

test('arquivo de outro contrato, e arquivo sem contrato, não ocupam vaga', () => {
  const meu = 'ctr-' + crypto.randomBytes(3).toString('hex');
  const outro = 'ctr-' + crypto.randomBytes(3).toString('hex');

  criaArquivo(meu);
  criaArquivo(outro);
  criaArquivo(null);

  assert.equal(emUso(meu), 1);
});

/*
 * ── A ROTA: onde a trava mora, e o que ela diz ──────────────────────────────────────────
 * Uma porta só — medido: `contrato_id` entra apenas por PUT /content/:id; o upload não o aceita.
 */
test('a trava está na rota, e só na entrada de um contrato', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8');

  assert.match(rota, /if \(mudouContrato && contrato_id\) \{/,
    'só quando ENTRA num contrato: recusar a saída prenderia o arquivo no contrato errado');
  assert.match(rota, /FROM contratos_limites WHERE contrato_id = \? AND workspace_id = \?/,
    'lê o espelho local, e com o workspace na cláusula');
  assert.match(rota, /if \(limite && limite\.max_midias\)/,
    'FALHA ABERTO: sem linha, ou sem número, não há limite');
  assert.match(rota, /status\(409\)/,
    'conflito, e não erro de validação — o pedido está correto, o estado é que não permite');

  /*
   * A RECUSA DIZ O NÚMERO E O QUE FAZER. "Limite atingido" sozinho manda a pessoa procurar onde
   * o limite mora — e ela não vai achar, porque ele está noutro sistema.
   */
  assert.match(rota, /aumente o limite na aba Mídias do contrato/,
    'a mensagem diz onde mudar o limite');
  assert.match(rota, /codigo: 'limite_de_midias'/,
    'e traz um código, para a tela poder reagir sem ler texto');

  /*
   * ── E A CONTAGEM DA ROTA, e não a minha cópia dela ────────────────────────────────────
   * Os testes acima medem a regra com uma consulta escrita aqui dentro. Isso prova que EU sei
   * escrever a consulta certa — não que a rota a usa. Descoberto por contraprova: tirar esta
   * cláusula da rota deixava os seis verdes.
   *
   * É a regra que o Vitor destacou — mídias SIMULTÂNEAS, substituir vale. Sem ela, trocar a
   * peça de setembro pela de outubro seria recusado por causa de um arquivo que ninguém vê.
   */
  const contagem = rota.slice(rota.indexOf('SELECT COUNT(*) c FROM content'));
  assert.ok(contagem.length > 100, 'a âncora da contagem existe: sem isto a fatia mede o vazio');
  assert.match(contagem.slice(0, 400), /is_active = 1/,
    'a contagem da ROTA ignora o desativado');
  assert.match(contagem.slice(0, 400), /expires_at IS NULL OR expires_at >/,
    'e ignora o vencido');
});

test('a rota que recebe o limite trata nulo como remoção, não como silêncio', () => {
  const contratos = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contratos.js'), 'utf8');
  const bloco = contratos.slice(contratos.indexOf("router.put('/:id/limites'"));

  assert.ok(bloco.length > 400, 'a âncora existe: sem isto a fatia mede o vazio');
  assert.match(bloco, /DELETE FROM contratos_limites/,
    'sem nenhum dos dois limites a linha SAI — uma linha de nulos é indistinguível de "ainda não sei"');
  assert.match(bloco, /ON CONFLICT\(contrato_id\) DO UPDATE SET/,
    'e reenviar o mesmo estado não cria uma segunda linha');
});
