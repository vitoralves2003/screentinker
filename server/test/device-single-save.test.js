'use strict';

/*
 * One Save for the device page.
 *
 * It had three. "Aplicar" wrote the layout, "Salvar zonas" wrote the zone map, and "Salvar
 * configurações" wrote everything else — and each reached the wall on its own. A screen could
 * therefore sit in front of customers wearing a freshly chosen two-zone layout with nothing in
 * either zone, because the operator was still halfway through deciding.
 *
 * Nothing leaves this page until the button is pressed, and then all of it does.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

test('the two extra save buttons are gone', () => {
  assert.doesNotMatch(page, /applyLayoutBtn/, 'choosing a layout is half a decision, not an action');
  assert.doesNotMatch(page, /saveZonesBtn/, 'the zone map is part of the same decision');
  assert.match(page, /saveNotesBtn/, 'and one button remains to write all of it');
});

test('the zone fields come from the layout CHOSEN, not the one saved', () => {
  /*
   * This is what let "Aplicar" disappear. Asking the DEVICE for its zones only ever answers for
   * the layout it already has, so the fields could not appear until something had been written —
   * which is exactly the premature write being removed. Asking the LAYOUT answers for whatever was
   * just picked in the select, with nothing persisted.
   */
  assert.match(page, /api\.getLayout\(layoutId\)/,
    'a newly picked layout must be read by id, not inferred from the device');
  assert.match(page, /renderZoneFields\(e\.target\.value \|\| null\)/,
    'and changing the select must redraw the fields immediately');
});

test('switching layout and back does not silently empty the fields', () => {
  /*
   * Zone ids survive a layout change when the same layout comes back, so a list already mapped to
   * a zone is carried across rather than reset. Without this, an operator comparing two layouts
   * loses their work by looking.
   */
  assert.match(page, /const previous = new Map\(\(saved\.zones \|\| \[\]\)\.map/);
  assert.match(page, /playlist_id: previous\.get\(z\.id\) \|\| null/);
});

test('THE ORDER: layout is written before the zones that depend on it', () => {
  /*
   * The zones route validates every zone id against the device's CURRENT layout_id. Writing the
   * zone map first would have every zone of a freshly chosen layout rejected as unknown — and the
   * failure would look like the zone map being broken rather than the sequence being wrong.
   */
  const save = page.slice(page.indexOf("document.getElementById('saveNotesBtn')"));
  const layoutAt = save.indexOf('layout_id: layoutSel.value');
  const zonesAt = save.indexOf('api.setDeviceZones');
  assert.ok(layoutAt >= 0 && zonesAt >= 0, 'the save must write both');
  assert.ok(layoutAt < zonesAt, 'layout first, always');
});

test('deferring the write comes with a way to notice you have not saved', () => {
  /*
   * Deferring fixes one way of being surprised and creates another: configure, walk away, and
   * nothing happened. Swapping "applies instantly" for "waits for Save" without this is just
   * trading one silent failure for a quieter one.
   */
  assert.match(page, /let deviceFormDirty = false;/);
  assert.match(page, /unsavedHint/, 'a label beside the button');
  assert.match(page, /addEventListener\('beforeunload'/, 'and a prompt on leaving the page');
  assert.match(page, /clearDirty\(\);/, 'cleared once the save succeeds — and only then');
});

test('Substituir tela uses the pairing modal, not a browser prompt', () => {
  /*
   * It was prompt(): an unstyled box with no validation, for an operation that moves a screen's
   * identity, content and licence onto different hardware. It is the same six-digit field as Add
   * Display and now looks like it.
   */
  assert.doesNotMatch(page, /prompt\(t\('device\.replace\.prompt'/, 'the browser prompt is gone');
  assert.match(page, /replaceDeviceModal/);
  const idx = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  assert.match(idx, /id="replaceCodeInput"[^>]*class="pairing-input"/,
    'same six-digit input class as pairing, so nobody learns a second way to type a code');
  assert.doesNotMatch(idx.slice(idx.indexOf('id="replaceDeviceModal"'), idx.indexOf('id="addDeviceModal"')),
    /deviceNameInput|display_name/,
    'and NO name field: the screen already has a name, and keeping it is the whole point');
});

test('e o botão diz o que faz: "Salvar", não "Salvar configurações"', () => {
  /*
   * O rótulo dizia "configurações" e o botão escreve a página INTEIRA — layout, zonas,
   * orientação, notas. Ele vive fora das duas abas, numa barra própria, e ficava logo abaixo da
   * lista de conteúdo da aba Conteúdos: prometia menos do que faz, e prometia a coisa errada.
   *
   * O Vitor: "o botão salvar configurações refere-se a configurações, então devemos trocar este
   * botão por apenas salvar (...) serve para as duas abas".
   *
   * O que ele NÃO salva são os itens da lista, e isso é de propósito: pôr e tirar conteúdo grava
   * na hora, porque a tela é dona do próprio espaço e não tem passo de publicar.
   */
  assert.match(page, />Salvar</, 'o botão diz Salvar');
  assert.doesNotMatch(page, /Salvar configurações/,
    'e o rótulo antigo não voltou — nem no botão, nem num comentário que aponte para ele');
});

test('"Substituir tela" aparece numa tela reivindicada — e a pergunta é o WORKSPACE', () => {
  /*
   * O recurso estava pronto e ninguém o alcançava. A rota e o botão perguntavam por `user_id`,
   * que respondia "esta tela foi reivindicada?" quando uma tela pertencia a uma PESSOA. A posse
   * migrou para o workspace, e a coluna virou uma que o pareamento ainda preenche mas que já não
   * decide nada.
   *
   * Medido antes de mexer: os quatro aparelhos reais têm user_id NULO — vieram por importação ou
   * restauração, não pelo pareamento normal. Para eles o botão nunca aparecia e a rota recusaria,
   * sem nada explicando por quê. E não é caso de canto: toda tela que chega por migração cai
   * nisso.
   *
   * O conserto foi trocar a PERGUNTA, e não preencher a coluna — remendar o dado para caber numa
   * pergunta velha deixaria a próxima tela importada no mesmo buraco.
   */
  assert.match(page, /device\.workspace_id \? .*replaceDeviceBtn/,
    'o botão é oferecido a quem tem workspace');
  assert.doesNotMatch(page, /device\.user_id \? .*replaceDeviceBtn/,
    'e não a quem tem user_id, que é a coluna que deixou de responder isso');

  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');
  const replace = rota.slice(rota.indexOf("router.post('/:id/replace'"), rota.indexOf("router.delete('/:id'"));
  assert.ok(replace.length > 200, 'a âncora existe: sem isto a fatia mede o vazio');
  assert.match(replace, /if \(!target\.workspace_id\)/, 'a rota pergunta o mesmo que o botão');
  assert.doesNotMatch(replace, /if \(!target\.user_id\)/,
    'as duas pontas têm de concordar: uma trava só no botão não é trava');
});
