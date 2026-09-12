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

// Achados da TV em pé (captura do Vitor, 11/09). O subtítulo ficou com duas linhas e o separador
// "·" do template pendurado sozinho no começo da segunda; e o boi, parado em 349,50 desde 09/09,
// aparecia com seta VERDE de alta em "0,0%".

test('o subtítulo separa mercado e fonte por layout, sem "·" solto para sobrar numa quebra', () => {
  const { renderWidgetHtml } = require('../lib/widget-render');
  const html = renderWidgetHtml('cotacoes', { auto: true, mercado: 'Mercado agropecuário' });
  const sub = /<div class="co-sub">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(sub, 'o subtítulo existe');
  assert.equal(/·/.test(sub[1]), false, 'nenhum separador literal entre os pedaços do subtítulo');
  assert.ok(sub[1].includes('<span>Mercado agropecuário</span>'), 'o mercado é um item próprio do flex');
  assert.ok(/\.co-sub \{[^}]*flex-wrap:wrap/.test(html), 'o subtítulo pode quebrar por inteiro');
});

test('variação que arredonda para 0,0% é PARADO: chip cinza e sem seta', () => {
  const { classeDaVariacao } = require('../lib/widget-render');
  assert.deepEqual(classeDaVariacao(0), { cls: 'flat', seta: '' });
  assert.deepEqual(classeDaVariacao(0.04), { cls: 'flat', seta: '' }, '0,04% também é lido como 0,0% na tela');
  assert.deepEqual(classeDaVariacao(-0.04), { cls: 'flat', seta: '' });
});

test('alta e baixa continuam com a seta e a cor de sempre', () => {
  const { classeDaVariacao } = require('../lib/widget-render');
  assert.deepEqual(classeDaVariacao(0.69), { cls: 'up', seta: '▲ ' });
  assert.deepEqual(classeDaVariacao(-1.36), { cls: 'down', seta: '▼ ' });
});

// O TRAVAMENTO (12/09): a tela Fire Stick tem UM item — o próprio widget, 23 s. O player repete o
// mesmo widget sem recarregar, então a "uma volta e fim" deixava o painel congelado na logo do
// patrocinador para sempre. Terminar na marca continua valendo; parar nela, não.

test('a marca ganha folga quando o slot é conhecido, e o ciclo nunca para', () => {
  const { tempoNaMarca, FOLGA_DA_TROCA_MS } = require('../lib/widget-render');
  assert.equal(tempoNaMarca(4000, true), 4000 + FOLGA_DA_TROCA_MS, 'com slot, a marca passa do fim do slot');
  assert.equal(tempoNaMarca(4000, false), 4000, 'sem slot (tela solta), nada muda — ali sempre alternou');
  assert.ok(FOLGA_DA_TROCA_MS > 0 && FOLGA_DA_TROCA_MS <= 3000, 'folga curta: é o tempo da troca, não uma pausa');
});

test('o script do widget reagenda a volta SEMPRE — nenhum caminho encerra o ciclo', () => {
  const { renderWidgetHtml } = require('../lib/widget-render');
  const html = renderWidgetHtml('cotacoes', { auto: true, patrocinador: true, logo_url: 'data:image/png;base64,AAA', __slot_seconds: 23 });
  assert.ok(html.includes('tempoNaMarca(SEG_MARCA, TEM_SLOT)'), 'o tempo na marca sai da função provada');
  assert.ok(html.includes('function tempoNaMarca('), 'a função viaja na página');
  const ciclo = /\(function ciclo\(\)\{[\s\S]*?\}\)\(\);/.exec(html);
  assert.ok(ciclo, 'o ciclo existe');
  assert.equal(/\breturn\b/.test(ciclo[0]), false, 'nenhuma saída antecipada dentro do ciclo');
  assert.equal((ciclo[0].match(/ciclo\(\);/g) || []).length, 1, 'ele se reagenda ao fim da marca');
  assert.ok(ciclo[0].trimEnd().endsWith('})();'), 'e se inicia sozinho');
});

test('a tela usa a MESMA função do teste — ela viaja no script do widget', () => {
  const { renderWidgetHtml } = require('../lib/widget-render');
  const html = renderWidgetHtml('cotacoes', { auto: true });
  assert.ok(html.includes('function classeDaVariacao(d)'), 'a função é injetada, não reescrita à mão');
  assert.ok(html.includes("co-chip '+est.cls+'"), 'o chip sai da decisão dela');
  assert.ok(html.includes('.co-chip.flat'), 'e o estado parado tem estilo próprio');
});
