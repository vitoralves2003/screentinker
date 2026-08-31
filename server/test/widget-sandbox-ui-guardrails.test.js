'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The toggle and its typed-phrase modal live on the Administration page: turning widget isolation
// off is a decision for whoever runs the installation, not a customer setting. The keys are still
// named settings.wsi.* because renaming shipped translation keys buys nothing.
const ADMIN = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'admin.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'settings.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'app.js'), 'utf8');
// The warning copy moved out of the views and into the locale files when the UI was translated.
// The BEHAVIOUR is still asserted against the source; only the wording is looked up here, so
// this test still fails if someone deletes the warning rather than merely rewording it.
// As frases moram nas telas desde que o dicionario saiu. Com um idioma so, conferir
// "existe em inglês E em português" deixou de significar algo -- o que importa é que a frase
// esteja LÁ, e que ela ainda diga o que precisa dizer.

test('admin modal requires the exact confirmation phrase before disable submit enables', () => {
  /*
   * Antes eram seis asserções: as três frases existirem, e as mesmas três existirem também no
   * outro idioma -- porque um aviso de segurança meio traduzido é como um deles vira string
   * vazia. Com um idioma só, as três de baixo passaram a repetir as três de cima.
   *
   * A frase que o administrador precisa DIGITAR é a trava: se ela mudar, a trava afrouxa.
   */
  assert.match(ADMIN, /Desativar o isolamento do sandbox de widgets/);
  assert.match(ADMIN, /Digite a frase abaixo para confirmar/);
  assert.match(ADMIN, /Entendo que estou abrindo uma falha de segurança/);

  // The load-bearing assertion, unchanged: the button stays disabled until the typed text
  // matches the phrase exactly (trimmed only — no case-folding, no partial match).
  assert.match(
    ADMIN,
    /submit\.disabled\s*=\s*input\.value\.trim\(\)\s*!==\s*confirmationPhrase/,
    'confirm button must stay disabled until exact phrase match (trimmed only)'
  );

  // And the customer's own Settings page must not carry a second copy of the switch: two places
  // to disable the same protection is how one of them quietly loses the confirmation step.
  assert.doesNotMatch(SETTINGS, /widgetSandboxIsolationToggle/);
});

test('dashboard warning banner renders when org isolation is disabled and links to administration', () => {
  assert.match(APP, /widgetSandboxWarningBanner/);
  assert.match(APP, /isolamento do sandbox de widgets está DESATIVADO/);
  assert.match(APP, /link\.href = '#\/admin'/);
  // O aviso tem de NOMEAR o risco e dizer onde se desfaz — e nomear a página onde a chave
  // realmente está. Antes isto conferia "nos dois idiomas"; com um idioma só, o que resta é a
  // frase, que é o que a pessoa lê de qualquer forma.
  assert.match(APP, /está DESATIVADO[\s\S]{0,220}Administração > Segurança/,
    'o aviso tem de dizer o estado E onde revertê-lo');
});
