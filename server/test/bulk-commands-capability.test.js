'use strict';

/*
 * The multi-select command menu offers only what the selected screens can actually do.
 *
 * Reported from the dashboard: "ao selecionar mais de uma tela aparecem algumas opções, preciso
 * saber se esses comandos podem ser executados hoje". Three of the six could not.
 *
 *   Ligar tela            wake lock                                    works
 *   Reiniciar app         startActivity                                works
 *   Verificar atualização forced OTA check                             works
 *   Desligar tela         device-admin FORCE_LOCK, else accessibility  NOTHING on this fleet
 *   Reiniciar             device owner, else accessibility dialog      NOTHING on this fleet
 *   Desligar              same                                         NOTHING on this fleet
 *
 * Every screen in this deployment is tier 0 with the accessibility service off, so the panel
 * logged `unsupported on this panel` while the dashboard said "command sent". A button that lies
 * is worse than a button that is missing: the operator concludes the SCREEN is broken rather than
 * the feature absent, and goes looking at the hardware.
 *
 * The per-screen buttons on the device page have gated on capabilities since they were written.
 * All this does is make the multi-select agree with them, which is why the fix is a filter and
 * not a new mechanism.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const dash = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'dashboard.js'), 'utf8');
const caps = require('../lib/player-capabilities');

test('every bulk command declares the capability it needs', () => {
  const block = dash.slice(dash.indexOf('const GROUP_COMMANDS = ['), dash.indexOf('];', dash.indexOf('const GROUP_COMMANDS = [')));
  for (const type of ['screen_on', 'screen_off', 'launch', 'update', 'reboot', 'shutdown']) {
    assert.match(block, new RegExp(`type: '${type}', cap: '`),
      `${type} must name a capability, or it goes back to being offered unconditionally`);
  }
});

test('those capabilities are the ones the SERVER enforces, not a second opinion', () => {
  /*
   * The dashboard mirrors COMMAND_CAPABILITY because it cannot require server code. A mirror that
   * drifts is worse than no mirror: the menu would offer a command the server then refuses, which
   * is the exact failure being fixed, only louder. This compares the two.
   */
  // Asserted, not skipped-if-absent: an "if (!map) return" here would make the whole test vacuous
  // the day someone stops exporting it, which is precisely when the mirror needs checking.
  const map = caps.COMMAND_CAPABILITY;
  assert.ok(map, 'player-capabilities must export COMMAND_CAPABILITY for this comparison to mean anything');
  for (const [type, expected] of Object.entries({
    screen_on: 'display.power', screen_off: 'display.power',
    launch: 'system.restart_player', update: 'system.self_update',
    reboot: 'system.reboot', shutdown: 'system.reboot',
  })) {
    const actual = Array.isArray(map[type]) ? map[type][0] : map[type];
    assert.equal(actual, expected,
      `${type} maps to ${actual} on the server but the dashboard offers it as ${expected}`);
    assert.match(dash, new RegExp(`type: '${type}', cap: '${expected.replace('.', '\\.')}'`));
  }
});

test('a selection that can honour nothing renders no menu at all', () => {
  assert.match(dash, /if \(!cmds\.length\) return '';/,
    'an empty dropdown is a puzzle; the control should be absent, like the wall button');
});

test('one capable screen in a mixed selection is enough to offer the command', () => {
  /*
   * Any-not-all, deliberately. Ten panels where one is a device owner should still offer reboot:
   * it does something real, and sendCommand is already inert on a panel that cannot take it.
   * Requiring ALL would hide working commands behind the least capable screen in the list.
   */
  assert.match(dash, /union\.has\(c\.cap\)/, 'the filter must test the UNION of the selection');
  assert.match(dash, /chosen\.flatMap\(\(d\) => d\.capabilities\)/);
});

test('a device that declares nothing still gets every command', () => {
  /*
   * An older server sends no capabilities array. device-detail.js treats that as "show
   * everything" for the same reason — withholding controls from a fleet that simply predates the
   * field is a far worse regression than offering one that no-ops.
   */
  assert.match(dash, /if \(chosen\.some\(\(d\) => !Array\.isArray\(d\.capabilities\)\)\) return GROUP_COMMANDS;/);
});

test('a GROUP menu is filtered by the same rule as a selection', () => {
  /*
   * These two menus offer the same commands and disagreed about them: the capability filter was
   * applied to the multi-select and not to the group toolbar, so ticking screens showed three
   * options while opening a group showed six — with the three that cannot work painted red, which
   * reads as powerful rather than absent.
   *
   * One function now, called from both. commandsForSelection resolves ids against the cached list
   * and hands off; a group already holds its members.
   */
  assert.match(dash, /function commandsForDevices\(chosen\)/,
    'the rule must live in one place');
  assert.match(dash, /commandsForDevices\(lastDevices\.filter/,
    'the multi-select goes through it');
  assert.match(dash, /const cmds = commandsForDevices\(devices\)/,
    'and so does the group toolbar');
  assert.doesNotMatch(dash, /\$\{GROUP_COMMANDS\.map/,
    'nothing may render the unfiltered list straight into a menu');
});

test('the device list ships capabilities, or the filter has nothing to read', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'devices.js'), 'utf8');
  assert.match(routes, /capabilities: playerCapabilities\.capabilitiesFor\(d\)/,
    'the LIST endpoint must resolve capabilities per device, not just the detail endpoint');
});
