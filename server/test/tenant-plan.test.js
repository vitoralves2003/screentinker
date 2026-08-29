'use strict';

/*
 * "WHICH PLAN IS THIS TENANT ON" — one question, one answer.
 *
 * THE PRODUCTION DIVERGENCE THIS PINS. Three call sites resolved this independently and
 * disagreed, on a live customer:
 *
 *   GET /devices/overview   read organizations.plan_id  ->  premium    (what was DISPLAYED)
 *   middleware/subscription read workspaces.plan_id     ->  corporate  (what was UNLOCKED)
 *   lib/tenant-billing      read workspaces.plan_id     ->  corporate  (what was CHARGED)
 *
 * So the home page said "de 15,0 GB no plano Premium" while the invoice charged Corporativo at
 * R$20 per screen against a 20-screen floor — R$400 a month to a tenant running two screens. A
 * price decided by a column no screen in the product displays cannot be sold: the customer reads
 * one number and receives another.
 *
 * The rule now: THE TENANT IS THE WORKSPACE. workspaces.plan_id decides, everything reads
 * lib/tenant-plan.js, and organizations.plan_id decides nothing.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-tplan-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const tenantPlan = require('../lib/tenant-plan');
const billing = require('../lib/tenant-billing');
const { getWorkspacePlan } = require('../middleware/subscription');

let seq = 0;
function mkTenant({ wsPlan, orgPlan, userPlan }) {
  const n = ++seq;
  const u = `u-tp-${n}`, o = `o-tp-${n}`, w = `w-tp-${n}`;
  db.prepare('INSERT INTO users (id,email,password_hash,role,plan_id) VALUES (?,?,?,?,?)')
    .run(u, `tp${n}@t`, 'x', 'user', userPlan || 'free');
  db.prepare('INSERT INTO organizations (id,name,owner_user_id,plan_id) VALUES (?,?,?,?)')
    .run(o, `O${n}`, u, orgPlan || 'free');
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,plan_id) VALUES (?,?,?,?,?)')
    .run(w, o, `W${n}`, u, wsPlan);
  return w;
}

test('the organisation\'s plan decides nothing', () => {
  /*
   * The exact production shape: organisation on pro, workspace on master. Before this
   * module the answer depended on which file you asked.
   */
  const ws = mkTenant({ wsPlan: 'master', orgPlan: 'pro', userPlan: 'master' });

  assert.equal(tenantPlan.planIdFor(ws), 'master');
  assert.equal(tenantPlan.planRowFor(ws).display_name, 'Master');
});

test('every reader gives the same answer', () => {
  /*
   * THE FIREWALL. The three call sites are asserted together deliberately: a fourth resolution
   * added later will not break its own test, it will break this one.
   */
  for (const wsPlan of ['free', 'pro', 'master']) {
    const ws = mkTenant({ wsPlan, orgPlan: 'pro', userPlan: 'free' });

    const resolver = tenantPlan.planIdFor(ws);
    const billed = billing.planFor(ws).id;
    const gated = getWorkspacePlan(ws).plan_id;

    assert.equal(billed, resolver, `billing disagrees for ${wsPlan}`);
    assert.equal(gated, resolver, `permissions disagree for ${wsPlan}`);
  }
});

test('a legacy workspace with no plan still inherits its owner\'s', () => {
  /*
   * LOAD-BEARING, not defensive tidiness. Workspaces created before the tenancy migration carry
   * plan_id = NULL and have always shown their creator's plan. Resolving those to 'free' would
   * downgrade paying customers AND stop invoicing them — silent under-billing, which is the
   * failure you find months later in a bank statement.
   */
  const ws = mkTenant({ wsPlan: null, orgPlan: 'free', userPlan: 'pro' });

  assert.equal(tenantPlan.planIdFor(ws), 'pro');
  assert.equal(billing.planFor(ws).id, 'pro');
});

test('a dangling plan reference is impossible, not merely handled', () => {
  /*
   * The resolver COALESCEs past a plan_id that names no plan — but it never has to, because
   * workspaces.plan_id carries a FOREIGN KEY to plans(id) and SQLite refuses the write. Asserting
   * the constraint rather than the fallback: the guarantee lives in the schema, and a migration
   * that quietly dropped it would leave the fallback as the only thing standing between a deleted
   * plan and a tenant with no entitlements at all.
   */
  const ws = mkTenant({ wsPlan: null, orgPlan: 'free', userPlan: 'master' });
  assert.throws(
    () => db.prepare("UPDATE workspaces SET plan_id = 'a-plan-that-was-deleted' WHERE id = ?").run(ws),
    /FOREIGN KEY/i,
  );
  // And with plan_id genuinely NULL, the owner still decides.
  assert.equal(tenantPlan.planIdFor(ws), 'master');
});

test('no unknown tenant resolves to anything but free', () => {
  assert.equal(tenantPlan.planIdFor('does-not-exist'), 'free');
  assert.equal(tenantPlan.planIdFor(null), 'free');
  assert.equal(tenantPlan.planRowFor(null).id, 'free');
});

test('nothing outside the resolver reads organizations.plan_id any more', () => {
  /*
   * Grep as a test, because this is a rule about where a column may be read and no type system
   * expresses it. The signup path still WRITES it (harmless, and dropping a written column buys
   * nothing); what must never come back is a second place that decides pricing or quota from it.
   */
  const ROOT = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name === 'uploads') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      // Comments stripped first: this file and the resolver both DESCRIBE the old shape, and a
      // rule that forbids writing about its own history is a rule nobody can document.
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
        .replace(/--.*$/gm, ' ');            // SQL comments inside template literals
      // "o.plan_id" / "organizations.plan_id" in a SELECT — the shape that decided a price.
      // routes/auth.js still WRITES the column at signup, which is harmless: what must never
      // come back is a second place that DECIDES pricing or quota from it.
      if (/\b(?:o|org|organizations)\.plan_id\b/.test(src) && !/routes[\\/]auth\.js$/.test(full)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(ROOT);

  assert.deepEqual(offenders, [],
    'estes decidem plano pela organização: ' + offenders.join(', '));
});
