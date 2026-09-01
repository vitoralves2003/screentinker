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
  /*
   * Pelo TERMO, e não pela expressão inteira. A primeira versão fixava
   * `filter((p) => !p.is_auto_generated)` e quebrou quando o filtro ganhou um segundo corte —
   * a lista de contrato, que também não pertence ali. A intenção não tinha mudado, só a linha.
   *
   * E o pior dessa âncora não é o vermelho: é o hábito de atualizar o teste sem ler o que ele
   * diz. Quando isso vira rotina, o dia em que o vermelho É um defeito passa igual.
   */
  assert.match(modal, /!p\.is_auto_generated/,
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

test('o seletor de destino: busca sempre, e tipo sem nenhum não aparece', () => {
  /*
   * Dois pedidos do Vitor, e os dois corrigem decisões minhas.
   *
   * A busca aparecia só acima de seis itens. Parecia limpo e era pior: o comportamento da tela
   * mudava sozinho conforme a conta crescia, debaixo de quem já tinha aprendido onde as coisas
   * ficam.
   *
   * E "não pode aparecer grupos se não haver nenhum" — uma opção que leva a uma lista vazia é uma
   * promessa quebrada em dois cliques. É a mesma regra que o modal de adicionar conteúdo já usa
   * para as abas pagas, e que eu não repeti aqui.
   */
  const modal = web('components', 'enviar-para-modal.js');
  assert.doesNotMatch(modal, /length > 6 \? '' : 'none'/,
    'a busca não pode aparecer só acima de um número de itens');
  assert.match(modal, /const comAlgum = permitir\.filter\(\(tipo\) => dados\[tipo\]\.length > 0\)/,
    'os tipos sem nenhum item são filtrados antes de virarem opção');
  assert.match(modal, /if \(comAlgum\.length === 1\)/,
    'e com um tipo só o menu é pulado: ele seria um botão único levando ao único lugar possível');
});

test('o botão não parece cortado: "Enviar para…", e não "Enviar 3…"', () => {
  /*
   * "Enviar 1…" lê como texto cortado — foi assim que o Vitor o descreveu, "mostrando apenas uma
   * parte", e não havia corte nenhum. A reticência depois de um número parece um fim de palavra
   * que não coube; depois de "para", vira uma pergunta em aberto.
   *
   * A contagem era redundante: a barra já diz quantos estão selecionados.
   */
  for (const [nome, fonte] of [['biblioteca', library], ['playlists', web('views', 'playlists.js')]]) {
    assert.match(fonte, /label: \(\) => 'Enviar para…'/, `${nome}: o rótulo é uma frase completa`);
    assert.doesNotMatch(fonte, /label: \(count\) => `Enviar \$\{count\}…`/,
      `${nome}: o rótulo com contagem e reticência não voltou`);
  }
});

test('o número no botão diz de onde vem', () => {
  /*
   * O Vitor viu "Enviar para 2" com as duas caixas à frente desmarcadas, e se incomodou — com
   * razão. O que ficava marcado em outro tipo continuava contando, e a contagem aparecia sem
   * nenhuma pista de onde saiu: "2 do quê? Não vejo nenhum."
   *
   * A persistência entre tipos fica — mandar para dois grupos E uma tela avulsa é raro, mas quem
   * tem de enviar duas vezes um dia envia uma só e não percebe. O que faltava era DIZER.
   */
  const modal = web('components', 'enviar-para-modal.js');
  assert.match(modal, /id="epResumo"/, 'existe uma linha de resumo');
  assert.match(modal, /Marcado: \$\{partes\.join\(' · '\)\}/,
    'e ela soletra o total por tipo, em vez de só repetir o número');
  /*
   * Ela vive DENTRO de atualizarBotao, que é chamado em todos os caminhos que mexem na contagem.
   * Uma linha atualizada num lugar só ficaria certa às vezes — que é pior que não existir.
   */
  const fn = modal.slice(modal.indexOf('function atualizarBotao()'), modal.indexOf('function desenharTipos()'));
  assert.ok(fn.length > 100, 'a âncora existe: sem isto a fatia mede o vazio');
  assert.match(fn, /resumo\.style\.display/, 'o resumo acompanha o botão, e não um caminho só');
});
