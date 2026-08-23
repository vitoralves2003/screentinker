'use strict';

/*
 * The clock beside a filename in the library.
 *
 * The whole value of the badge is one distinction: a file that is not on screen because its time
 * has not come, versus one that is not on screen because it never will be again. Those look
 * identical in a list of names, and getting them backwards is worse than showing nothing — an
 * operator who reads "expired" as "waiting" leaves a dead campaign in a playlist, and one who
 * reads "waiting" as "expired" deletes a campaign that was about to run.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveScheduleState, badgeFor } = require('../lib/schedule-state');

const TZ = 'UTC';
// A Monday, 12:00 UTC. Fixed, so the suite does not depend on the day or hour it runs.
const MONDAY_NOON = Date.UTC(2026, 8, 7, 12, 0);
const at = (ms, rules, expiresAt = null) => deriveScheduleState({ rules, expiresAt, now: ms, tz: TZ });

test('no schedule and no expiry shows no clock at all', () => {
  /*
   * The absence IS the signal — it means the file always plays. A grey clock on every unscheduled
   * file would make the list noisier while saying less.
   */
  assert.equal(at(MONDAY_NOON, []), null);
  assert.equal(at(MONDAY_NOON, null), null);
});

test('on air inside its window, waiting outside it', () => {
  const rules = [{ type: 'weekday', day: 1 }, { type: 'time_range', start: '09:00', end: '18:00' }];
  assert.equal(at(MONDAY_NOON, rules), 'active');
  assert.equal(at(Date.UTC(2026, 8, 7, 20, 0), rules), 'pending', 'same Monday, after hours');
  assert.equal(at(Date.UTC(2026, 8, 8, 12, 0), rules), 'pending', 'Tuesday');
});

test('a recurring rule is never expired, however long you wait', () => {
  // "Every Monday" has no end. Marking it expired on a Tuesday would be the badge inventing a
  // deadline the operator never set.
  const rules = [{ type: 'weekday', day: 1 }];
  assert.equal(at(Date.UTC(2030, 0, 1, 12, 0), rules), 'pending');
});

test('a dated campaign reads as waiting before it, on air during it, finished after', () => {
  const rules = [{ type: 'datetime_range', from: '2026-12-01T00:00', to: '2026-12-24T23:59' }];
  assert.equal(at(Date.UTC(2026, 10, 20, 12, 0), rules), 'pending', 'November');
  assert.equal(at(Date.UTC(2026, 11, 10, 12, 0), rules), 'active', 'mid-December');
  assert.equal(at(Date.UTC(2027, 0, 5, 12, 0), rules), 'expired', 'January, and it is over');
});

test('expiry overrides the rules, including a rule that says "now"', () => {
  /*
   * A file whose validade has passed cannot play whatever its schedule says. Reporting it as on
   * air would be precisely the false green this badge exists to prevent.
   */
  const rules = [{ type: 'weekday', day: 1 }, { type: 'time_range', start: '09:00', end: '18:00' }];
  const yesterday = Math.floor((MONDAY_NOON - 86400000) / 1000);
  assert.equal(at(MONDAY_NOON, rules), 'active', 'the rule alone says on air');
  assert.equal(at(MONDAY_NOON, rules, yesterday), 'expired', 'but the expiry has passed');
});

test('an expiry with no schedule plays now and shows the on-air clock', () => {
  // It is genuinely on screen; the only thing the expiry adds is an end date in the future.
  const tomorrow = Math.floor((MONDAY_NOON + 86400000) / 1000);
  const state = at(MONDAY_NOON, [], tomorrow);
  assert.equal(state, 'pending_expiry');
  assert.equal(badgeFor(state), 'active', 'the list must show it as on air, because it is');
});

test('a rule that can never match reads as finished, not as on air', () => {
  /*
   * "Day 31" AND "February". The compiler emits a block that matches nothing; if that were ever
   * to become zero blocks the evaluator would read it as "no schedule, always play" and the badge
   * would go green on a file that can never appear.
   */
  const rules = [{ type: 'day_of_month', day: 31 }, { type: 'month', month: 2 }];
  assert.equal(at(MONDAY_NOON, rules), 'expired');
});

test('the day of the month is on air on the day and waiting on the others', () => {
  const rules = [{ type: 'day_of_month', day: 1 }];
  assert.equal(at(Date.UTC(2026, 9, 1, 10, 0), rules), 'active');
  assert.equal(at(Date.UTC(2026, 9, 2, 10, 0), rules), 'pending');
});

test('the badge is read in the timezone it is given', () => {
  /*
   * A window of 09:00-18:00 local is on air at 12:00 in São Paulo and not at 12:00 UTC-of-the-
   * same-instant. The list is stamped with the reader's own zone for exactly this reason, and a
   * badge that ignored it would be wrong for three hours a day in Brazil alone.
   */
  const rules = [{ type: 'time_range', start: '09:00', end: '18:00' }];
  const instant = Date.UTC(2026, 8, 7, 23, 0); // 20:00 in São Paulo, 23:00 UTC
  assert.equal(deriveScheduleState({ rules, expiresAt: null, now: instant, tz: 'UTC' }), 'pending');
  assert.equal(deriveScheduleState({ rules, expiresAt: null, now: Date.UTC(2026, 8, 7, 15, 0), tz: 'America/Sao_Paulo' }), 'active',
    '12:00 in São Paulo is inside the window');
});
