'use strict';

/*
 * NENHUM MÓDULO DO NAVEGADOR CHAMA O QUE O i18n LEVOU EMBORA.
 *
 * ── O DEFEITO QUE ESTE TESTE NÃO TERIA DEIXADO DORMIR ────────────────────────────────────
 * A Etapa 4 (d4ac147) apagou `frontend/js/i18n.js` e com ele `getLanguage`, `setLanguage`, `t`,
 * `tn` e o resto. Uma chamada ficou para trás, em `components/invoice-banner.js`:
 *
 *     const locale = () => LOCALE[getLanguage()] || 'en-US';
 *
 * Ela não quebrou nada por semanas, e é exatamente por isso que foi perigosa: a faixa de fatura
 * só desenha quando há fatura EM ABERTO. O erro ficou dormindo até o dia em que alguém devia —
 * e aí derrubou a página inteira (`#app` desenhou 261 bytes), justamente para o assinante que
 * estava prestes a ser lembrado de pagar.
 *
 * ── POR QUE UM TESTE ESTÁTICO, E NÃO UM TESTE DE TELA ────────────────────────────────────
 * `provar_abrir.sh` acabou pegando este — mas só porque a conta de prova entrou num estado com
 * fatura aberta. Um caminho que só executa sob uma condição rara não é coberto por abrir a
 * página: é coberto por ninguém poder mencionar o que não existe.
 *
 * ── E POR QUE NÃO É UM VERIFICADOR DE VARIÁVEL NÃO DEFINIDA ──────────────────────────────
 * Um de verdade exigiria montar o grafo de módulos. Este é menor de propósito: a lista abaixo é
 * fechada, veio de um `git show` do commit que apagou, e cobre a classe que já mordeu.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..', '..', 'frontend', 'js');

// Extraídos de `git show d4ac147 -- frontend/js/i18n.js frontend/js/lang-prime.js`. Os nomes
// internos (lookup, registry, fallback...) ficaram de fora: eram locais do módulo e ninguém
// fora dele poderia chamá-los.
const APAGADOS = ['getLanguage', 'setLanguage', 'getAvailableLanguages', 'currentLang'];

function modulos(dir) {
  const achados = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === 'vendor' || entrada.name === 'node_modules') continue;
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...modulos(p));
    else if (entrada.name.endsWith('.js')) achados.push(p);
  }
  return achados;
}

/*
 * Comentário não é chamada. Tirar os comentários antes de procurar é o que permite EXPLICAR o
 * defeito no lugar onde ele morava sem que a explicação faça o teste falhar — foi o que
 * aconteceu na primeira versão deste conserto.
 */
function semComentarios(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('nenhum módulo do navegador chama o que o i18n levou embora', () => {
  const arquivos = modulos(RAIZ);
  assert.ok(arquivos.length > 20, 'a varredura achou os módulos: sem isto ela mede o vazio');

  const restos = [];
  for (const arquivo of arquivos) {
    const codigo = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    for (const nome of APAGADOS) {
      if (new RegExp(`\\b${nome}\\s*\\(`).test(codigo)) {
        restos.push(`${path.relative(RAIZ, arquivo)} chama ${nome}()`);
      }
    }
  }

  assert.deepEqual(restos, [],
    'uma função que não existe mais, chamada num caminho raro, é uma página em branco esperando '
    + 'a condição certa');
});

/*
 * E o caso concreto, nomeado: a faixa formata dinheiro, e formatar dinheiro foi o que chamava o
 * idioma. Se alguém devolver um mapa de idiomas aqui, é este teste que explica por quê não.
 */
test('a faixa de fatura formata em pt-BR, sem consultar idioma nenhum', () => {
  const faixa = fs.readFileSync(path.join(RAIZ, 'components', 'invoice-banner.js'), 'utf8');
  const codigo = semComentarios(faixa);

  assert.match(codigo, /NumberFormat\(\s*LOCALE_PT/,
    'o dinheiro é formatado com a constante, não com uma consulta de idioma');
  assert.doesNotMatch(codigo, /getLanguage/,
    'e nada aqui pergunta qual é o idioma — só existe um desde a Etapa 4');
});
