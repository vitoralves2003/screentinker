'use strict';

/*
 * IMPORTING DATA IS AN ACT OF THE INSTALLATION'S ADMINISTRATOR.
 *
 * THE HOLE THIS CLOSES. POST /api/status/import bulk-inserts devices, content and playlists
 * straight into the caller's workspace, and it checked nothing but that the token parsed. Not the
 * role, not the device quota, not the storage quota — checkDeviceLimit and checkStorageLimit guard
 * the pairing and upload paths, and never this one.
 *
 * So a tenant on Free (1 screen, 150 MB) could POST a file here and come out with twenty screens
 * and unlimited content, inside the operator's own installation, on a free account. The button
 * lives in Administration, which only the operator can open — but a hidden button is not a lock,
 * and the address answered to any session.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'status.js'), 'utf8');

/*
 * The gate's own body, brace-matched — not a fixed window after its name.
 *
 * The window version broke the moment the function grew a comment explaining why it answers 404,
 * which is the third time in this suite a test has been broken by its own documentation. A test
 * that fails when somebody writes a comment teaches people not to write comments.
 */
function gateBody() {
  const at = ROUTE.indexOf('function requireImportAuthority(');
  assert.ok(at >= 0, 'status.js must define requireImportAuthority');
  let depth = 0;
  for (let i = ROUTE.indexOf('{', at); i < ROUTE.length; i++) {
    if (ROUTE[i] === '{') depth += 1;
    else if (ROUTE[i] === '}' && (depth -= 1) === 0) return ROUTE.slice(at, i + 1);
  }
  throw new Error('unbalanced requireImportAuthority');
}

test('the import route is gated, and the gate is a real role check', () => {
  assert.match(ROUTE, /router\.post\('\/import',\s*requireImportAuthority/,
    'a rota tem de passar pelo portão antes de qualquer outra coisa');
  assert.match(gateBody(), /isPlatformRole\(session\.user\.role\)/,
    'o portão tem de checar o PAPEL, não só se o token abre');
  assert.match(ROUTE, /isPlatformRole[\s\S]{0,120}require\('\.\.\/middleware\/auth'\)/,
    'e tem de importar o predicado de verdade');
});

test('the gate runs BEFORE multer accepts the upload', () => {
  /*
   * Not a stylistic preference. multer writes the request body to a temp file as it arrives, with
   * a 2 GB ceiling — so a check that lives inside the handler has already cost the server the disk
   * by the time it says no.
   */
  const call = /router\.post\('\/import',([^)]*)\)/.exec(ROUTE);
  assert.ok(call, 'a rota de import tem de existir');
  const gateAt = call[1].indexOf('requireImportAuthority');
  const multerAt = call[1].indexOf('importUpload');
  assert.ok(gateAt >= 0 && multerAt >= 0, 'ambos têm de estar na cadeia');
  assert.ok(gateAt < multerAt,
    'o portão vem ANTES do multer, ou 2 GB entram em disco antes da recusa');
});

test('a break-glass identity does not import', () => {
  /*
   * 404, not 403: it is what the handler already answered, and it keeps a recovery identity
   * indistinguishable from a token for a user who no longer exists. Recovery exists to restore
   * access, not to move a customer's data around.
   */
  assert.match(gateBody(), /session\.viaRecovery[\s\S]{0,140}404/);
});

test('the gate answers authentication exactly as the handler always did', () => {
  /*
   * THE REGRESSION THIS PINS, which I caused and a pre-existing test caught.
   *
   * The first version of this gate flattened every resolveSessionUser failure to "Invalid token".
   * That swallowed `mfa_required` — somebody halfway through their second factor stopped being
   * told to finish it and started being told their token was bad — and it turned the recovery
   * identity's 404 into a 403.
   *
   * Adding a permission check must not rewrite the authentication contract underneath it. A gate
   * is additive, or it is a rewrite wearing a gate's name.
   */
  const body = gateBody();
  assert.match(body, /denySession\(res, err\)/, 'erros de sessão seguem pelo tratador original');
  assert.match(body, /user_not_found[\s\S]{0,80}404/, 'usuário inexistente segue 404');
  assert.doesNotMatch(body, /'Invalid token'/, 'nada de achatar tudo numa mensagem só');
});

test('the tenant no longer has a one-click export of everything', () => {
  /*
   * A DELIBERATE REVERSAL, recorded because the code used to argue the opposite: "taking your own
   * data out is the difference between a subscription and a hostage situation".
   *
   * The operator's decision, made with the reason stated: the package is one file that recreates a
   * whole tenant somewhere else. It is not a lock — the media stays visible and savable one file
   * at a time from the library, because the customer uploaded it — but it stops being one click,
   * and the operator decides when a leaving customer gets the bundle.
   */
  const settings = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'settings.js'), 'utf8');
  assert.doesNotMatch(settings, /exportDataBtn/);
  assert.doesNotMatch(settings, /status\/export/);
});
