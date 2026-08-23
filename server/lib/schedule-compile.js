'use strict';

/*
 * Typed scheduling rules -> the block format every player already evaluates.
 *
 * WHY A COMPILER AND NOT NEW RULE TYPES ON THE WIRE.
 *
 * Four implementations evaluate schedules: server/lib/schedule-eval.js (server + web player),
 * tizen/js/schedule-eval.js, and the Kotlin port in the Android app, all pinned to
 * shared/schedule-vectors.json. Teaching "day of month" to the wire format means changing all
 * four, adding vectors, and shipping an APK plus a Tizen build — AND still needing a fallback,
 * because a device in the field runs whatever it last installed. Two things make that fallback
 * mandatory rather than nice to have: PlaylistController.parseSchedules reads exactly
 * days/start/end/start_date/end_date and drops every other key without a word, and ScheduleEval
 * FAILS OPEN by contract. So a "month = January" rule sent raw to a current player does not
 * degrade or complain — it plays in July, on a paying customer's screen, with nothing in any log.
 *
 * Since the fallback has to exist anyway, building ONLY the fallback is strictly less work, and it
 * reaches Android, web, Tizen and BrightSign the day it deploys. No app release is involved.
 *
 * HOW THE RULES COMBINE. Same type ORs, different types AND — "weekday = Monday" plus
 * "month = January" means Mondays IN January, not "every Monday, or all of January". Two
 * dimensions come out of that:
 *
 *   WHEN IN THE WEEK   weekday, time_range, weekday_time
 *   WHICH DATES        day_of_month, month, datetime_range
 *
 * Within the week dimension the three types OR, because that is what a person adding
 * "Monday 09:00-12:00" next to "Tuesday" means. A dimension with no rules is unrestricted.
 *
 * COMPILED ON READ, never stored. The expansion of "day of month = 1" is a list of dates, so it
 * has a horizon; storing it would mean owning cache invalidation for something that is cheap to
 * recompute. Every push therefore carries a fresh window, and the only device at risk is one that
 * stays connected with no playlist change until the horizon runs out — see the sweep in
 * services/schedule-horizon.js.
 */

const HORIZON_MONTHS = 18;

/*
 * Start a couple of days before today. Blocks are LOCAL wall-clock rules and a device may sit in a
 * timezone behind the server's, where it is still yesterday; an expansion that began at today
 * would have that device miss the first day. Two days of slack costs two blocks at most.
 */
const BACKDATE_DAYS = 2;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/;

const RULE_TYPES = ['datetime_range', 'time_range', 'weekday_time', 'weekday', 'day_of_month', 'month'];

// ---- small calendar helpers (UTC Date used for date arithmetic only, never for time or DST) ----

function p2(n) { return (n < 10 ? '0' : '') + n; }
function ymd(y, mo, d) { return y + '-' + p2(mo) + '-' + p2(d); }
function toUTC(dateStr) { const [y, mo, d] = dateStr.split('-').map(Number); return Date.UTC(y, mo - 1, d); }
function fromUTC(ms) { const d = new Date(ms); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
function addDays(dateStr, n) { return fromUTC(toUTC(dateStr) + n * 86400000); }
function dowOf(dateStr) { return new Date(toUTC(dateStr)).getUTCDay(); }
function dayOfMonth(dateStr) { return Number(dateStr.slice(8, 10)); }
function monthOf(dateStr) { return Number(dateStr.slice(5, 7)); }

function horizon(todayYmd) {
  const start = addDays(todayYmd, -BACKDATE_DAYS);
  const [y, mo, d] = todayYmd.split('-').map(Number);
  const end = new Date(Date.UTC(y, mo - 1 + HORIZON_MONTHS, d));
  return { start, end: fromUTC(end.getTime()) };
}

// ---- validation -------------------------------------------------------------------------------

/*
 * Mirrors what the UI allows, because a rule that survives to the compiler and produces nothing is
 * indistinguishable on a panel from a rule that is simply not active yet.
 */
function validateRules(rules) {
  if (!Array.isArray(rules)) return 'rules must be an array';
  for (const r of rules) {
    if (!r || typeof r !== 'object') return 'each rule must be an object';
    if (!RULE_TYPES.includes(r.type)) return `unknown rule type: ${r.type}`;
    switch (r.type) {
      case 'datetime_range':
        if (!DATETIME_RE.test(r.from || '')) return 'datetime_range.from must be YYYY-MM-DDTHH:MM';
        if (!DATETIME_RE.test(r.to || '')) return 'datetime_range.to must be YYYY-MM-DDTHH:MM';
        if (r.to <= r.from) return 'datetime_range.to must be after .from';
        break;
      case 'time_range':
      case 'weekday_time': {
        const end = r.end === '24:00' ? '24:00' : r.end;
        if (!TIME_RE.test(r.start || '')) return `${r.type}.start must be HH:MM`;
        if (!(TIME_RE.test(end || '') || end === '24:00')) return `${r.type}.end must be HH:MM or 24:00`;
        if (r.type === 'weekday_time' && !isDow(r.day)) return 'weekday_time.day must be 0-6';
        break;
      }
      case 'weekday':
        if (!isDow(r.day)) return 'weekday.day must be 0-6';
        break;
      case 'day_of_month':
        if (!Number.isInteger(r.day) || r.day < 1 || r.day > 31) return 'day_of_month.day must be 1-31';
        break;
      case 'month':
        if (!Number.isInteger(r.month) || r.month < 1 || r.month > 12) return 'month.month must be 1-12';
        break;
      default:
        return `unhandled rule type: ${r.type}`;
    }
  }
  return null;
}

function isDow(d) { return Number.isInteger(d) && d >= 0 && d <= 6; }

// ---- the week dimension: which (weekdays, time window) pairs may play ---------------------------

function weekWindows(rules) {
  const weekdays = rules.filter((r) => r.type === 'weekday').map((r) => r.day);
  const times = rules.filter((r) => r.type === 'time_range').map((r) => ({ start: r.start, end: r.end }));
  const pairs = rules.filter((r) => r.type === 'weekday_time')
    .map((r) => ({ days: [r.day], start: r.start, end: r.end }));

  /*
   * weekday x time_range is the AND across two types. Either one alone leaves the other
   * unrestricted: days with no hours means all day, hours with no days means every day.
   */
  if (weekdays.length || times.length) {
    const days = weekdays.length ? [...new Set(weekdays)].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6];
    const windows = times.length ? times : [{ start: '00:00', end: '24:00' }];
    for (const w of windows) pairs.push({ days, start: w.start, end: w.end });
  }

  if (!pairs.length) pairs.push({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' });

  // Merge pairs sharing a window so "month = January" emits one block, not seven.
  const byWindow = new Map();
  for (const p of pairs) {
    const k = p.start + '-' + p.end;
    if (!byWindow.has(k)) byWindow.set(k, { days: new Set(), start: p.start, end: p.end });
    for (const d of p.days) byWindow.get(k).days.add(d);
  }
  return [...byWindow.values()].map((w) => ({ days: [...w.days].sort((a, b) => a - b), start: w.start, end: w.end }));
}

// ---- the date dimension: which calendar dates may play ------------------------------------------

/*
 * Returns null when no rule restricts the date, which is the case worth keeping fast: the blocks
 * come out with no date bounds at all and the horizon never enters into it.
 */
function allowedDates(rules, todayYmd) {
  const doms = new Set(rules.filter((r) => r.type === 'day_of_month').map((r) => r.day));
  const months = new Set(rules.filter((r) => r.type === 'month').map((r) => r.month));
  const spans = rules.filter((r) => r.type === 'datetime_range')
    .map((r) => ({ from: r.from.slice(0, 10), to: r.to.slice(0, 10) }));

  if (!doms.size && !months.size && !spans.length) return null;

  const { start, end } = horizon(todayYmd);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (doms.size && !doms.has(dayOfMonth(d))) continue;
    if (months.size && !months.has(monthOf(d))) continue;
    if (spans.length && !spans.some((s) => d >= s.from && d <= s.to)) continue;
    out.push(d);
  }
  return out;
}

/*
 * A datetime_range starts and ends at a time of day, so its first and last dates are partial.
 *
 * Returns the intervals a date is open for, ONE PER SPAN — deliberately not merged into a single
 * min/max. Two spans touching the same date at different hours (5 Jan 09:00-12:00 and 5 Jan 18:00
 * to 6 Jan 10:00) have a min/max of 09:00-24:00, which would open 14:00 on a date neither span
 * covers. Overlapping intervals are harmless here: they produce overlapping blocks, and blocks OR.
 */
function clipsFor(rules, dateStr) {
  const spans = rules.filter((r) => r.type === 'datetime_range');
  if (!spans.length) return null;
  const out = [];
  for (const s of spans) {
    const fd = s.from.slice(0, 10), td = s.to.slice(0, 10);
    if (dateStr < fd || dateStr > td) continue;
    out.push({
      start: dateStr === fd ? s.from.slice(11) : '00:00',
      end: dateStr === td ? s.to.slice(11) : '24:00',
    });
  }
  return out.length ? out : null;
}

/* Whole-day intervals need no peeling; the date can stay in a run with its neighbours. */
function isFullDay(clips) {
  return !!clips && clips.some((c) => c.start === '00:00' && c.end === '24:00');
}

/*
 * A window like 22:00-02:00 crosses midnight, and the evaluator reads that by ANCHORING to the day
 * the window started: "Monday 22:00-02:00" is active on Tuesday at 01:00, because that is still
 * Monday night. For a weekly rule that is exactly right and it stays.
 *
 * It is wrong the moment a DATE rule joins in. "January" anchored the same way would keep playing
 * at 01:00 on 1 February, and a rule the operator reads as "January only" putting a January
 * campaign on screen in February is the whole failure this compiler exists to avoid. So when a
 * date dimension is present the window becomes a literal intersection instead: it splits into
 * [start, 24:00) and [00:00, end), both anchored to their own date. 31 January 23:00 plays;
 * 1 February 01:00 does not.
 */
function splitWrap(windows) {
  const out = [];
  for (const w of windows) {
    if (w.start < w.end || w.end === '24:00') { out.push(w); continue; }
    if (w.start === w.end) { out.push(w); continue; } // degenerate; never matches either way
    out.push({ days: w.days, start: w.start, end: '24:00' });
    out.push({ days: w.days, start: '00:00', end: w.end });
  }
  return out;
}

function intersect(win, clip) {
  if (!clip) return win;
  const start = win.start > clip.start ? win.start : clip.start;
  const end = win.end < clip.end ? win.end : clip.end;
  return start < end ? { start, end } : null;
}

// ---- runs of consecutive dates ------------------------------------------------------------------

function runsOf(dates) {
  const runs = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.end, 1) === d) last.end = d;
    else runs.push({ start: d, end: d });
  }
  return runs;
}

// ---- the compiler --------------------------------------------------------------------------------

/*
 * rules -> blocks in the shape schedule-eval.js has always evaluated:
 *   { days:[0-6], start:"HH:MM", end:"HH:MM"|"24:00", start_date, end_date }
 *
 * An empty rule list compiles to zero blocks, which the evaluator reads as "always on" — the same
 * meaning it has always had, so a file with no schedule keeps playing.
 */
function compileRules(rules, todayYmd) {
  if (!Array.isArray(rules) || !rules.length) return [];
  const today = todayYmd || fromUTC(Date.now());

  const dates = allowedDates(rules, today);

  // No date restriction: the weekly windows stand on their own, unbounded, anchoring intact.
  if (dates === null) {
    return weekWindows(rules)
      .map((w) => ({ days: w.days, start: w.start, end: w.end, start_date: null, end_date: null }));
  }

  /*
   * A rule set that can never match — "day 31" AND "February" — must compile to a block that never
   * matches, NOT to no blocks. Zero blocks is the evaluator's "this file has no schedule", so
   * returning nothing here would turn an impossible rule into ALWAYS PLAYING: the exact inversion
   * of what the operator asked for, on every screen, silently. start == end matches no instant.
   */
  if (!dates.length) {
    return [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00', start_date: null, end_date: null }];
  }

  const windows = splitWrap(weekWindows(rules));

  /*
   * Dates whose hours are clipped by a datetime_range boundary cannot share a block with the days
   * around them, so they are peeled off and emitted alone.
   */
  const clipped = new Map();
  for (const d of dates) {
    const c = clipsFor(rules, d);
    if (c && !isFullDay(c)) clipped.set(d, c);
  }

  const blocks = [];
  for (const run of runsOf(dates.filter((d) => !clipped.has(d)))) {
    for (const w of windows) {
      if (!runHasAnyDay(run, w.days)) continue;
      blocks.push({ days: w.days, start: w.start, end: w.end, start_date: run.start, end_date: run.end });
    }
  }
  for (const [d, clips] of clipped) {
    const dow = dowOf(d);
    for (const w of windows) {
      if (!w.days.includes(dow)) continue;
      for (const clip of clips) {
        const win = intersect(w, clip);
        if (!win) continue;
        blocks.push({ days: [dow], start: win.start, end: win.end, start_date: d, end_date: d });
      }
    }
  }
  return blocks;
}

/*
 * Can this block ever match anything?
 *
 * A zero-width window ([00:00, 00:00), start == end) matches no instant — that is how an
 * impossible rule set is expressed, since returning no blocks at all would mean "no schedule,
 * always play" to the evaluator. Callers that reason about a schedule's FUTURE need to tell that
 * block apart from an ordinary unbounded one, which otherwise looks identical: both carry no
 * end_date, and one recurs forever while the other never happens.
 */
function blockCanMatch(b) {
  return b.start !== b.end;
}

/* A run shorter than a week may not contain the weekday at all; emitting that block wastes payload. */
function runHasAnyDay(run, days) {
  const span = Math.round((toUTC(run.end) - toUTC(run.start)) / 86400000) + 1;
  if (span >= 7) return true;
  for (let i = 0; i < span; i++) if (days.includes(dowOf(addDays(run.start, i)))) return true;
  return false;
}

module.exports = {
  compileRules,
  blockCanMatch,
  validateRules,
  RULE_TYPES,
  HORIZON_MONTHS,
  __test: { weekWindows, allowedDates, runsOf, horizon, clipsFor, isFullDay, intersect, runHasAnyDay, splitWrap },
};
