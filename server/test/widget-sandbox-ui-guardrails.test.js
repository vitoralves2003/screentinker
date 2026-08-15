'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'settings.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');
// The warning copy moved out of the views and into the locale files when the UI was translated.
// The BEHAVIOUR is still asserted against the source; only the wording is looked up here, so
// this test still fails if someone deletes the warning rather than merely rewording it.
const EN = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
const PT = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'pt.js'), 'utf8');

test('settings modal requires the exact confirmation phrase before disable submit enables', () => {
  // The modal is rendered from these keys...
  assert.match(SETTINGS, /settings\.wsi\.title/);
  assert.match(SETTINGS, /settings\.wsi\.type_phrase/);
  assert.match(SETTINGS, /settings\.wsi\.phrase/);
  // ...and the copy behind them still says what it must, in BOTH shipped languages. A
  // half-translated security warning is how one of these silently becomes an empty string.
  assert.match(EN, /'settings\.wsi\.title':\s*'Disable widget sandbox isolation/);
  assert.match(EN, /'settings\.wsi\.phrase':\s*'I understand I am enabling a security hole'/);
  assert.match(PT, /'settings\.wsi\.title':\s*'Desativar o isolamento/);
  assert.match(PT, /'settings\.wsi\.phrase':\s*'Entendo que estou abrindo uma falha de segurança'/);

  // The load-bearing assertion, unchanged: the button stays disabled until the typed text
  // matches the phrase exactly (trimmed only — no case-folding, no partial match).
  assert.match(
    SETTINGS,
    /submit\.disabled\s*=\s*input\.value\.trim\(\)\s*!==\s*confirmationPhrase/,
    'confirm button must stay disabled until exact phrase match (trimmed only)'
  );
});

test('dashboard warning banner renders when org isolation is disabled and links to settings', () => {
  assert.match(APP, /widgetSandboxWarningBanner/);
  assert.match(APP, /settings\.wsi\.banner/);
  assert.match(APP, /link\.href = '#\/settings'/);
  // The banner must still NAME the risk and say where to undo it — in both languages.
  assert.match(EN, /'settings\.wsi\.banner':[\s\S]*?isolation is DISABLED[\s\S]*?Settings > Security/);
  assert.match(PT, /'settings\.wsi\.banner':[\s\S]*?está DESATIVADO[\s\S]*?Configurações > Segurança/);
});
