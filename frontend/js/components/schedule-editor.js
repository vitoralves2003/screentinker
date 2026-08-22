/*
 * The when-may-this-play editor, as a component.
 *
 * It used to live inside the playlist view and edit a playlist ITEM. The rule belongs to the
 * FILE — whoever uploads the December campaign knows it runs to the 24th, and the same file in
 * three lists should not need the rule entered three times — so the editor moved to the content
 * library and the playlist row lost its clock button.
 *
 * Nothing about the BLOCKS changed: same shape, same validation, same evaluator on the panel.
 * Only the owner did. Kept generic (title + blocks + onSave) rather than hard-wired to content,
 * because widgets need the same editor and the agency API still writes per-item windows.
 */
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
export function showScheduleEditor({ title, blocks: initial, onSave }) {
  let blocks = (initial || []).map(b => ({
    days: Array.isArray(b.days) ? [...b.days] : [],
    start: b.start || '00:00',
    end: b.end || '24:00',
    start_date: b.start_date || '',
    end_date: b.end_date || ''
  }));

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  document.body.appendChild(modal);

  function blockRow(b, idx) {
    const eod = b.end === '24:00';
    const dayLabels = t('itemsched.dow_short').split(',');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13px">${t('itemsched.block', { n: idx + 1 })}</strong>
          <button class="sched-remove" data-idx="${idx}" title="${t('itemsched.remove_block')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:14px">✕</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${dayLabels.map((lbl, d) => `<button class="sched-day" data-idx="${idx}" data-day="${d}" style="padding:4px 9px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:${b.days.includes(d) ? 'var(--accent)' : 'var(--bg-input)'};color:${b.days.includes(d) ? '#000' : 'var(--text-muted)'}">${lbl}</button>`).join('')}
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

  function render() {
    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:580px;max-width:94vw;max-height:88vh;overflow:auto">
        <h3 style="margin:0 0 4px">${t('itemsched.title')}</h3>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">${esc(title || '')}</p>
        <p style="font-size:12px;color:#7dd3fc;background:#0c2a3f;border-radius:6px;padding:8px 10px;margin:0 0 16px">${t('itemsched.hint')}</p>
        <div>${blocks.length ? blocks.map(blockRow).join('') : `<p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">${t('itemsched.none')}</p>`}</div>
        <button class="btn btn-secondary btn-sm" id="schedAddBlock" style="margin-bottom:4px">${t('itemsched.add_block')}</button>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
          <button class="btn btn-secondary" id="schedCancel">${t('itemsched.cancel')}</button>
          <button class="btn" id="schedSave" style="background:#f59e0b;color:#000;font-weight:600;border:none">${t('itemsched.save')}</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    modal.querySelectorAll('.sched-day').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.dataset.idx, d = +btn.dataset.day;
      const set = new Set(blocks[i].days);
      if (set.has(d)) set.delete(d); else set.add(d);
      blocks[i].days = [...set];
      render();
    }));
    modal.querySelectorAll('.sched-start').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].start = el.value; }));
    modal.querySelectorAll('.sched-end').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].end = el.value; }));
    modal.querySelectorAll('.sched-eod').forEach(el => el.addEventListener('change', () => {
      blocks[+el.dataset.idx].end = el.checked ? '24:00' : '17:00';
      render();
    }));
    modal.querySelectorAll('.sched-sd').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].start_date = el.value; }));
    modal.querySelectorAll('.sched-ed').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].end_date = el.value; }));
    modal.querySelectorAll('.sched-remove').forEach(btn => btn.addEventListener('click', () => { blocks.splice(+btn.dataset.idx, 1); render(); }));
    document.getElementById('schedAddBlock').addEventListener('click', () => {
      blocks.push({ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00', start_date: '', end_date: '' });
      render();
    });
    document.getElementById('schedCancel').addEventListener('click', () => modal.remove());
    document.getElementById('schedSave').addEventListener('click', doSave);
  }

  async function doSave() {
    const payload = blocks.map(b => ({
      days: b.days, start: b.start, end: b.end,
      start_date: b.start_date || null, end_date: b.end_date || null
    }));
    const err = validateScheduleBlocks(payload);
    if (err) { showToast(err, 'error'); return; }
    try {
      await onSave(payload);
      modal.remove();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  render();
}
