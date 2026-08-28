'use strict';

/*
 * 608x1080 — the number this file exists to make impossible.
 *
 * The compression box was a flat, landscape 1920x1080 applied to everything. A portrait video of
 * 1080x1920 has its height clamped at 1080, and fitting inside that box drags the width down with
 * it: 1080 becomes 608. Twelve of a customer's seventeen videos were stored that way — 56% of the
 * width they arrived with — and then stretched back up to 1080 on the portrait screens they were
 * made for. It looked exactly like what it was.
 *
 * The originals were overwritten, so those twelve are gone; they have to be uploaded again.
 *
 * Vertical is not an edge case in this product. Portrait screens are the ordinary shape in
 * Brazilian retail signage, so the default box was wrong for most of what the fleet carries — and
 * it was wrong quietly, in a way that only shows up as "the picture looks bad".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boxFor, fitsInBox, planFor } = require('../lib/media-box');

const CFG = { maxWidth: 1920, maxHeight: 1080, videoBitrateKbps: 10000, bitrateCeilingFactor: 2 };

test('UM VÍDEO EM PÉ DE 1080x1920 SAI 1080x1920', () => {
  /*
   * O caso exato. Antes: 608x1080. Um teste que só verificasse "não aumentou" passaria com o bug
   * inteiro presente, então o que se afirma aqui é o número.
   */
  const box = boxFor(1080, 1920, 1920, 1080);
  assert.deepEqual(box, { w: 1080, h: 1920 }, 'a caixa tem de virar de pé junto com o vídeo');
  assert.equal(fitsInBox(1080, 1920, 1920, 1080), true, 'e ele já cabe nela');

  const plan = planFor({ width: 1080, height: 1920, sizeBytes: 20e6, durationSec: 30 }, CFG);
  assert.equal(plan.action, 'skip', 'não há nada a ganhar reencodando o que já está certo');
});

test('608x1080 não pode ser produzido a partir de nada', () => {
  /*
   * A guarda em forma de resultado, e não de intenção. Qualquer origem em pé, em qualquer
   * tamanho, tem de manter a proporção e nunca pousar naquele valor.
   */
  for (const [w, h] of [[1080, 1920], [2160, 3840], [720, 1280], [1440, 2560]]) {
    const box = boxFor(w, h, 1920, 1080);
    assert.ok(box.h > box.w, `${w}x${h} recebeu uma caixa deitada: ${box.w}x${box.h}`);
    assert.equal(box.w, 1080);
    assert.equal(box.h, 1920);
  }
});

test('deitado continua deitado, e o 4K ainda é reduzido', () => {
  assert.deepEqual(boxFor(1920, 1080, 1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(boxFor(3840, 2160, 1920, 1080), { w: 1920, h: 1080 });

  const p = planFor({ width: 3840, height: 2160, sizeBytes: 80e6, durationSec: 30 }, CFG);
  assert.equal(p.action, 'shrink', 'a caixa continua existindo — ela só parou de ser sempre deitada');
});

test('quadrado recebe o lado CURTO, não o longo', () => {
  /*
   * Dar-lhe o lado longo deixaria passar um 1920x1920 — quatro vezes os pixels de um quadro 1080p,
   * em painéis escolhidos para tocar 1080p.
   */
  assert.deepEqual(boxFor(1080, 1080, 1920, 1080), { w: 1080, h: 1080 });
  assert.equal(planFor({ width: 1920, height: 1920, sizeBytes: 20e6, durationSec: 30 }, CFG).action, 'shrink');
});

test('o que já cabe é DEIXADO EM PAZ', () => {
  /*
   * A regra pedida, e a razão dela: não há resolução a recuperar, e cada passagem por H.264 gasta
   * qualidade que não volta. Um reencode aqui só piora.
   */
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1280, 720], [640, 480]]) {
    const p = planFor({ width: w, height: h, sizeBytes: 15e6, durationSec: 30 }, CFG);
    assert.equal(p.action, 'skip', `${w}x${h} não devia ser tocado`);
  }
});

test('MAS um arquivo monstruoso ainda é reencodado — sem mexer nas dimensões', () => {
  /*
   * O contrapeso da regra acima. Um clipe 1080p a 50 Mbps é um download de centenas de megabytes
   * no wi-fi de uma loja. O teto é deliberadamente frouxo, para pegar só o caso absurdo — e quando
   * pega, o que desce é o peso, não a imagem.
   */
  const p = planFor({ width: 1920, height: 1080, sizeBytes: 250e6, durationSec: 30 }, CFG);
  assert.equal(p.action, 'requantise');
  assert.deepEqual(p.box, { w: 1920, h: 1080 }, 'as dimensões têm de sobreviver intactas');

  // E logo acima do alvo NÃO dispara: reencodar para economizar poucos por cento é gastar
  // qualidade de verdade por quase nada.
  const near = planFor({ width: 1920, height: 1080, sizeBytes: (11000 * 1000 / 8) * 30, durationSec: 30 }, CFG);
  assert.equal(near.action, 'skip', '11 Mbps contra alvo de 10 não justifica um reencode');
});

test('dimensões desconhecidas não viram suposição', () => {
  /*
   * Um arquivo que o ffprobe não leu não pode ser tratado como "já cabe" — isso seria pular
   * silenciosamente a compressão de um 4K. Sem saber, a caixa padrão vale e o encode acontece.
   */
  assert.equal(fitsInBox(null, null, 1920, 1080), false);
  assert.equal(fitsInBox(0, 0, 1920, 1080), false);
  assert.equal(planFor({ width: null, height: null, sizeBytes: 20e6, durationSec: 30 }, CFG).action, 'shrink');
});

test('a ordem de maxWidth/maxHeight na config não muda nada', () => {
  /*
   * A caixa é definida por lado longo e lado curto, então quem escrever 1080x1920 no ambiente
   * obtém o mesmo comportamento de quem escreveu 1920x1080. Uma configuração que se comportasse
   * diferente conforme a ordem seria uma armadilha esperando alguém.
   */
  assert.deepEqual(boxFor(1080, 1920, 1080, 1920), boxFor(1080, 1920, 1920, 1080));
  assert.deepEqual(boxFor(1920, 1080, 1080, 1920), boxFor(1920, 1080, 1920, 1080));
});
