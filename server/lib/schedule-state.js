'use strict';

/*
 * Is this file on air, waiting, or done? — the little clock in the library list.
 *
 * Three states, and the distinction that matters is between the two that look like "not playing":
 *
 *   active    on air right now
 *   pending   scheduled, not on air at this moment, and it WILL be again
 *   expired   there is no future moment at which it can play
 *   null      no schedule and no expiry, so it always plays and the list shows no clock
 *
 * "Pending" covers the ordinary between-occurrences case as well as the not-yet-started one: a
 * Mondays-only file is pending on a Tuesday. Both mean the same thing to whoever is scanning the
 * list — it is set up and it is not on screen now — so splitting them would add a colour that
 * answers no question.
 *
 * EXPIRY IS PART OF THIS. A file whose validade has passed cannot play regardless of its rules,
 * and showing it as merely pending would be a lie of exactly the kind this badge exists to
 * prevent.
 *
 * COMPUTED ON THE SERVER, deliberately. The panel could evaluate the rules itself, but then two
 * implementations would decide what "on air" means and they would drift; this one calls the same
 * compiler and the same evaluator the fleet runs.
 */

const { compileRules, blockCanMatch } = require('./schedule-compile');
const { isItemActiveNow } = require('./schedule-eval');

/*
 * The clock is read against ONE timezone, and it has to be a defensible one because a file can be
 * on air in Manaus and not in Recife. The operator's own zone is the honest answer for a list they
 * are looking at: it is the clock on their wall, and it is what they mean by "now". The device
 * still decides for itself — this badge reports, it does not control.
 */
function deriveScheduleState({ rules, expiresAt, now = Date.now(), tz = null }) {
  const hasRules = Array.isArray(rules) && rules.length > 0;
  if (!hasRules && !expiresAt) return null;

  // Expiry first: it overrides everything, including a rule that says "now".
  if (expiresAt && expiresAt * 1000 <= now) return 'expired';
  if (!hasRules) return 'pending_expiry';

  const today = ymd(now);
  const blocks = compileRules(rules, today);

  /*
   * Zero blocks from a non-empty rule set cannot happen — the compiler emits a never-matching
   * block for an impossible rule instead — but if it ever did, the evaluator would read it as
   * "always on" and the badge would say the opposite of the truth. Treated as expired, which is
   * the reading that does not put a file on screen in the operator's mind when it is not there.
   */
  if (!blocks.length) return 'expired';

  if (isItemActiveNow(blocks, new Date(now), tz)) return 'active';

  /*
   * Not on air. Is there any future in it?
   *
   * blockCanMatch first, and it is not a formality: an impossible rule set compiles to a
   * zero-width block that carries no end_date, which is indistinguishable from an ordinary
   * recurring block unless you ask. Reading it as unbounded put a "waiting its turn" clock on a
   * file that can never appear — the precise confusion this badge exists to remove.
   *
   * Otherwise an unbounded block recurs forever, and a dated one is spent once its furthest
   * end_date is behind us.
   */
  for (const b of blocks) {
    if (!blockCanMatch(b)) continue;
    if (!b.end_date) return 'pending';
    if (b.end_date >= today) return 'pending';
  }
  return 'expired';
}

function ymd(ms) {
  const d = new Date(ms);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/*
 * A file with an expiry date and no rules is "pending_expiry" above: it plays now and stops later.
 * The list shows it as on air, because it is — the distinct name exists so the caller can say so
 * in a tooltip without a second lookup.
 */
function badgeFor(state) {
  if (state === 'pending_expiry') return 'active';
  return state;
}

module.exports = { deriveScheduleState, badgeFor };
