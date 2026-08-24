'use strict';

/*
 * Calendar days in a SCREEN's timezone, not the server's.
 *
 * The exhibition timeline is read as "what did this screen show on Tuesday", and Tuesday belongs
 * to the screen. A panel in Manaus and one in Recife are an hour apart; grouping either by the
 * server's clock puts the first and last plays of a day on the wrong side of midnight — and the
 * error is invisible, because every row still looks like a plausible time.
 *
 * Both directions are needed and only one of them is easy:
 *   epoch -> local day/time   Intl does it.
 *   local day -> epoch        Intl does NOT do it, so it is solved by inversion below.
 *
 * DST is the reason this is not offset arithmetic. Brazil has no DST today, but the fleet is not
 * promised to stay in Brazil, and a fixed offset is wrong twice a year everywhere that does.
 */

// One formatter per zone. Constructing Intl.DateTimeFormat is expensive and a timeline groups
// thousands of rows through the same zone.
const _fmt = new Map();
function formatter(tz) {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    _fmt.set(tz, f);
  }
  return f;
}

function partsAt(epochMs, tz) {
  const p = {};
  for (const part of formatter(tz).formatToParts(new Date(epochMs))) p[part.type] = part.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour % 24, mi: +p.minute, s: +p.second,
  };
}

const p2 = (n) => (n < 10 ? `0${n}` : String(n));

/*
 * A resolved zone, or null.
 *
 * A screen that has never reported one, and has no override, has no local calendar to speak of —
 * the caller decides what to do about that (the timeline says so on screen rather than silently
 * using the server's). An INVALID zone is treated the same way: a typo in an override must not
 * throw a RangeError out of a report.
 */
function usableZone(tz) {
  if (!tz) return null;
  try { formatter(tz).format(new Date()); return tz; } catch { return null; }
}

/* 'YYYY-MM-DD' for an instant, in tz. */
function dayKey(epochSec, tz) {
  const p = partsAt(epochSec * 1000, tz);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}

/* 'HH:MM' for an instant, in tz. */
function hhmm(epochSec, tz) {
  const p = partsAt(epochSec * 1000, tz);
  return `${p2(p.h)}:${p2(p.mi)}`;
}

/* The offset of tz at a given instant, in ms (east of UTC is positive). */
function offsetMs(epochMs, tz) {
  const p = partsAt(epochMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - epochMs;
}

/*
 * A local wall-clock time in tz -> the instant it happened.
 *
 * Inverted in two passes. The first guess uses the offset in force at the same wall clock read
 * as UTC — wrong by roughly the offset itself, but close enough to land within a couple of hours
 * of the answer; the second pass reads the offset actually in force there. Two passes settle
 * every real zone.
 *
 * A wall time that does not exist (the hour a spring-forward skips) cannot round-trip, and this
 * returns an instant an hour off it rather than throwing. dayRange below does not rely on that
 * result being exact — it verifies the day it landed on.
 */
function epochForLocal(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive - offsetMs(naive, tz);
  guess = naive - offsetMs(guess, tz);
  return Math.floor(guess / 1000);
}

/*
 * 'YYYY-MM-DD' in tz -> [first second of that day, last second of that day].
 *
 * The ends are VERIFIED, not trusted. Some zones move their clock AT midnight — Santiago and
 * Havana both do — so local 00:00 on a transition day is a time that never happens, and the
 * inversion above lands on 23:00 the day before. A window that starts in the previous day makes
 * a play appear under a date it did not happen on, which is precisely the kind of wrong that
 * still looks right.
 *
 * So each end is walked in minute steps until it is genuinely inside the requested day. The walk
 * is bounded: no zone shifts by more than a couple of hours, and a bound that is never reached
 * in practice is still better than a loop that could spin on a zone nobody anticipated.
 */
function dayRange(dateStr, tz) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const LIMIT = 240; // minutes; four hours is far past the largest transition anywhere

  let start = epochForLocal(y, mo, d, 0, 0, 0, tz);
  for (let i = 0; i < LIMIT && dayKey(start, tz) < dateStr; i++) start += 60;

  let end = epochForLocal(y, mo, d, 23, 59, 59, tz);
  for (let i = 0; i < LIMIT && dayKey(end, tz) > dateStr; i++) end -= 60;

  return [start, end];
}
/* The screen's today, as 'YYYY-MM-DD'. */
function today(tz, nowSec = Math.floor(Date.now() / 1000)) {
  return dayKey(nowSec, tz);
}

/* n days back from `from` (inclusive of both ends), as 'YYYY-MM-DD'. Pure calendar arithmetic. */
function shiftDays(dateStr, delta) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

module.exports = { usableZone, dayKey, hhmm, dayRange, epochForLocal, today, shiftDays, offsetMs };
