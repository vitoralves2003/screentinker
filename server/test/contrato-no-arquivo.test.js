'use strict';

/*
 * O ARQUIVO SABE DE QUAL CONTRATO É — e mudar isso muda o que a tela exibe.
 *
 * A coluna `content.contrato_id` é a autoridade da Etapa 6: a suspensão mira ela, e não a
 * playlist do contrato, porque um arquivo do contrato pode estar solto numa tela.
 *
 * ── O QUE ESTE TESTE GUARDA ──────────────────────────────────────────────────────────────
 * Trocar o contrato de um arquivo pode mudar se ele deve aparecer. Sair de um contrato suspenso
 * para um em dia tem de DEVOLVER o arquivo ao ar; entrar num suspenso tem de TIRÁ-LO. E o que a
 * tela exibe é o `published_snapshot`, montado na publicação — sem republicar, as duas coisas
 * ficam certas no banco e invisíveis na parede.
 *
 * É a mesma armadilha que a suspensão teve: a marca certa e o snapshot velho. Ela não dá erro
 * em lugar nenhum, e quem for descobrir vai descobrir olhando a tela.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-contrato-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');
const { publishPlaylist, __test } = require('../routes/playlists');

let ctx;

before(() => {
  const userId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')")
    .run(userId, `ct-${userId.slice(0, 8)}@t.invalid`);
  const orgId = crypto.randomUUID();
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)')
    .run(orgId, 'Org contrato', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS contrato', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

function criarArquivo(contratoId) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec,contrato_id)
              VALUES (?,?,?,?,?,'image/png',10,?)`)
    .run(id, ctx.userId, ctx.wsId, 'a.png', '/tmp/a.png', contratoId);
  return id;
}

function criarLista(contentIds) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,'L','draft')")
    .run(id, ctx.userId, ctx.wsId);
  contentIds.forEach((c, i) =>
    db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,?,10)')
      .run(id, c, i));
  return id;
}

function noSnapshot(playlistId) {
  const p = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId);
  try {
    return JSON.parse(p.published_snapshot || '[]').map((i) => i.content_id).filter(Boolean);
  } catch { return []; }
}

function suspender(contratoId) {
  db.prepare(`INSERT OR REPLACE INTO contratos_suspensos (contrato_id,workspace_id,motivo,suspenso_em)
              VALUES (?,?,'teste',strftime('%s','now'))`).run(contratoId, ctx.wsId);
}

test('um arquivo de contrato suspenso não entra no snapshot', () => {
  const contrato = 'ctr-suspenso-' + crypto.randomBytes(3).toString('hex');
  const arquivo = criarArquivo(contrato);
  const lista = criarLista([arquivo]);

  publishPlaylist(lista, null);
  assert.deepEqual(noSnapshot(lista), [arquivo], 'sanidade: sem marca, o arquivo exibe');

  suspender(contrato);
  publishPlaylist(lista, null);
  assert.deepEqual(noSnapshot(lista), [], 'com o contrato suspenso, o arquivo sai');
});

test('e um arquivo SEM contrato nunca é afetado por marca nenhuma', () => {
  /*
   * O caso que ninguém escreve e que é o mais caro: a suspensão não pode levar junto material do
   * próprio assinante. Um defeito aqui apagaria a vitrine de quem não deve nada.
   */
  const contrato = 'ctr-x-' + crypto.randomBytes(3).toString('hex');
  const doContrato = criarArquivo(contrato);
  const livre = criarArquivo(null);
  const lista = criarLista([doContrato, livre]);

  suspender(contrato);
  publishPlaylist(lista, null);
  assert.deepEqual(noSnapshot(lista), [livre],
    'só o do contrato suspenso sai; o sem contrato continua exibindo');
});

test('a suspensão alcança o arquivo SOLTO, fora da lista do contrato', () => {
  /*
   * É por isto que a autoridade é o arquivo e não a playlist. Se a suspensão mirasse a lista do
   * contrato, este arquivo seguiria no ar — ele não está nela — e o anunciante inadimplente
   * ganharia veiculação de graça, sem nada parecer errado em tela nenhuma.
   */
  const contrato = 'ctr-solto-' + crypto.randomBytes(3).toString('hex');
  const solto = criarArquivo(contrato);
  const listaDaTela = criarLista([solto]);   // o espaço de uma tela, não a lista do contrato

  publishPlaylist(listaDaTela, null);
  assert.deepEqual(noSnapshot(listaDaTela), [solto]);

  suspender(contrato);
  publishPlaylist(listaDaTela, null);
  assert.deepEqual(noSnapshot(listaDaTela), [], 'o arquivo solto para junto');
});

test('trocar de contrato muda o que a tela exibe', () => {
  const suspenso = 'ctr-s-' + crypto.randomBytes(3).toString('hex');
  const emDia = 'ctr-d-' + crypto.randomBytes(3).toString('hex');
  suspender(suspenso);

  const arquivo = criarArquivo(suspenso);
  const lista = criarLista([arquivo]);
  publishPlaylist(lista, null);
  assert.deepEqual(noSnapshot(lista), [], 'começa fora do ar, no contrato suspenso');

  // A troca que a rota PUT /content/:id faz.
  db.prepare('UPDATE content SET contrato_id = ? WHERE id = ?').run(emDia, arquivo);
  publishPlaylist(lista, null);
  assert.deepEqual(noSnapshot(lista), [arquivo],
    'movido para um contrato em dia, volta ao ar — e é por isso que a rota republica ao trocar');
});

test('o construtor do snapshot é o mesmo para todos os caminhos', () => {
  /*
   * A condição de suspensão vive numa consulta só, dentro de buildSnapshotItems. Se alguém
   * escrever um segundo construtor, ele nascerá sem a condição — e a suspensão passaria a valer
   * em alguns caminhos e não em outros, que é pior que não existir.
   */
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playlists.js'), 'utf8');
  const ocorrencias = (fonte.match(/contratos_suspensos/g) || []).length;
  assert.equal(ocorrencias, 1,
    'a condição aparece exatamente uma vez: duas seriam duas cópias, zero seria a suspensão sem efeito');
  assert.ok(__test && __test.buildSnapshotItems, 'buildSnapshotItems continua sendo o construtor');
});
