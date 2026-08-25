/*
 * The when-may-this-play editor, in two shapes.
 *
 * The rule belongs to the FILE — whoever uploads the December campaign knows it runs to the 24th,
 * and the same file in three lists should not need the rule entered three times — so the editor
 * lives here rather than inside the playlist view it started in.
 *
 * TWO SHAPES, ONE EDITOR:
 *
 *   mountScheduleEditor(host, blocks)  inline, for a form that already has a Save of its own
 *   showScheduleEditor({ … })          a modal, for a page that has nowhere to put it
 *
 * The inline shape exists because the content-library version was a modal ON TOP of the "Editar
 * conteúdo" modal: two Cancel buttons and two Save buttons on screen at once, and — the part that
 * actually bit — the inner one SAVED IMMEDIATELY while the outer one had its own Save. Someone
 * could store a schedule, press Cancelar on the modal underneath, and walk away certain nothing had
 * been written.
 *
 * Nothing about the BLOCKS changed in either shape: same shape on the wire, same validation, same
 * evaluator on the panel.
 */

import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { validateScheduleBlocks } from '../schedule-validate.js';

/*
 * NAMED SCENARIOS, borrowed from what a competitor does well.
 *
 * Four preset buttons used to sit at the top — Todos os dias, Dias úteis, Fim de semana,
 * Horário comercial. They were added when this editor was also the file scheduler and its model
 * needed explaining; the file scheduler is now the named-rule editor next door, and all this is
 * used for is a screen's opening hours.
 *
 * For that one job the presets were four choices in front of the one thing the reader came to
 * fill in. The dialog opens on the block instead, pre-filled with Mon-Fri 09:00-17:00, which is
 * both the commonest answer and immediately editable.
 */

/*
 * The block a screen's hours start from when nothing is set. Mon-Fri 09:00-17:00 is a guess, and
 * a deliberate one: the alternative was opening on "Sem programação" with an Add button, which
 * makes the reader click once before they can begin, to reach a state the product could have
 * offered them. Wrong-but-editable beats empty here — every field is visible and every field is
 * theirs to change.
 */
const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', start_date: '', end_date: '' };

function normalise(list) {
  return (list || []).map((b) => ({
    days: Array.isArray(b.days) ? [...b.days] : [],
    start: b.start || '00:00',
    end: b.end || '24:00',
    start_date: b.start_date || '',
    end_date: b.end_date || '',
  }));
}

function blockRow(b, idx) {
  const eod = b.end === '24:00';
  const dayLabels = t('itemsched.dow_short').split(',');
  return `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:13px">${t('itemsched.block', { n: idx + 1 })}</strong>
        <button type="button" class="sched-remove" data-idx="${idx}" title="${t('itemsched.remove_block')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:14px">✕</button>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
        ${dayLabels.map((lbl, d) => `<button type="button" class="sched-day" data-idx="${idx}" data-day="${d}" style="padding:4px 9px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:${b.days.includes(d) ? 'var(--accent)' : 'var(--bg-input)'};color:${b.days.includes(d) ? '#000' : 'var(--text-muted)'}">${lbl}</button>`).join('')}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.from')} <input type="time" class="input sched-start" data-idx="${idx}" value="${esc(b.start)}" style="width:118px"></label>
        <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.to')} <input type="time" class="input sched-end" data-idx="${idx}" value="${esc(eod ? '00:00' : b.end)}" ${eod ? 'disabled' : ''} style="width:118px"></label>
        <label style="font-size:12px;color:var(--text-muted)"><input type="checkbox" class="sched-eod" data-idx="${idx}" ${eod ? 'checked' : ''}> ${t('itemsched.end_of_day')}</label>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.starts')} <input type="date" class="input sched-sd" data-idx="${idx}" value="${esc(b.start_date)}" style="width:150px"></label>
        <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.ends')} <input type="date" class="input sched-ed" data-idx="${idx}" value="${esc(b.end_date)}" style="width:150px"></label>
        <span style="font-size:11px;color:var(--text-muted)">${t('itemsched.dates_hint')}</span>
      </div>
    </div>`;
}

/*
 * Draw the blocks into `host` and keep them in step with what the reader does.
 *
 * Returns { read() } — the caller's Save collects from it. It deliberately does NOT persist
 * anything: an editor embedded in a form must not write behind the form's own button.
 */
export function mountScheduleEditor(host, initial) {
  let blocks = normalise(initial);

  function render() {
    host.innerHTML = `
      <div>${blocks.length ? blocks.map(blockRow).join('') : `<p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">${t('itemsched.none')}</p>`}</div>
      <button type="button" class="btn btn-secondary btn-sm sched-add">${t('itemsched.add_block')}</button>`;
    wire();
  }

  function wire() {
    host.querySelectorAll('.sched-day').forEach((btn) => btn.addEventListener('click', () => {
      const i = +btn.dataset.idx; const d = +btn.dataset.day;
      const set = new Set(blocks[i].days);
      if (set.has(d)) set.delete(d); else set.add(d);
      blocks[i].days = [...set];
      render();
    }));
    host.querySelectorAll('.sched-start').forEach((el) => el.addEventListener('change', () => { blocks[+el.dataset.idx].start = el.value; }));
    host.querySelectorAll('.sched-end').forEach((el) => el.addEventListener('change', () => { blocks[+el.dataset.idx].end = el.value; }));
    host.querySelectorAll('.sched-eod').forEach((el) => el.addEventListener('change', () => {
      blocks[+el.dataset.idx].end = el.checked ? '24:00' : '17:00';
      render();
    }));
    host.querySelectorAll('.sched-sd').forEach((el) => el.addEventListener('change', () => { blocks[+el.dataset.idx].start_date = el.value; }));
    host.querySelectorAll('.sched-ed').forEach((el) => el.addEventListener('change', () => { blocks[+el.dataset.idx].end_date = el.value; }));
    host.querySelectorAll('.sched-remove').forEach((btn) => btn.addEventListener('click', () => { blocks.splice(+btn.dataset.idx, 1); render(); }));
    host.querySelector('.sched-add').addEventListener('click', () => {
      blocks.push({ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00', start_date: '', end_date: '' });
      render();
    });
  }

  render();

  return {
    /* The payload, or a validation error. The caller decides what to do with either. */
    read() {
      const payload = blocks.map((b) => ({
        days: b.days, start: b.start, end: b.end,
        start_date: b.start_date || null, end_date: b.end_date || null,
      }));
      return { blocks: payload, error: validateScheduleBlocks(payload) };
    },
  };
}

/*
 * The modal shape, for a page with nowhere to embed the editor — the device page's opening hours.
 * It saves on its own because it IS the form; the inline shape must not, because it is not.
 */
/*
 * Seeded only in the MODAL. The embedded shape is mounted inside forms that may legitimately have
 * no schedule at all, and inventing a block there would silently turn "always plays" into
 * "weekdays only" the moment somebody saved the form for an unrelated reason.
 */
export function showScheduleEditor({ title, blocks: initial, onSave }) {
  const seeded = (initial && initial.length) ? initial : [DEFAULT_HOURS];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:600px">
      <div class="modal-header"><h3>${esc(t('itemsched.title'))}</h3></div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">${esc(title || '')}</p>
        <p style="font-size:12px;color:var(--info);background:var(--info-dim);border-radius:6px;padding:8px 10px;margin:0 0 16px">${t('itemsched.hint')}</p>
        <div id="schedHost"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="schedCancel">${esc(t('itemsched.cancel'))}</button>
        <button class="btn btn-primary" id="schedSave">${esc(t('itemsched.save'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const editor = mountScheduleEditor(overlay.querySelector('#schedHost'), seeded);

  overlay.querySelector('#schedCancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#schedSave').addEventListener('click', async () => {
    const { blocks, error } = editor.read();
    if (error) { showToast(error, 'error'); return; }
    try {
      await onSave(blocks);
      overlay.remove();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}
