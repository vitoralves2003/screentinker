'use strict';

/*
 * "ESTA LISTA ESTÁ EM N TELAS" — e as DUAS portas por onde ela chega lá.
 *
 * ── O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR ───────────────────────────────────────
 * `/api/playlists` já devolve um `screen_list`, e reusá-lo seria o caminho óbvio. Ele conta
 * apenas `devices.playlist_id = p.id` — a lista sendo a PRINCIPAL da tela.
 *
 * Não é assim que a lista de um contrato chega numa tela. Ela entra como ITEM dentro do espaço
 * próprio da tela (`playlist_items.sub_playlist_id`), que é o caminho que a página da tela
 * oferece. Contando só a primeira porta, a linha diria "0 telas" com a lista tocando em cinco —
 * e ninguém duvidaria dela, porque é um número e número parece medido.
 *
 * Esta é a substituta da conferência de colocação, que caiu quando o Vitor decidiu não registrar
 * as telas no contrato. Ela MOSTRA em vez de julgar — e por isso o número precisa estar certo:
 * um alerta errado a pessoa contesta, um número errado ela acredita.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-ondelista-' + crypto.randomBytes(4).toString('hex'));
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
    .run(userId, `ol-${userId.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

const criaLista = (nome, extra = {}) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO playlists (id,user_id,workspace_id,name,status,is_auto_generated,contrato_id)
              VALUES (?,?,?,?,'published',?,?)`)
    .run(id, ctx.userId, ctx.wsId, nome, extra.auto ? 1 : 0, extra.contrato || null);
  return id;
};

const criaTela = (nome, playlistId) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,pairing_code)
              VALUES (?,?,?,?,?,?)`)
    .run(id, ctx.userId, ctx.wsId, nome, playlistId, String(Math.floor(100000 + Math.random() * 900000)));
  return id;
};

const poeDentro = (listaDaTela, sublista) => {
  db.prepare('INSERT INTO playlist_items (playlist_id, sub_playlist_id, sort_order) VALUES (?,?,0)')
    .run(listaDaTela, sublista);
};

/* A mesma consulta da rota, medida contra dados de verdade. */
const ondeEsta = (listaId) => db.prepare(`
  SELECT d.id, d.name
    FROM devices d
   WHERE d.workspace_id = ? AND d.playlist_id = ?
  UNION
  SELECT d.id, d.name
    FROM devices d
    JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
   WHERE d.workspace_id = ? AND pi.sub_playlist_id = ?
   ORDER BY name COLLATE NOCASE
`).all(ctx.wsId, listaId, ctx.wsId, listaId);

test('acha a lista quando ela é a principal da tela', () => {
  const lista = criaLista('Lista principal');
  criaTela('Bar do Porto', lista);

  const telas = ondeEsta(lista);
  assert.equal(telas.length, 1);
  assert.equal(telas[0].name, 'Bar do Porto');
});

/*
 * ── A PORTA QUE IMPORTA ─────────────────────────────────────────────────────────────────
 * É por aqui que a lista de um contrato chega numa tela: como item do espaço próprio dela. Se a
 * consulta não olhasse esta porta, o número seria zero com a mídia no ar.
 */
test('acha a lista quando ela está DENTRO do espaço da tela', () => {
  const espacoDaTela = criaLista('Posto Rodovia playlist', { auto: true });
  const doContrato = criaLista('Padaria — Indoor', { contrato: 'ctr-1' });
  criaTela('Posto Rodovia', espacoDaTela);
  poeDentro(espacoDaTela, doContrato);

  const telas = ondeEsta(doContrato);
  assert.equal(telas.length, 1, 'a lista do contrato está numa tela, ainda que não como principal');
  assert.equal(telas[0].name, 'Posto Rodovia');
});

/*
 * ── E NÃO CONTA A MESMA TELA DUAS VEZES ─────────────────────────────────────────────────
 * "Está em 6 telas" com 5 nomes na lista é o tipo de número que destrói a confiança no resto da
 * tela. Por isso UNION, e não UNION ALL.
 */
test('uma tela que a tem pelas duas portas conta uma vez só', () => {
  const lista = criaLista('Nos dois caminhos');
  const tela = criaTela('Loja Centro', lista);
  poeDentro(lista, lista);   // a lista contém a si mesma como slot

  const telas = ondeEsta(lista).filter((t) => t.id === tela);
  assert.equal(telas.length, 1, 'uma tela, uma linha');
});

test('lista que não está em tela nenhuma devolve vazio', () => {
  const solta = criaLista('Nunca colocada', { contrato: 'ctr-2' });
  assert.deepEqual(ondeEsta(solta), []);
});

test('não vaza tela de outro assinante', () => {
  const outroUser = crypto.randomUUID();
  const outraOrg = crypto.randomUUID();
  const outroWs = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')")
    .run(outroUser, `x-${outroUser.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(outraOrg, 'Outra', outroUser);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(outroWs, outraOrg, 'WS2', outroUser);

  const lista = criaLista('Compartilhada por engano');
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,pairing_code)
              VALUES (?,?,?,?,?,?)`)
    .run(id, outroUser, outroWs, 'Tela do vizinho', lista, '654321');

  assert.deepEqual(ondeEsta(lista), [],
    'a tela do outro assinante não aparece — o workspace está nas DUAS metades da união');
});

/* ── E a rota faz o que os testes acima medem ────────────────────────────────────────── */
test('a rota consulta as duas portas, e usa o guarda das irmãs', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playlists.js'), 'utf8');
  const bloco = rota.slice(rota.indexOf("router.get('/:id/telas'"));

  assert.ok(bloco.length > 400, 'a âncora existe: sem isto a fatia mede o vazio');
  assert.match(bloco.slice(0, 200), /requirePlaylistRead/,
    'o mesmo guarda das rotas irmãs — não uma segunda regra de acesso escrita à mão');
  assert.match(bloco, /d\.playlist_id = \?/, 'a porta da lista principal');
  assert.match(bloco, /pi\.sub_playlist_id = \?/, 'e a porta de dentro do espaço da tela');
  /*
   * A CONSULTA, e não a prosa em volta dela. A primeira versão afirmava sobre o bloco inteiro e
   * ficou vermelha por causa do próprio comentário da rota, que explica por que NÃO se usa
   * UNION ALL. Um teste que lê comentário mede o que eu escrevi SOBRE o código, não o código —
   * e o erro é sempre nessa direção: reprova texto correto, e aprovaria código errado se o
   * comentário dissesse a coisa certa.
   */
  const CRASE = String.fromCharCode(96);
  const sql = bloco.slice(bloco.indexOf(CRASE) + 1, bloco.indexOf(CRASE, bloco.indexOf(CRASE) + 1));
  assert.ok(sql.includes('SELECT'), 'a fatia pegou a consulta: sem isto ela mede o vazio');
  assert.match(sql, /\bUNION\b/, 'UNION, que remove a tela repetida');
  assert.doesNotMatch(sql, /UNION ALL/, 'nunca UNION ALL: contaria a mesma tela duas vezes');
});
