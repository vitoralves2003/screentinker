'use strict';

/*
 * Every frontend module must actually parse.
 *
 * This is the cheapest test in the suite and it exists because the failure it catches is the most
 * expensive one to diagnose: a syntax error in an ES module does not degrade, it blanks the page,
 * and nothing in a server-side suite that reads the files as TEXT will notice. Two near-misses in
 * one week — a backtick inside an HTML comment that was itself inside a template literal, closing
 * the literal early; and before that a namespace import of a module with no matching export.
 *
 * Text-matching tests are the bulk of what checks the panel here, and they pass just as happily on
 * a file the browser refuses to load. This is the one that does not.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'js');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

const files = walk(ROOT);

test('the frontend has modules to check, so this test cannot pass by finding nothing', () => {
  assert.ok(files.length > 20, `expected the panel's modules, found ${files.length}`);
});

/*
 * SourceTextModule needs --experimental-vm-modules, which package.json's test script passes.
 * Without it every file below fails with the same unrelated message; one clear failure saying
 * what is actually wrong beats fifty-seven saying something that is not.
 */
const canParse = typeof vm.SourceTextModule === 'function';

test('the module parser is available', () => {
  assert.ok(canParse, 'run the suite via `npm test` — this file needs --experimental-vm-modules');
});

for (const file of files) {
  const rel = path.relative(path.join(ROOT, '..', '..'), file).replace(/\\/g, '/');
  test(`parses: ${rel}`, { skip: canParse ? false : 'needs --experimental-vm-modules' }, () => {
    const src = fs.readFileSync(file, 'utf8');
    try {
      /*
       * Compiled as a module, not merely as a script: import/export are syntax errors outside
       * module goal, and every file here uses them. Compiling does not RUN it, so no browser
       * global is touched.
       */
      new vm.SourceTextModule(src, { identifier: file });
    } catch (err) {
      assert.fail(`${rel} does not parse: ${err.message}`);
    }
  });
}
