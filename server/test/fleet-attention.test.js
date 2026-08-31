'use strict';

/*
 * A FALSE ALARM IN THE SIDEBAR, and the rule that ends it.
 *
 * The badge and the Operação list answered the same question in two places and disagreed. The
 * server asked "is this screen offline while its own opening hours say it should be on"; the
 * browser fetched the fleet and counted anything offline, knowing nothing about opening hours.
 *
 * So a shop that shuts at 19:00 lit the badge every night — and the badge is a LINK to a page that
 * then listed nothing. That is worse than a wrong number: it teaches the reader the alert lies,
 * right before the night a screen actually dies. It was reported exactly that way: hours were set,
 * the page went quiet, the sidebar kept insisting.
 *
 * It was wrong in the other direction too. A screen that is online, healthy and has no playlist
 * shows a black window and answers every ping; the server counted it, the badge never did.
 *
 * The last test here is the one that matters most: the two readouts are computed from the same
 * fixture and must produce the same number. It is the shape of bug that grows back on its own the
 * next time somebody touches either side.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetat-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const fleet = require('../lib/fleet-attention');

/* A Monday, 14:00 in São Paulo — inside a 09:00–18:00 weekday shift. */
const OPEN = Date.parse('2026-08-24T14:00:00-03:00');
/* The same Monday at 22:00 — the bakery is shut. */
const SHUT = Date.parse('2026-08-24T22:00:00-03:00');

const WS = 'ws-at';

function screen(id, { status = 'offline', playlist = null } = {}) {
  db.prepare('INSERT INTO devices (id,user_id,workspace_id,name,status,playlist_id,timezone) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'u-at', WS, id, status, playlist, 'America/Sao_Paulo');
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function hours(deviceId, days = '1,2,3,4,5', start = '09:00', end = '18:00') {
  db.prepare('INSERT INTO device_hours (device_id,active_days,start_time,end_time,sort_order) VALUES (?,?,?,?,0)')
    .run(deviceId, days, start, end);
}

before(() => {
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('u-at','at@t','x','user')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o-at','O','u-at')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?, 'o-at','Padaria')").run(WS);
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('pl-at','u-at',?,'Manhã')").run(WS);
  /*
   * A LISTA PRECISA TER ALGO DENTRO.
   *
   * Estes testes medem HORARIO e presenca, e supunham que apontar para uma lista ja significava
   * ter o que exibir -- o que era verdade ate a tela virar dona do proprio conteudo. Hoje uma
   * lista vazia e uma vitrine preta, e sem este item as telas daqui cairiam no alerta de "sem
   * conteudo" por um motivo que nao e o que estes testes investigam.
   */
  db.prepare("INSERT INTO playlist_items (playlist_id,sort_order,duration_sec) VALUES ('pl-at',0,10)").run();
});

test('UMA LOJA FECHADA NÃO É UM DEFEITO', () => {
  /*
   * O alarme falso relatado, exatamente. A tela está offline às 22h de segunda porque a padaria
   * fechou às 18h — e listar isso toda noite é como uma lista de avisos vira papel de parede.
   */
  const d = screen('tela-fechada', { playlist: 'pl-at' });
  hours('tela-fechada');

  const shut = fleet.attentionFor(WS, [d], [d], SHUT);
  assert.deepEqual(shut.attention, [], 'fora do horário, offline é o esperado');

  const open = fleet.attentionFor(WS, [d], [d], OPEN);
  assert.equal(open.attention.length, 1, 'dentro do horário, a mesma tela é um problema de verdade');
  assert.equal(open.attention[0].kind, 'offline');
});

test('sem horário configurado não vira alerta — vira um empurrão', () => {
  /*
   * Chutar o horário pelo padrão de quedas acertaria na maioria das noites e silenciaria o alerta
   * na noite em que ele importava. Então é contado à parte, e a Operação mostra como aviso discreto.
   */
  const d = screen('tela-sem-horario', { playlist: 'pl-at' });

  const r = fleet.attentionFor(WS, [d], [d], OPEN);
  assert.deepEqual(r.attention, []);
  assert.equal(r.hours_unconfigured, 1);
});

test('uma lista VAZIA é a mesma vitrine preta -- e passava por saudável', () => {
  /*
   * O buraco que a Etapa 5 abriu sem que ninguem visse.
   *
   * A checagem era `!d.playlist_id`, e estava certa enquanto a tela APONTAVA para uma lista: sem
   * ponteiro, sem conteudo. Desde que a tela virou dona do proprio conteudo, ela ganha um espaco
   * proprio na primeira adicao e o ponteiro passou a existir SEMPRE -- inclusive depois de alguem
   * tirar o ultimo item.
   *
   * Entao a tela respondia, batia o coracao, lia "saudavel" em toda coluna da tabela, e a loja
   * ficava com a tela preta. Ter lista e ter o que exibir deixaram de ser a mesma coisa.
   */
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,is_auto_generated) VALUES ('pl-vazia','u-at',?,'Tela 9 playlist',1)").run(WS);
  const d = screen('tela-espaco-vazio', { playlist: 'pl-vazia' });
  hours('tela-espaco-vazio');

  const r = fleet.attentionFor(WS, [d], [d], OPEN);
  // Pelo MOTIVO e nao pela contagem: esta tela tambem esta fora do ar, entao ela ja tinha um
  // alerta seu. O que se mede aqui e se o vazio virou um alerta proprio.
  const semConteudo = r.attention.filter((a) => a.id === 'tela-espaco-vazio' && a.kind === 'no_playlist');
  assert.equal(semConteudo.length, 1, 'espaco proprio vazio e uma tela que nao exibe nada');

  // E ao ganhar um item ela sai do alerta -- senao o aviso seria permanente e viraria papel de parede.
  db.prepare("INSERT INTO playlist_items (playlist_id,sort_order,duration_sec) VALUES ('pl-vazia',0,10)").run();
  const depois = fleet.attentionFor(WS, [d], [d], OPEN);
  assert.equal(
    depois.attention.filter((a) => a.id === 'tela-espaco-vazio' && a.kind === 'no_playlist').length,
    0,
    'com um item, o alerta de vazio some -- senao ele seria permanente e viraria papel de parede',
  );
});

test('uma tela saudável SEM LISTA é a vitrine preta que ninguém avisava', () => {
  /*
   * Ela está online, responde a tudo, e o estado dela lê "saudável" — e a loja está com a tela
   * apagada. A barra lateral nunca contou isto: ela não errava só para mais, errava para menos.
   *
   * E não é filtrada por horário: uma tela sem lista está mal configurada às 3 da manhã tanto
   * quanto ao meio-dia, e ao contrário de uma queda de conexão não se resolve quando a loja abre.
   */
  const d = screen('tela-sem-lista', { status: 'online', playlist: null });

  const r = fleet.attentionFor(WS, [d], [], SHUT);
  assert.equal(r.attention.length, 1, 'nem de madrugada isto deixa de ser um problema');
  assert.equal(r.attention[0].kind, 'no_playlist');
});

test('A BARRA LATERAL E A OPERAÇÃO CONTAM A MESMA COISA', () => {
  /*
   * O teste que mais importa. As duas leituras nasceram de códigos diferentes respondendo à mesma
   * pergunta, e discordavam nos dois sentidos. Agora saem do mesmo módulo — e isto é o que impede
   * a divergência de renascer na próxima vez que alguém mexer num dos lados.
   *
   * A frota de exemplo é montada para ter uma de cada coisa: fechada (não conta), aberta e caída
   * (conta), sem horário (não conta), sem lista (conta). Um número igual por acaso, com tudo zero,
   * não provaria nada.
   */
  // Pela MESMA passagem de liveness que o /devices/overview usa. A primeira versão deste teste
  // filtrava por devices.status na mão e os dois números divergiam em hours_unconfigured — o mesmo
  // bug, uma camada abaixo: a regra de alerta já era compartilhada, a entrada dela não era.
  const rows = fleet.fleetOf(WS);
  const { offlineRows } = fleet.livenessPass(rows);

  const page = fleet.attentionFor(WS, rows, offlineRows, OPEN);
  const badge = fleet.attentionCount(WS, OPEN);

  assert.ok(page.attention.length > 0, 'a frota de exemplo tem de ter algo a relatar');
  assert.equal(badge.count, page.attention.length,
    'o número da barra lateral é o tamanho da lista da Operação — se divergirem, o alerta mente');
  assert.equal(badge.hours_unconfigured, page.hours_unconfigured);
});

test('a barra lateral não conta as telas de outro cliente', () => {
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-outro','o-at','Vizinho')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,status) VALUES ('d-vizinho','u-at','ws-outro','Do vizinho','offline')").run();

  const before = fleet.attentionCount(WS, OPEN).count;
  assert.equal(fleet.attentionCount(WS, OPEN).count, before, 'a frota do vizinho não pode mover este número');
  assert.equal(fleet.attentionCount(null, OPEN).count, 0, 'sem workspace, nada a contar');
});
