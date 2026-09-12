'use strict';

// COTAÇÕES — UMA FONTE SÓ (11/09). Decisão do Vitor: "Pode utilizar o agrobr, mas coloque a fonte.
// Utilize somente ele". Estes casos seguram os dois lados da frase: o mapeador traduz o JSON do
// serviço agrobr para o que o widget desenha (com o crédito e o dia do indicador), e a lib não
// carrega mais nenhuma das fontes antigas (AgroDoc, cotacaodocafe).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mapear, fmt } = require('../lib/cotacoes');

const RESPOSTA_DO_SERVICO = {
  cotacoes: [
    { chave: 'boi', nome: 'Boi gordo', unidade: 'R$/@ (arroba)', valor: 349.5, variacao: 0, data: '2026-09-11', praca: 'São Paulo/SP' },
    { chave: 'soja', nome: 'Soja', unidade: 'R$/saca 60kg', valor: 160.55, variacao: -0.73, data: '2026-09-11', praca: 'Paranaguá/PR' },
    { chave: 'cafe', nome: 'Café arábica', unidade: 'R$/saca 60kg', valor: 1596.87, variacao: -1.36, data: '2026-09-11', praca: 'Sul de MG' },
    { chave: 'cafe_robusta', nome: 'Café conilon', unidade: 'R$/saca 60kg', valor: 992.96, variacao: null, data: '2026-09-11', praca: 'Espírito Santo' },
  ],
  fonte: 'CEPEA/ESALQ',
  fonte_url: 'https://www.cepea.org.br/br/indicador/',
  atualizado: '2026-09-11',
};

test('fmt escreve pt-BR com milhar e duas casas, sem depender de ICU', () => {
  assert.equal(fmt(1596.87), '1.596,87');
  assert.equal(fmt(349.5), '349,50');
  assert.equal(fmt(69.77), '69,77');
  assert.equal(fmt('abc'), null);
});

test('mapear traduz o JSON do serviço para o que o widget desenha, na ordem em que veio', () => {
  const r = mapear(RESPOSTA_DO_SERVICO);
  assert.ok(r);
  assert.deepEqual(r.cotacoes.map((c) => c.nome), ['Boi gordo', 'Soja', 'Café arábica', 'Café conilon']);
  assert.deepEqual(r.cotacoes[2], { nome: 'Café arábica', unidade: 'R$/saca 60kg', valor: '1.596,87', variacao: -1.36 });
  // variação 0 é uma variação (o boi ficou parado): tem de aparecer, não sumir
  assert.equal(r.cotacoes[0].variacao, 0);
  // variação nula (série de um dia só) NÃO vira campo — o widget só desenha quando existe
  assert.equal('variacao' in r.cotacoes[3], false);
});

test('o crédito vai para a tela com o dia do indicador, não com o relógio de agora', () => {
  const r = mapear(RESPOSTA_DO_SERVICO);
  assert.equal(r.fonte, 'CEPEA/ESALQ · 11/09');
  assert.equal(r.atualizado, '2026-09-11');
});

test('sem dia válido o crédito fica só a fonte; sem itens o mapeador devolve null (e o widget cai no manual)', () => {
  assert.equal(mapear({ cotacoes: [{ nome: 'Soja', valor: 1 }], fonte: 'CEPEA/ESALQ' }).fonte, 'CEPEA/ESALQ');
  assert.equal(mapear({ cotacoes: [] }), null);
  assert.equal(mapear(null), null);
  assert.equal(mapear({ cotacoes: [{ nome: 'Soja', valor: 'não é número' }] }), null);
});

test('a lib não conhece mais nenhuma das fontes antigas — "utilize somente ele"', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../lib/cotacoes.js'), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // sem comentários
  for (const antiga of ['agrodoc', 'cotacaodocafe', 'noticiasagricolas']) {
    assert.equal(codigo.toLowerCase().includes(antiga), false, 'a fonte antiga ' + antiga + ' voltou');
  }
  assert.ok(codigo.includes("process.env.COTACOES_URL"), 'a única fonte é o serviço COTACOES_URL');
});

test('o render automático escreve o crédito "Fonte:" no subtítulo', () => {
  const { renderWidgetHtml } = require('../lib/widget-render');
  const html = renderWidgetHtml('cotacoes', { auto: true });
  assert.ok(html.includes('id="coFonte">Fonte: CEPEA/ESALQ<'), 'o subtítulo automático nasce com o crédito');
  const manual = renderWidgetHtml('cotacoes', { auto: false });
  assert.ok(manual.includes('id="coFonte">hoje<'), 'o manual não credita ninguém');
});
