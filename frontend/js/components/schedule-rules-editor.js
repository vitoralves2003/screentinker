/*
 * The when-may-this-play editor: pick a type, get a row.
 *
 * This replaced a block builder where every rule was the same shape — a set of weekdays, a time
 * window and an optional date range — and the reader had to construct the meaning themselves. A
 * named type says what it is before you fill it in, and it makes "the 1st of the month" and
 * "January" expressible at all, which the block shape could not represent.
 *
 * HOW THE ROWS COMBINE, because it is the one thing here that can surprise: rows of the SAME type
 * are alternatives (OR), rows of DIFFERENT types all have to hold (AND). "Monday" plus "January"
 * is Mondays in January. That is standard for this kind of scheduler and it is what the competing
 * product does, but nobody should have to know it — so the editor writes the rule out as a
 * sentence underneath and keeps it in step with every edit.
 *
 * Nothing here persists. read() hands back the rules and the form that owns the Save decides.
 */

import { esc } from '../utils.js';

const TIPO_AGENDA = {
  'datetime_range': 'Período de dias e horas',
  'day_of_month': 'Dia do mês',
  'month': 'Mês',
  'time_range': 'Período de horas do dia',
  'weekday': 'Dia da semana',
  'weekday_time': 'Período de horas do dia em dia específico',
};

/* Order matches the type menu; `sample` is what a fresh row of that type starts as. */
const TYPES = [
  { key: 'datetime_range', sample: () => ({ type: 'datetime_range', from: '', to: '' }) },
  { key: 'time_range', sample: () => ({ type: 'time_range', start: '09:00', end: '18:00' }) },
  { key: 'weekday_time', sample: () => ({ type: 'weekday_time', day: 1, start: '09:00', end: '18:00' }) },
  { key: 'weekday', sample: () => ({ type: 'weekday', day: 1 }) },
  { key: 'day_of_month', sample: () => ({ type: 'day_of_month', day: 1 }) },
  { key: 'month', sample: () => ({ type: 'month', month: 1 }) },
];

function dowNames() { return 'Domingo,Segunda-feira,Terça-feira,Quarta-feira,Quinta-feira,Sexta-feira,Sábado'.split(','); }
function monthNames() { return 'Janeiro,Fevereiro,Março,Abril,Maio,Junho,Julho,Agosto,Setembro,Outubro,Novembro,Dezembro'.split(','); }

function options(list, selected) {
  return list.map((label, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function monthOptions(selected) {
  return monthNames().map((label, i) => `<option value="${i + 1}"${i + 1 === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function domOptions(selected) {
  let out = '';
  for (let d = 1; d <= 31; d++) out += `<option value="${d}"${d === selected ? ' selected' : ''}>${d}</option>`;
  return out;
}

const LBL = 'font-size:12px;color:var(--text-muted)';
const ROW = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px';

function rowFields(r, i) {
  switch (r.type) {
    case 'datetime_range':
      return `<span style="${LBL}">De</span>
        <input type="datetime-local" class="input r-from" data-i="${i}" value="${esc(r.from || '')}" style="width:210px">
        <span style="${LBL}">Até</span>
        <input type="datetime-local" class="input r-to" data-i="${i}" value="${esc(r.to || '')}" style="width:210px">`;
    case 'time_range':
      return `<span style="${LBL}">De</span>
        <input type="time" class="input r-start" data-i="${i}" value="${esc(r.start)}" style="width:118px">
        <span style="${LBL}">Até</span>
        <input type="time" class="input r-end" data-i="${i}" value="${esc(r.end === '24:00' ? '00:00' : r.end)}" style="width:118px">
        <label style="${LBL}"><input type="checkbox" class="r-eod" data-i="${i}" ${r.end === '24:00' ? 'checked' : ''}> fim do dia</label>`;
    case 'weekday_time':
      return `<select class="input r-day" data-i="${i}" style="width:150px">${options(dowNames(), r.day)}</select>
        <span style="${LBL}">De</span>
        <input type="time" class="input r-start" data-i="${i}" value="${esc(r.start)}" style="width:118px">
        <span style="${LBL}">Até</span>
        <input type="time" class="input r-end" data-i="${i}" value="${esc(r.end === '24:00' ? '00:00' : r.end)}" style="width:118px">
        <label style="${LBL}"><input type="checkbox" class="r-eod" data-i="${i}" ${r.end === '24:00' ? 'checked' : ''}> fim do dia</label>`;
    case 'weekday':
      return `<span style="${LBL}">Dia da semana</span>
        <select class="input r-day" data-i="${i}" style="width:190px">${options(dowNames(), r.day)}</select>`;
    case 'day_of_month':
      return `<span style="${LBL}">Dia do mês</span>
        <select class="input r-dom" data-i="${i}" style="width:110px">${domOptions(r.day)}</select>`;
    case 'month':
      return `<span style="${LBL}">Mês</span>
        <select class="input r-month" data-i="${i}" style="width:190px">${monthOptions(r.month)}</select>`;
    default:
      return `<span style="${LBL}">${esc(r.type)}</span>`;
  }
}

// ---- the sentence ------------------------------------------------------------------------------

function list(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' ' + 'ou' + ' ' + items[items.length - 1];
}

function hhmm(v) { return v === '24:00' ? '24:00' : v; }

/*
 * The rules in plain language, grouped the way they are evaluated: one clause per type, joined by
 * "and". If this sentence and the rows ever disagree, the sentence is the one a person will read.
 */
export function describeRules(rules) {
  if (!rules.length) return 'Sem agendamento — este arquivo sempre é reproduzido.';
  const dows = dowNames();
  const months = monthNames();
  const clauses = [];
  const of = (type) => rules.filter((r) => r.type === type);

  const wd = of('weekday');
  if (wd.length) clauses.push(`toda ${list(wd.map((r) => dows[r.day]))}`);

  const wt = of('weekday_time');
  if (wt.length) {
    clauses.push(`em ${list(wt.map((r) => `${dows[r.day]} ${r.start}–${hhmm(r.end)}`))}`);
  }

  const tr = of('time_range');
  if (tr.length) clauses.push(`das ${list(tr.map((r) => `${r.start}–${hhmm(r.end)}`))}`);

  const dom = of('day_of_month');
  if (dom.length) clauses.push(`no dia ${list(dom.map((r) => String(r.day)))} do mês`);

  const mo = of('month');
  if (mo.length) clauses.push(`em ${list(mo.map((r) => months[r.month - 1]))}`);

  const dr = of('datetime_range');
  if (dr.length) {
    clauses.push(`no período ${list(dr.map((r) => `${(r.from || '?').replace('T', ' ')} → ${(r.to || '?').replace('T', ' ')}`))}`);
  }

  if (!clauses.length) return 'Sem agendamento — este arquivo sempre é reproduzido.';
  const joined = clauses.length === 1 ? clauses[0]
    : clauses.slice(0, -1).join(', ') + ' ' + 'e' + ' ' + clauses[clauses.length - 1];
  return `Reproduz ${joined}.`;
}

// ---- validation, mirroring lib/schedule-compile.js ------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export function validateRules(rules) {
  for (const r of rules) {
    if (r.type === 'datetime_range') {
      if (!DT_RE.test(r.from || '') || !DT_RE.test(r.to || '')) return 'Preencha as duas datas do período';
      if (r.to <= r.from) return 'O fim do período precisa ser depois do início';
    }
    if (r.type === 'time_range' || r.type === 'weekday_time') {
      if (!TIME_RE.test(r.start || '')) return 'A hora de início deve ser HH:MM';
      if (!(TIME_RE.test(r.end || '') || r.end === '24:00')) return 'A hora de fim deve ser HH:MM (ou fim do dia)';
      if (r.start === r.end) return 'O início e o fim do horário não podem ser iguais';
    }
  }
  return null;
}

// ---- the editor ------------------------------------------------------------------------------------

export function mountScheduleRulesEditor(host, initial) {
  let rules = (initial || []).map((r) => ({ ...r }));

  function render() {
    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <select class="input" id="rulePicker" style="max-width:320px">
          <option value="">${esc('Selecione o tipo de agendamento')}</option>
          ${TYPES.map((ty) => `<option value="${ty.key}">${esc(TIPO_AGENDA[ty.key])}</option>`).join('')}
        </select>
      </div>
      <div id="ruleRows">${rules.map((r, i) => `
        <div style="${ROW}">
          <button type="button" class="r-del" data-i="${i}" title="${esc('Remover bloco')}"
            style="color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:14px;padding:0 2px">✕</button>
          ${rowFields(r, i)}
        </div>`).join('') || `<p style="${LBL};margin:0 0 8px">${esc('Sem programação — este item sempre é reproduzido.')}</p>`}</div>
      <p id="ruleSentence" style="font-size:12px;color:var(--info);background:var(--info-dim);border-radius:6px;padding:8px 10px;margin:12px 0 0"></p>`;
    host.querySelector('#ruleSentence').textContent = describeRules(rules);
    wire();
  }

  function wire() {
    const picker = host.querySelector('#rulePicker');
    picker.addEventListener('change', () => {
      const ty = TYPES.find((x) => x.key === picker.value);
      if (!ty) return;
      rules.push(ty.sample());
      render();
    });

    host.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', () => {
      rules.splice(+b.dataset.i, 1);
      render();
    }));

    /*
     * Field edits write straight into the rule and only re-render the sentence. Re-rendering the
     * whole list on every keystroke would take the focus out of the input being typed into.
     */
    const bind = (sel, apply) => host.querySelectorAll(sel).forEach((el) => el.addEventListener('change', () => {
      apply(rules[+el.dataset.i], el);
      host.querySelector('#ruleSentence').textContent = describeRules(rules);
    }));

    bind('.r-from', (r, el) => { r.from = el.value; });
    bind('.r-to', (r, el) => { r.to = el.value; });
    bind('.r-start', (r, el) => { r.start = el.value; });
    bind('.r-end', (r, el) => { r.end = el.value; });
    bind('.r-day', (r, el) => { r.day = +el.value; });
    bind('.r-dom', (r, el) => { r.day = +el.value; });
    bind('.r-month', (r, el) => { r.month = +el.value; });

    // End-of-day is a checkbox because 24:00 is not a time an <input type="time"> can hold.
    host.querySelectorAll('.r-eod').forEach((el) => el.addEventListener('change', () => {
      const r = rules[+el.dataset.i];
      r.end = el.checked ? '24:00' : '18:00';
      render();
    }));
  }

  render();

  return {
    read() {
      const payload = rules.map((r) => ({ ...r }));
      return { rules: payload, error: validateRules(payload) };
    },
  };
}
