'use strict';

/*
 * THE SERRATED IMAGES, pinned as arithmetic.
 *
 * A Fire TV was installed and everything on it looked jagged. The cause was not the Fire TV: it
 * was ImageLoader.calcSampleSize, and it had been costing every panel in the fleet resolution for
 * as long as it existed.
 *
 * inSampleSize only moves in halves, and the old loop doubled until the decoded image fitted
 * INSIDE the target — so it always landed on the low side. One pixel over the line cost half the
 * picture: a 1921x1081 photo on a 1920x1080 screen decoded to 960x540 and was then stretched back
 * up. A 4000x2250 photo came out at 1000x562. The stretch is what serrates.
 *
 * ── WHY THIS TEST IS IN JAVASCRIPT ───────────────────────────────────────────────────────────
 * There is no Android test runner in this repo, and the arithmetic is the whole bug — the Kotlin
 * around it is four lines of BitmapFactory. So the maths is reimplemented here and CHECKED AGAINST
 * THE KOTLIN SOURCE below, which is the part that keeps the two from drifting: if somebody edits
 * the loop in ImageLoader.kt, the source check fails even though the arithmetic here still passes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KT = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main',
  'java', 'com', 'remotedisplay', 'player', 'util', 'ImageLoader.kt');

/* The two steps, as the Kotlin does them. */
function sampleSize(srcW, srcH, maxW, maxH) {
  if (maxW <= 0 || maxH <= 0) return 1;
  let s = 1;
  while (Math.floor(srcW / (s * 2)) >= maxW && Math.floor(srcH / (s * 2)) >= maxH) s *= 2;
  return s;
}

function finalSize(srcW, srcH, maxW, maxH) {
  const s = sampleSize(srcW, srcH, maxW, maxH);
  const w = Math.floor(srcW / s);
  const h = Math.floor(srcH / s);
  if (w <= maxW && h <= maxH) return [w, h];          // scaleToFit returns it untouched
  const r = Math.min(maxW / w, maxH / h);
  return [Math.round(w * r), Math.round(h * r)];
}

/* Screens this fleet actually runs on: a 1080p panel, and a TV stick whose UI surface is 720p. */
const SCREENS = [[1920, 1080], [1280, 720]];

/* Sources that used to fall off the cliff, plus the boundary that made it happen. */
const SOURCES = [[1920, 1080], [1921, 1081], [2000, 1125], [2560, 1440], [3840, 2160], [4000, 2250]];

test('NENHUMA imagem grande é entregue abaixo da resolução da tela', () => {
  /*
   * A regra inteira, e o teste que a versão antiga reprovava em quase toda linha. 1921x1081 dava
   * 960x540 numa tela 1080p — 50%. O limite é 99%: a razão de aspecto pode custar um pixel, nunca
   * metade da imagem.
   */
  const bad = [];
  for (const [mw, mh] of SCREENS) {
    for (const [sw, sh] of SOURCES) {
      const [w, h] = finalSize(sw, sh, mw, mh);
      const fill = Math.max(w / mw, h / mh);
      if (fill < 0.99) bad.push(`${sw}x${sh} em ${mw}x${mh} -> ${w}x${h} (${Math.round(fill * 100)}%)`);
    }
  }
  assert.deepEqual(bad, [], `estas chegam à tela abaixo da resolução dela:\n  ${bad.join('\n  ')}`);
});

test('UM PIXEL a mais na origem não pode custar metade da imagem', () => {
  /*
   * O caso exato relatado. 1920x1080 e 1921x1081 são a mesma foto para qualquer olho humano, e a
   * conta antiga tratava uma como perfeita e a outra como metade.
   */
  const exact = finalSize(1920, 1080, 1920, 1080);
  const oneOver = finalSize(1921, 1081, 1920, 1080);

  assert.deepEqual(exact, [1920, 1080]);
  assert.ok(oneOver[0] >= 1919, `um pixel a mais derrubou para ${oneOver[0]}x${oneOver[1]}`);
});

test('uma imagem menor que a tela é deixada em paz', () => {
  /*
   * Ampliar inventaria detalhe e custaria memória, e o ImageView estica igual de graça. O que NÃO
   * pode acontecer é a conta reduzir uma imagem que já era pequena.
   */
  assert.deepEqual(finalSize(800, 600, 1920, 1080), [800, 600]);
  assert.deepEqual(finalSize(1280, 720, 1920, 1080), [1280, 720]);
});

test('a proporção é preservada', () => {
  for (const [mw, mh] of SCREENS) {
    for (const [sw, sh] of SOURCES) {
      const [w, h] = finalSize(sw, sh, mw, mh);
      assert.ok(Math.abs((w / h) - (sw / sh)) < 0.01, `${sw}x${sh} -> ${w}x${h} distorceu`);
      assert.ok(w <= mw && h <= mh, `${sw}x${sh} -> ${w}x${h} estourou o alvo ${mw}x${mh}`);
    }
  }
});

test('e o Kotlin continua fazendo a mesma coisa que esta conta', () => {
  /*
   * O elo que impede a deriva. Este arquivo é uma reimplementação, e uma reimplementação que
   * ninguém amarra ao original vira documentação de algo que mudou — que é precisamente a classe
   * de bug que este teste existe para prender.
   *
   * Comentários são removidos antes: eles descrevem a versão ANTIGA da conta, de propósito, e um
   * teste que lê a própria documentação como código já se enganou três vezes neste repositório.
   */
  const src = fs.readFileSync(KT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(src, /while\s*\(srcW\s*\/\s*\(sample\s*\*\s*2\)\s*>=\s*maxW\s*&&\s*srcH\s*\/\s*\(sample\s*\*\s*2\)\s*>=\s*maxH\)\s*sample\s*\*=\s*2/,
    'a amostragem parou de escolher a maior potência que ainda fica ACIMA do alvo');

  assert.match(src, /Bitmap\.createScaledBitmap\(src,\s*w,\s*h,\s*true\)/,
    'a reamostragem filtrada sumiu — sem ela a decimação deixa degraus e o ImageView estica');

  assert.ok(!/while\s*\(srcW\s*\/\s*sample\s*>\s*maxW/.test(src),
    'a conta antiga voltou: ela pousa sempre ABAIXO do alvo');
});
