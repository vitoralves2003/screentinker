'use strict';

/*
 * The rule compiler, checked the only way worth checking it: differentially.
 *
 * compileRules() turns typed rules into the blocks every player already evaluates. A unit test
 * that asserts "this rule produces these blocks" would pass just as happily on a compiler that
 * produces confidently wrong blocks, because the blocks are the thing under test. So instead this
 * file evaluates BOTH sides at thousands of instants: the compiled blocks through the real
 * ScheduleEval the fleet runs, and the rules through a small reference written the obvious way —
 * ask the question directly of one instant, no expansion, no horizon, no runs.
 *
 * The two implementations share no code. Where they disagree, one of them is wrong, and the test
 * prints the instant so it can be looked at.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compileRules, validateRules, __test } = require('../lib/schedule-compile');
const { isItemActiveNow } = require('../lib/schedule-eval');

const TODAY = '2026-03-10'; // a Tuesday; fixed so the suite cannot depend on the day it runs

// ---- the reference: same semantics, written per-instant instead of by expansion -----------------

function hm(s) { const a = s.split(':'); return (+a[0]) * 60 + (+a[1]); }
function dow(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
function shiftDate(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/* The (weekdays, window) alternatives the week dimension allows. */
function weekPairs(rules) {
  const pairs = rules.filter((r) => r.type === 'weekday_time')
    .map((r) => ({ days: [r.day], start: r.start, end: r.end }));
  const weekdays = rules.filter((r) => r.type === 'weekday').map((r) => r.day);
  const times = rules.filter((r) => r.type === 'time_range');
  if (weekdays.length || times.length) {
    const days = weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6];
    const windows = times.length ? times : [{ start: '00:00', end: '24:00' }];
    for (const w of windows) pairs.push({ days, start: w.start, end: w.end });
  }
  if (!pairs.length) pairs.push({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' });
  return pairs;
}

function hasDateDim(rules) {
  return rules.some((r) => r.type === 'day_of_month' || r.type === 'month' || r.type === 'datetime_range');
}

function refActive(rules, dateStr, minutes) {
  if (!rules.length) return true;
  const dated = hasDateDim(rules);

  for (const p of weekPairs(rules)) {
    const s = hm(p.start), e = hm(p.end);

    if (s < e || p.end === '24:00') {
      if (minutes < s || minutes >= e) continue;
      if (!p.days.includes(dow(dateStr))) continue;
      if (dated && !dateOk(rules, dateStr, minutes)) continue;
      return true;
    }
    if (s === e) continue; // degenerate window, matches nothing

    /*
     * Crosses midnight. With no date rule the evaluator ANCHORS to the day the window started, so
     * "Monday 22:00-02:00" is live on Tuesday at 01:00. With a date rule it is a literal
     * intersection instead, each half judged on its own date — otherwise a January rule would
     * play on 1 February.
     */
    if (dated) {
      const inLate = minutes >= s, inEarly = minutes < e;
      if (!inLate && !inEarly) continue;
      if (!p.days.includes(dow(dateStr))) continue;
      if (!dateOk(rules, dateStr, minutes)) continue;
      return true;
    }
    if (minutes >= s && p.days.includes(dow(dateStr))) return true;
    if (minutes < e && p.days.includes(dow(shiftDate(dateStr, -1)))) return true;
  }
  return false;
}

function dateOk(rules, dateStr, minutes) {
  const doms = rules.filter((r) => r.type === 'day_of_month').map((r) => r.day);
  const months = rules.filter((r) => r.type === 'month').map((r) => r.month);
  const spans = rules.filter((r) => r.type === 'datetime_range');

  if (doms.length && !doms.includes(Number(dateStr.slice(8, 10)))) return false;
  if (months.length && !months.includes(Number(dateStr.slice(5, 7)))) return false;
  if (spans.length) {
    // An instant, compared against the span's real datetime bounds. End is exclusive, matching
    // the [start, end) convention the evaluator uses for time windows.
    const stamp = dateStr + 'T' + String(Math.floor(minutes / 60)).padStart(2, '0') + ':'
      + String(minutes % 60).padStart(2, '0');
    if (!spans.some((s) => stamp >= s.from && stamp < s.to)) return false;
  }
  return true;
}

// ---- the harness --------------------------------------------------------------------------------

function utcMs(dateStr, minutes) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
}

/*
 * Walk `days` from TODAY, sampling `perDay` instants.
 *
 * The instants are built in UTC and the evaluator is told the zone is UTC, so wall clock and
 * instant coincide. Passing null instead would make the evaluator read the runtime's own clock,
 * and every case here would fail by the machine's offset — which says nothing about the compiler.
 * DST is schedule-eval.js's problem and it has its own vectors for it.
 */
function differ(rules, { days = 420, perDay = 6 } = {}) {
  const blocks = compileRules(rules, TODAY);
  const mismatches = [];
  let date = TODAY;
  for (let i = 0; i < days; i++) {
    for (let k = 0; k < perDay; k++) {
      const minutes = Math.floor((k * 1440) / perDay) + (k % 2 ? 37 : 0);
      const want = refActive(rules, date, minutes);
      const got = isItemActiveNow(blocks, new Date(utcMs(date, minutes)), 'UTC');
      if (want !== got) mismatches.push(`${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} reference=${want} compiled=${got}`);
    }
    const nxt = new Date(utcMs(date, 0) + 86400000);
    date = `${nxt.getUTCFullYear()}-${String(nxt.getUTCMonth() + 1).padStart(2, '0')}-${String(nxt.getUTCDate()).padStart(2, '0')}`;
  }
  return { blocks, mismatches };
}

function agrees(name, rules, opts) {
  test(`compiled blocks agree with the rules: ${name}`, () => {
    const { blocks, mismatches } = differ(rules, opts);
    assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} disagreement(s); blocks=${JSON.stringify(blocks)}`);
  });
}

// ---- one per rule type, then the combinations that carry the semantics ---------------------------

agrees('no rules at all plays always', []);
agrees('time_range', [{ type: 'time_range', start: '09:00', end: '18:00' }]);
agrees('time_range crossing midnight', [{ type: 'time_range', start: '22:00', end: '02:00' }]);
agrees('time_range to end of day', [{ type: 'time_range', start: '20:00', end: '24:00' }]);
agrees('weekday', [{ type: 'weekday', day: 1 }]);
agrees('weekday_time', [{ type: 'weekday_time', day: 5, start: '14:00', end: '18:00' }]);
agrees('day_of_month', [{ type: 'day_of_month', day: 1 }]);
agrees('day_of_month on the 31st, which most months do not have', [{ type: 'day_of_month', day: 31 }]);
agrees('month', [{ type: 'month', month: 1 }]);
agrees('datetime_range', [{ type: 'datetime_range', from: '2026-04-05T14:00', to: '2026-04-08T10:00' }]);
agrees('datetime_range inside a single day', [{ type: 'datetime_range', from: '2026-04-05T14:00', to: '2026-04-05T18:00' }]);

agrees('same type ORs: three weekdays', [
  { type: 'weekday', day: 1 }, { type: 'weekday', day: 3 }, { type: 'weekday', day: 5 },
]);
agrees('same type ORs: two months', [{ type: 'month', month: 1 }, { type: 'month', month: 7 }]);

agrees('different types AND: Mondays in January', [
  { type: 'weekday', day: 1 }, { type: 'month', month: 1 },
]);
agrees('different types AND: the 1st of each month, 09:00-18:00', [
  { type: 'day_of_month', day: 1 }, { type: 'time_range', start: '09:00', end: '18:00' },
]);
agrees('different types AND: weekday + month + hours', [
  { type: 'weekday', day: 2 }, { type: 'month', month: 6 },
  { type: 'time_range', start: '08:00', end: '12:00' },
]);
agrees('weekday_time ORs alongside a plain weekday', [
  { type: 'weekday_time', day: 1, start: '09:00', end: '12:00' }, { type: 'weekday', day: 2 },
]);
agrees('two spans touching the same date at different hours', [
  { type: 'datetime_range', from: '2026-04-05T09:00', to: '2026-04-05T12:00' },
  { type: 'datetime_range', from: '2026-04-05T18:00', to: '2026-04-06T10:00' },
]);
agrees('a span ANDed with an hours window', [
  { type: 'datetime_range', from: '2026-04-05T00:00', to: '2026-04-20T00:00' },
  { type: 'time_range', start: '09:00', end: '18:00' },
]);
agrees('a rule set that can never match', [
  { type: 'day_of_month', day: 31 }, { type: 'month', month: 2 },
]);

/*
 * Midnight-crossing windows next to a date rule. This is where the compiler makes a judgement
 * call — anchoring is kept for a purely weekly rule and dropped for a dated one — so it gets the
 * heaviest sampling of any case here.
 */
agrees('month ANDed with a window crossing midnight', [
  { type: 'month', month: 1 }, { type: 'time_range', start: '22:00', end: '02:00' },
], { perDay: 24 });
agrees('day of month ANDed with a window crossing midnight', [
  { type: 'day_of_month', day: 15 }, { type: 'time_range', start: '23:00', end: '01:00' },
], { perDay: 24 });
agrees('weekday_time crossing midnight, no date rule so anchoring stands', [
  { type: 'weekday_time', day: 5, start: '22:00', end: '02:00' },
], { perDay: 24 });
agrees('a span ANDed with a window crossing midnight', [
  { type: 'datetime_range', from: '2026-04-05T00:00', to: '2026-04-20T00:00' },
  { type: 'time_range', start: '22:00', end: '02:00' },
], { perDay: 24 });
agrees('a span ANDed with weekdays', [
  { type: 'datetime_range', from: '2026-04-05T08:00', to: '2026-05-20T17:30' },
  { type: 'weekday', day: 1 }, { type: 'weekday', day: 4 },
]);

// ---- the properties the fleet depends on ----------------------------------------------------------

test('the compiled blocks only ever use the five keys the players parse', () => {
  /*
   * PlaylistController.parseSchedules reads days/start/end/start_date/end_date and drops anything
   * else in silence, and ScheduleEval fails open. A key leaking out of the compiler would not be
   * an error on a panel — it would be a rule quietly not applying.
   */
  const blocks = compileRules([
    { type: 'day_of_month', day: 1 }, { type: 'month', month: 1 },
    { type: 'datetime_range', from: '2026-04-05T14:00', to: '2026-04-08T10:00' },
    { type: 'weekday_time', day: 3, start: '09:00', end: '17:00' },
  ], TODAY);
  for (const b of blocks) {
    assert.deepEqual(Object.keys(b).sort(), ['days', 'end', 'end_date', 'start', 'start_date']);
    assert.ok(Array.isArray(b.days) && b.days.length, 'days must be a non-empty array');
    assert.ok(b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6));
    assert.match(b.start, /^([01]\d|2[0-3]):[0-5]\d$/);
    assert.ok(/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end) || b.end === '24:00');
  }
});

test('an empty rule list compiles to zero blocks, which means always on', () => {
  // Not an empty schedule that never matches — the evaluator reads zero blocks as "no schedule".
  assert.deepEqual(compileRules([], TODAY), []);
  assert.equal(isItemActiveNow([], new Date(), null), true);
});

test('an impossible rule set compiles to a block that never matches, not to no blocks', () => {
  /*
   * The distinction the evaluator draws is absolute: zero blocks means "no schedule, always play".
   * So "day 31 AND February" returning [] would put the file on every screen, all the time — the
   * exact opposite of the rule, and the kind of wrong that nobody reports because nothing errors.
   */
  const blocks = compileRules([{ type: 'day_of_month', day: 31 }, { type: 'month', month: 2 }], TODAY);
  assert.equal(blocks.length, 1);
  for (let h = 0; h < 24; h++) {
    assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 1, 15, h, 30)), 'UTC'), false);
    assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 6, 31, h, 30)), 'UTC'), false);
  }
});

test('the common shapes stay small enough to push', () => {
  const size = (rules) => compileRules(rules, TODAY).length;
  assert.ok(size([{ type: 'month', month: 1 }]) <= 4, 'a month is a couple of date runs');
  assert.ok(size([{ type: 'weekday', day: 1 }]) === 1, 'a weekday needs no date bounds at all');
  assert.ok(size([{ type: 'time_range', start: '09:00', end: '18:00' }]) === 1);
  // A day of the month is one run per occurrence, which is the honest cost of the horizon.
  assert.ok(size([{ type: 'day_of_month', day: 1 }]) <= 20, 'one per month over the horizon');
});

test('a weekday alone carries no date bounds, so the horizon never expires it', () => {
  /*
   * The horizon only exists for rules that name calendar dates. If a plain weekly rule came out
   * with date bounds it would stop playing when the window ran out — the failure the nightly
   * sweep exists to prevent, made routine.
   */
  const blocks = compileRules([{ type: 'weekday', day: 1 }, { type: 'time_range', start: '09:00', end: '18:00' }], TODAY);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start_date, null);
  assert.equal(blocks[0].end_date, null);
});

// ---- validation -------------------------------------------------------------------------------------

test('validateRules refuses what the compiler cannot mean', () => {
  assert.equal(validateRules([]), null);
  assert.equal(validateRules([{ type: 'weekday', day: 0 }]), null);
  assert.equal(validateRules([{ type: 'time_range', start: '09:00', end: '24:00' }]), null);
  assert.match(validateRules([{ type: 'nope' }]), /unknown rule type/);
  assert.match(validateRules([{ type: 'weekday', day: 7 }]), /0-6/);
  assert.match(validateRules([{ type: 'day_of_month', day: 0 }]), /1-31/);
  assert.match(validateRules([{ type: 'month', month: 13 }]), /1-12/);
  assert.match(validateRules([{ type: 'time_range', start: '9:00', end: '18:00' }]), /HH:MM/);
  assert.match(validateRules([{ type: 'datetime_range', from: '2026-04-05T10:00', to: '2026-04-05T09:00' }]), /after/);
  assert.match(validateRules('not an array'), /must be an array/);
});

test('the horizon is measured from the day asked about, not from the clock', () => {
  // Otherwise the compiler is untestable and the output drifts by a day depending on when it runs.
  const a = __test.horizon('2026-03-10');
  assert.equal(a.start, '2026-03-08');
  assert.equal(a.end, '2027-09-10');
});
