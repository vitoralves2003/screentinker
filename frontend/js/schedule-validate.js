/*
 * Client-side validation for schedule blocks, and the human summary of one.
 *
 * It lived inside views/playlists.js, where the per-item editor used to be. When that editor was
 * extracted into components/schedule-editor.js the validator was left behind — so the extracted
 * component called validateScheduleBlocks with nothing importing it, and every save threw
 * ReferenceError. Nobody hit it because nobody had saved a schedule since; the first person to try
 * would have got a button that did nothing and no explanation anywhere.
 *
 * Shared module now, so the next thing that needs it imports it instead of copying it.
 *
 * The rules MIRROR the server (routes/content.js and routes/devices.js): same time and date
 * patterns, days required. Client validation that is laxer than the server's produces a confusing
 * round trip; stricter, and it refuses things the server would happily accept.
 */


const SCHED_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateScheduleBlocks(blocks) {
  for (const b of blocks) {
    if (!b.days || !b.days.length) return 'Cada bloco de programação precisa de pelo menos um dia ativo';
    if (!SCHED_TIME_RE.test(b.start)) return 'A hora de início deve ser HH:MM';
    // 24:00 is the end-of-day sentinel, not a clock reading — the regex above rejects it on purpose.
    if (!(SCHED_TIME_RE.test(b.end) || b.end === '24:00')) return 'A hora de fim deve ser HH:MM (ou fim do dia)';
    if (b.start_date && !SCHED_DATE_RE.test(b.start_date)) return 'A data de início deve ser AAAA-MM-DD';
    if (b.end_date && !SCHED_DATE_RE.test(b.end_date)) return 'A data de fim deve ser AAAA-MM-DD';
  }
  return null;
}

export function daysSummary(days) {
  const labels = 'Dom,Seg,Ter,Qua,Qui,Sex,Sáb'.split(',');
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return 'Todos os dias';
  if (s.length === 5 && [1, 2, 3, 4, 5].every((d) => s.includes(d))) return 'Seg-Sex';
  if (s.length === 2 && s.includes(0) && s.includes(6)) return 'Sáb-Dom';
  return s.map((d) => labels[d]).join(' ');
}

export function blockSummary(b) {
  let s = `${daysSummary(b.days)} ${b.start}-${b.end}`;
  if (b.start_date || b.end_date) s += ` · ${b.start_date || '…'}→${b.end_date || '…'}`;
  return s;
}

export function scheduleSummary(schedules) {
  if (!schedules || !schedules.length) return '';
  return schedules.length === 1
    ? blockSummary(schedules[0])
    : `${blockSummary(schedules[0])} +${schedules.length - 1}`;
}
