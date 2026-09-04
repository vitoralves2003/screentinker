'use strict';

/*
 * O SKIP NÃO PODE SOBREVIVER AO MOTIVO DELE.
 *
 * Os três arquivos de TOTP (totp.test.js, totp-unit.test.js, totp-keyrotation.test.js) estão
 * pulados desde 04/09, e a razão está escrita no topo de cada um: as rotas /totp/* não existem —
 * o segundo fator foi apagado de propósito e volta na Etapa 7b. Eram 17 falhas permanentes, e ao
 * lado delas oito falhas REAIS de contraste passaram semanas sem ninguém olhar.
 *
 * Pular é a resposta certa para um teste que NÃO PODE passar. Mas um `skip` é uma dívida silenciosa:
 * no dia em que o MFA voltar, nada obriga alguém a lembrar dos três arquivos, e o produto ganharia
 * segundo fator com a cobertura dele desligada — que é exatamente quando ela importa.
 *
 * Então este teste vigia o contrário do que se costuma vigiar: ele reprova quando a
 * funcionalidade VOLTA. É a única coisa que faz o skip acabar junto com o motivo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROTAS = path.join(__dirname, '..', 'routes', 'auth.js');
const PULADOS = ['totp.test.js', 'totp-unit.test.js', 'totp-keyrotation.test.js', 'session-token-resolution.test.js'];

test('se as rotas do segundo fator voltarem, os testes dele têm de voltar junto', () => {
  const auth = fs.readFileSync(ROTAS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  /* Uma rota montada de verdade, e não uma menção num comentário. */
  const montadas = [...auth.matchAll(/router\.(get|post|put|delete)\(\s*'(\/totp[^']*)'/g)].map((m) => m[2]);

  const aindaPulados = PULADOS.filter((f) => {
      const fonte = fs.readFileSync(path.join(__dirname, f), 'utf8');
      /* O arquivo inteiro sai cedo: um teste-marcador pulado e um return no nivel do modulo. */
      return fonte.includes('esperando o segundo fator voltar na Etapa 7b');
    });

  if (montadas.length === 0) {
    /* O estado de hoje: sem rotas, os três seguem pulados — e é assim que tem de ser. */
    assert.deepEqual(aindaPulados, PULADOS,
      'as rotas /totp não existem, então os três arquivos de teste devem continuar pulados com o motivo escrito');
    return;
  }

  assert.deepEqual(aindaPulados, [],
    'O SEGUNDO FATOR VOLTOU (' + montadas.join(', ') + ') e estes testes continuam pulados:\n  '
    + aindaPulados.join('\n  ')
    + '\n\nTire o `AGUARDANDO` deles — a cobertura do MFA importa justamente agora.');
});
