'use strict';

/*
 * The code on a report, and the page it resolves to.
 *
 * A proof-of-play PDF is handed to the customer who paid for the slot, and its whole job is to be
 * believed. The competitor stamps theirs with a code AND "Informações válidas até" two minutes
 * after generation, which empties the idea — a receipt that expires while you are reading it
 * proves nothing, and re-generating it produces a different code for the same facts.
 *
 * So the code here records WHAT WAS CLAIMED, permanently, and the page shows exactly that. It is
 * not a live query: re-running the report next month would return different numbers, because the
 * log is pruned at 90 days and because a screen may have been reassigned since. Checking a receipt
 * against a number that has moved is not checking anything.
 *
 * WHAT THIS IS NOT. It is not a cryptographic guarantee. The rows are written by this server and
 * this server could write anything; a signature would only prove the same server signed it. What
 * it does give a customer is the thing they actually lack today: a way to confirm that a PDF in
 * their inbox came from this system, names their content, and says the same numbers it said when
 * it was made.
 */

const crypto = require('node:crypto');
const { db } = require('../db/database');

/*
 * Three groups of three, from an alphabet with no O/0 or I/1.
 *
 * Read aloud over the phone and typed back in by somebody who did not generate it — which is the
 * only way this code is ever used — so the pairs that get misheard are simply absent rather than
 * corrected afterwards.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const bytes = crypto.randomBytes(9);
  let out = '';
  for (let i = 0; i < 9; i++) {
    if (i && i % 3 === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/*
 * Record a report exactly as it was handed over.
 *
 * `summary` is the small set of figures the PDF prints, not the whole payload: the verification
 * page has to answer "does this match my copy", and storing a snapshot of every row would make
 * the table grow with the log it is meant to outlive.
 */
function recordExport({ workspaceId, userId, type, subjectId, subjectName, window, summary }) {
  // A collision would overwrite somebody else's receipt, so the insert refuses rather than
  // replaces, and a fresh code is drawn. Three attempts is already far past astronomical for a
  // 32^9 space; the throw is there so a failure is loud rather than silent.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    try {
      db.prepare(`
        INSERT INTO report_exports (code, workspace_id, user_id, type, subject_id, subject_name,
                                    period_start, period_end, summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
      `).run(code, workspaceId, userId || null, type, subjectId, subjectName || '',
        window.start, window.end, JSON.stringify(summary || {}));
      return code;
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(e.message)) throw e;
    }
  }
  throw new Error('could not allocate a report code');
}

/*
 * Look a code up.
 *
 * Deliberately NOT scoped to a workspace: the person checking is the advertiser holding the PDF,
 * who has no login here. The code is the credential, which is why it is 32^9 and why nothing
 * about it is guessable from the report's contents.
 *
 * What comes back is only what the report already told them. Nothing here reveals anything a
 * holder of the PDF does not already have in their hand.
 */
function lookup(code) {
  const row = db.prepare(`
    SELECT r.code, r.type, r.subject_name, r.period_start, r.period_end, r.summary_json, r.created_at,
           w.name AS workspace_name
    FROM report_exports r
    LEFT JOIN workspaces w ON w.id = r.workspace_id
    WHERE r.code = ?
  `).get(String(code || '').toUpperCase().trim());

  if (!row) return null;
  let summary = {};
  try { summary = JSON.parse(row.summary_json || '{}'); } catch { /* a corrupt row still verifies its existence */ }

  return {
    code: row.code,
    type: row.type,
    subject: row.subject_name,
    tenant: row.workspace_name,
    period: { start: row.period_start, end: row.period_end },
    generated_at: row.created_at,
    summary,
  };
}

module.exports = { newCode, recordExport, lookup, ALPHABET };
