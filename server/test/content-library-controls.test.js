'use strict';

/*
 * Two controls left the library, and one arrived.
 *
 * GONE: the "show expired" toggle, and the folder move in the batch bar.
 * ARRIVED: adding the selected files to a playlist.
 *
 * These are UI-shape checks, which are weak on their own — they prove a control is absent, not
 * that the behaviour behind it is right. The behaviour lives in playlist-items-batch.test.js and
 * content-expiry-not-customer-editable.test.js. What this file catches is the removal quietly
 * regressing, or the listing going back to hiding expired files by default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const web = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', 'js', ...p), 'utf8');
const library = web('views', 'content-library.js');
const apiClient = web('api.js');

test('expired files are always listed, with no toggle to turn them off', () => {
  /*
   * A file hidden from its own library because it stopped playing is the one file its owner most
   * needs to see. The flag is gone rather than pinned to true, so nothing can set it back.
   */
  assert.doesNotMatch(library, /showExpiredToggle/, 'the checkbox must be gone');
  assert.doesNotMatch(library, /state\.showExpired/, 'and so must the state behind it');
  assert.match(library, /api\.getContent\([^,]+, true, \{/, 'the listing always asks for expired items');
});

test('the folder move is gone from the batch bar', () => {
  // One folder exists — the library you are looking at — so the control could only be clicked by
  // mistake. The endpoint and tables underneath are dormant, not removed.
  assert.doesNotMatch(library, /batchMoveFolder/);
  assert.doesNotMatch(library, /batchMoveContent/);
  assert.doesNotMatch(apiClient, /batchMoveContent/, 'the client method goes with it');
});

test('a barra manda a seleção para vários destinos de uma vez', () => {
  /*
   * A capacidade sobreviveu à mudança de forma. Eram dois menus na barra — "Adicionar à lista…" e
   * "Enviar para tela…" — e viraram um botão que abre a lista de destinos.
   */
  assert.match(library, /id: 'enviar-para'/, 'a ação existe na barra');
  assert.match(library, /abrirEnviarPara\(/, 'e ela abre o seletor de destino');
  assert.match(library, /api\.batchAddPlaylistItems\(playlist_alvo_ids, ids\)/,
    'playlists pelo endpoint em lote, não num laço');
  assert.match(library, /api\.batchAssign\(\{ device_ids, group_ids, content_ids: ids \}\)/,
    'telas e grupos pelo endpoint em lote também');
  assert.match(apiClient, /batchAddPlaylistItems: \(playlistIds, contentIds\)/);
  assert.match(apiClient, /playlist_ids: playlistIds/, 'as listas viajam como conjunto, num pedido só');
});

test('o seletor de destino funciona no celular: um modal, não dois menus flutuantes', () => {
  /*
   * O motivo da mudança, dito pelo Vitor: "ao abrir no mobile teremos dificuldades". Dois painéis
   * de 230px numa barra que já não cabe abrem por cima um do outro; um modal ocupa a tela.
   *
   * A checagem é de forma, e forma é o que estava errado — mas ela também guarda as duas
   * armadilhas do painel antigo, que o modal não tem por construção: fechar no blur (fecharia na
   * primeira marcação) e redesenhar ao marcar (brigaria com a caixa recém-clicada).
   */
  const modal = web('components', 'enviar-para-modal.js');
  assert.match(modal, /position:fixed;inset:0/, 'é um modal, e não um painel preso à barra');
  assert.doesNotMatch(modal, /onblur/, 'fechar no blur fecharia na primeira marcação');
  /*
   * A FATIA PRECISA EXISTIR, e isto quase passou batido: o componente foi reescrito em duas
   * etapas, a variável mudou de nome, `indexOf` devolveu -1, e a fatia ficou VAZIA — o teste
   * passou sem olhar nada. Uma âncora que não é conferida sobrevive a qualquer reescrita.
   */
  const iMarcar = modal.indexOf("corpo.addEventListener('change'");
  const iEnviar = modal.indexOf("botao.addEventListener('click'");
  assert.ok(iMarcar > 0 && iEnviar > iMarcar,
    'as âncoras existem: sem isto a fatia abaixo mede o vazio e o teste passa à toa');
  const aoMarcar = modal.slice(iMarcar, iEnviar);
  assert.doesNotMatch(aoMarcar, /desenhar[A-Za-z]*\(\)/,
    'marcar não pode redesenhar a lista que está sendo marcada');
});

test('o espaço próprio das telas não aparece entre as playlists', () => {
  /*
   * Defeito visto pelo Vitor: "aparecem playlists que não deveriam aparecer, que são as playlists
   * raiz das telas". Uma lista is_auto_generated é o conteúdo de ALGUMA tela; mandar um arquivo
   * "para a lista da Bar do Porto" é mandar para a tela Bar do Porto, escrito de um jeito que
   * ninguém reconhece — e a tela está logo acima, na mesma janela.
   */
  const modal = web('components', 'enviar-para-modal.js');
  assert.match(modal, /filter\(\(p\) => !p\.is_auto_generated\)/,
    'as listas automáticas são filtradas antes de virarem opção');
});

test('a mensagem diz que já está exibindo — e NÃO que falta publicar', () => {
  /*
   * ESTE TESTE COBRAVA UMA MENTIRA, e por isso mudou de lado.
   *
   * Ele exigia a frase "publique a lista para enviar às telas", e estava certo enquanto adicionar
   * marcava rascunho. Desde 31/08 o que entra vai para o ar — decisão do Vitor: "tudo já deveria
   * ficar salvo e não ser preciso clicar em salvar ou publicar".
   *
   * Um teste que exige uma frase falsa não protege nada: ele DEFENDE o defeito, e teria feito a
   * próxima pessoa recolocar o aviso.
   */
  assert.doesNotMatch(library, /publique/i,
    'a tela não pode mais pedir que se publique: não há o que publicar');
  assert.match(library, /já exibindo/,
    'e o aviso diz o que de fato aconteceu');
});
