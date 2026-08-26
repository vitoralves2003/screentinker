'use strict';

/*
 * A CONTROL THAT IS READ MUST BE A CONTROL THAT CAN BE SET.
 *
 * THE INCIDENT THIS IS THE RECORD OF. A beta build was published to the server, the operator was
 * told to tick "aceitar versões de pré-lançamento" on one panel, and there was no such tick to
 * make: the whole OTA block carried a bare `hidden` attribute, with nothing anywhere able to
 * remove it. The panel therefore stayed on `ota_beta = 0`, the server correctly answered
 * "up-to-date" to every check, and "Forçar atualização" appeared to do nothing at all.
 *
 * Two symptoms, one cause, and neither of them pointed at the markup. From the outside it read as
 * a broken update system — the button was pressed repeatedly, and the button was fine.
 *
 * This is the SECOND time the same shape has bitten this file. The live-debug block sat unreachable
 * for long enough that an entire investigation into a stuck widget ran without it, because the
 * instruction "turn on live debug" pointed at a control that was not on the page. That one was
 * fixed by a role gate; the comment explaining it sat eleven lines above the OTA block that still
 * had the bug.
 *
 * WHY THIS IS NARROW ON PURPOSE. "Nothing read on save may be hidden" is not the invariant — this
 * page deliberately parks notes, default content and the reboot schedule behind `hidden` while
 * keeping their values intact through a save, which is a legitimate way to shelve a feature without
 * dropping data. The real invariant is per-control and needs a human to state it: THIS control is
 * one somebody is meant to reach. So each entry below is a claim about a specific control, with the
 * reason it must stay reachable, rather than a rule inferred from the shape of the file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js');

/*
 * HTML comments come out first. They discuss markup — including, in this very file, the block that
 * had this bug — and a test that reads its own documentation as code is a test that has been
 * written and re-written here three times already.
 */
const src = fs.readFileSync(view, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/*
 * EVERY ancestor of a control, outermost first.
 *
 * Walking backwards to the nearest `<div` is wrong and was the first version of this: the nearest
 * one going back from the beta checkbox is a SIBLING's hint div, not the element that encloses it.
 * A bare `hidden` anywhere up the chain hides the control, so the chain is what has to be read —
 * which means actually tracking depth, pushing on `<div` and popping on `</div>`.
 */
function ancestorsOf(id) {
  const at = src.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `o controle #${id} sumiu da página`);

  const stack = [];
  const tag = /<div\b[^>]*>|<\/div>/g;
  let m;
  while ((m = tag.exec(src)) && m.index < at) {
    if (m[0] === '</div>') stack.pop();
    else stack.push(m[0]);
  }
  assert.ok(stack.length, `#${id} não está dentro de nenhum <div>`);
  return stack;
}

/*
 * Controls that MUST be reachable, and by whom. Staff-only ones are expected to carry the role
 * gate; a bare `hidden` fails either way, which is the whole point.
 */
const mustReach = [
  {
    id: 'otaBetaToggle',
    who: 'staff',
    why: 'a única forma de colocar um painel no canal beta — sem ela, uma build publicada não chega em tela nenhuma',
  },
  {
    id: 'otaToggle',
    who: 'staff',
    why: 'desligar OTA é o que impede um painel gerenciado por MDM de mostrar a caixa de instalação',
  },
  {
    id: 'debugLogToggle',
    who: 'staff',
    why: 'é como se descobre por que uma tela não desenha o que recebeu, sem ir até ela',
  },
];

for (const c of mustReach) {
  test(`#${c.id} pode ser alcançado — ${c.why}`, () => {
    const chain = ancestorsOf(c.id);

    const blindfold = chain.find((tag) => /<div\s+hidden[\s>]/.test(tag));
    assert.ok(
      !blindfold,
      `#${c.id} está dentro de um <div hidden> fixo (${blindfold}): ${c.why}. ` +
      'Nada em lugar nenhum remove esse atributo, então o controle existe e não pode ser usado.',
    );

    if (c.who === 'staff') {
      assert.ok(
        chain.some((tag) => /isPlatformAdmin\(currentUser\)/.test(tag)),
        `#${c.id} tem de ser mostrado só para o operador: escolher canal de atualização não é ` +
        'decisão de lojista, e um tenant que marcasse pré-lançamento colocaria a própria vitrine ' +
        'numa build sem teste sem ter como saber disso.',
      );
    }
  });
}

test('a página sabe distinguir operador de cliente', () => {
  /*
   * O gate acima não vale nada se a função que ele chama não estiver importada: um
   * `isPlatformAdmin` indefinido lança dentro do template e leva a página inteira junto — que é
   * como o painel ficou em branco da última vez.
   */
  assert.match(src, /import\s*{[^}]*\bisPlatformAdmin\b[^}]*}\s*from\s*'\.\.\/utils\.js'/,
    'isPlatformAdmin precisa vir de utils.js — sem o import o template quebra a página inteira');
});
