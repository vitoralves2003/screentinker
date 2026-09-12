'use strict';

// UMA NOTÍCIA SÓ (12/09) — editorias e parceiros na mesma lista, com os dois formatos antigos
// convertidos na leitura. As decisões do Vitor que estes casos seguram: mistura livre (rodízio
// único por ordem de publicação) e conversão automática dos 12 widgets que já estão no ar.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { lerFontes, escreverFontes, misturar, chaveDaUrl, EDITORIAS } = require('../lib/fontes-de-noticia');

test('o formato novo é lido como veio, com editorias e parceiros separados para quem busca', () => {
  const r = lerFontes({ fontes: ['g1:agro', 'parceiro:766bda82', 'g1:geral'] });
  assert.deepEqual(r.chaves, ['g1:agro', 'parceiro:766bda82', 'g1:geral']);
  assert.deepEqual(r.parceiros, ['766bda82']);
  assert.equal(r.editorias.length, 2);
  assert.ok(r.editorias[0].includes('agronegocios'));
});

test('o widget de Notícias antigo (feed_urls) vira chaves de editoria', () => {
  const r = lerFontes({ feed_urls: ['https://g1.globo.com/rss/g1/economia/agronegocios/'] });
  assert.deepEqual(r.chaves, ['g1:agro']);
  assert.deepEqual(r.parceiros, []);
});

test('o widget de Notícias do Parceiro antigo (fonte_id) vira uma chave de parceiro', () => {
  const r = lerFontes({ fonte_id: '766bda82-e2b6-486c-a9d1-37e843b91eab' });
  assert.deepEqual(r.chaves, ['parceiro:766bda82-e2b6-486c-a9d1-37e843b91eab']);
  assert.deepEqual(r.editorias, []);
  assert.deepEqual(r.parceiros, ['766bda82-e2b6-486c-a9d1-37e843b91eab']);
});

test('o formato mais velho ainda (feed_url, um só) também é convertido', () => {
  assert.deepEqual(lerFontes({ feed_url: 'https://ge.globo.com/rss/ge/' }).chaves, ['g1:esportes']);
});

test('uma config já convertida não é reescrita pelo que sobrou da antiga', () => {
  // O widget guardava feed_urls; ao salvar no formato novo, as chaves velhas podem continuar lá.
  const r = lerFontes({ fontes: ['parceiro:abc'], feed_urls: ['https://g1.globo.com/rss/g1/'], fonte_id: 'xyz' });
  assert.deepEqual(r.chaves, ['parceiro:abc']);
});

test('URL desconhecida não deixa a tela vazia — cai em Geral', () => {
  assert.deepEqual(lerFontes({ feed_urls: ['https://algumportal.com.br/feed'] }).chaves, ['g1:geral']);
});

test('widget de parceiro sem fonte escolhida segue sem fonte, e a tela mostra amostra', () => {
  const r = lerFontes({ fonte_id: '' });
  assert.deepEqual(r.chaves, []);
  assert.deepEqual(r.editorias, []);
  assert.deepEqual(r.parceiros, []);
});

test('config vazia ou lixo não quebra a leitura', () => {
  for (const entrada of [null, undefined, {}, { fontes: 'nao-e-lista' }, { fontes: ['', '   '] }]) {
    assert.deepEqual(lerFontes(entrada).chaves, []);
  }
});

test('escrever prefixa o que a tela marcou e nunca grava lista vazia', () => {
  assert.deepEqual(escreverFontes(['agro', 'parceiro:abc']), ['g1:agro', 'parceiro:abc']);
  assert.deepEqual(escreverFontes([]), ['g1:geral']);
  assert.deepEqual(escreverFontes(['g1:agro', 'g1:agro']), ['g1:agro'], 'sem repetir');
  assert.deepEqual(escreverFontes(['editoria-que-nao-existe']), ['g1:geral']);
});

test('a mistura é um rodízio só, do mais novo para o mais velho', () => {
  const rss = [
    { title: 'Soja em alta', date: '2026-09-12T08:00:00Z' },
    { title: 'Boi estável', date: '2026-09-11T08:00:00Z' },
  ];
  const parceiro = [
    { title: 'Feira do produtor', date: '2026-09-12T10:00:00Z', qr: 'data:image/gif;base64,AAA' },
  ];
  assert.deepEqual(misturar([rss, parceiro]).map((i) => i.title), ['Feira do produtor', 'Soja em alta', 'Boi estável']);
});

test('item sem data vai para o fim, na ordem em que chegou, em vez de fingir ser de hoje', () => {
  const itens = misturar([
    [{ title: 'sem data' }, { title: 'sem data 2' }],
    [{ title: 'com data', date: '2026-09-10T00:00:00Z' }],
  ]);
  assert.deepEqual(itens.map((i) => i.title), ['com data', 'sem data', 'sem data 2']);
});

test('toda editoria do catálogo tem chave, rótulo e URL, e as chaves não se repetem', () => {
  const chaves = new Set();
  for (const e of EDITORIAS) {
    assert.ok(e.chave && e.rotulo && /^https:\/\//.test(e.url), `editoria incompleta: ${e.chave}`);
    assert.equal(chaves.has(e.chave), false, `chave repetida: ${e.chave}`);
    chaves.add(e.chave);
    assert.equal(chaveDaUrl(e.url), e.chave, 'a URL volta para a própria chave');
  }
});
