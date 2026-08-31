import { esc } from './utils.js';

/*
 * Selection + batch toolbar, shared by the three list pages (content, playlists, screens).
 *
 * WHY THIS EXISTS AS A MODULE. The content library already solved this once (#212/#213): a Set of
 * ids, a toolbar that appears only when something is selected, shift-click to select a range, and
 * a select-all that means "all VISIBLE", not "all in the database". Rewriting that twice more
 * would produce three subtly different behaviours — and the subtle differences are exactly what
 * makes an operator delete the wrong thing. One implementation, three callers.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never issues a request. Each page owns its actions, because
 * "delete" means something different on each and the confirmation cost is different too.
 */

/*
 * Selection state for one page. `order` is the ids currently on screen, in display order — it is
 * what makes shift-click mean "the range I can see" rather than a range through hidden items.
 */
export function createSelection() {
  return { ids: new Set(), lastClicked: null, order: [] };
}

/* The checkbox cell for a row. Stops propagation so ticking never opens the row. */
export function selectCell(sel, id) {
  return `<td class="bulk-cell" onclick="event.stopPropagation()">
    <input type="checkbox" class="bulk-check" data-bulk-id="${esc(id)}"
           ${sel.ids.has(id) ? 'checked' : ''} aria-label="${esc('Selecionar item')}">
  </td>`;
}

/* The header checkbox: checked only when EVERY visible row is selected. */
export function selectHeaderCell(sel) {
  const all = sel.order.length > 0 && sel.order.every((id) => sel.ids.has(id));
  return `<th class="bulk-cell">
    <input type="checkbox" id="bulkCheckAll" ${all ? 'checked' : ''}
           aria-label="${esc('Selecionar todos os visíveis')}">
  </th>`;
}

/*
 * Wire the checkboxes inside `root`. `onChange` re-renders; it is the caller's job because only
 * the caller knows how to redraw its own table.
 *
 * Shift-click extends from the last box clicked, applying the NEW state of the clicked box across
 * the range — so shift-clicking an unticked box within a selected block clears that block, which
 * is what every file manager does and therefore what an operator expects.
 */
export function wireSelection(root, sel, onChange) {
  root.querySelectorAll('.bulk-check').forEach((cb) => {
    cb.addEventListener('click', (e) => {
      const id = cb.dataset.bulkId;
      if (e.shiftKey && sel.lastClicked) {
        const a = sel.order.indexOf(sel.lastClicked);
        const b = sel.order.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) {
            if (cb.checked) sel.ids.add(sel.order[i]); else sel.ids.delete(sel.order[i]);
          }
        }
      } else if (cb.checked) {
        sel.ids.add(id);
      } else {
        sel.ids.delete(id);
      }
      sel.lastClicked = id;
      onChange();
    });
  });

  const all = root.querySelector('#bulkCheckAll');
  if (all) {
    all.addEventListener('click', () => {
      // "All" is always all VISIBLE. A select-all that silently reached rows on another page, or
      // filtered out of view, is how a bulk delete takes something nobody looked at.
      const everyOne = sel.order.every((id) => sel.ids.has(id));
      sel.order.forEach((id) => { if (everyOne) sel.ids.delete(id); else sel.ids.add(id); });
      onChange();
    });
  }
}

/*
 * The toolbar. `actions` is a list of { id, label, kind, confirm, run } — `kind` picks the button
 * style, `confirm` makes the button ask once before acting.
 *
 * Destructive actions confirm IN PLACE rather than through a modal: the count is right there in
 * the label, and a dialog that always says "are you sure?" trains people to click through it.
 */
export function renderBulkBar(bar, sel, actions, onChange) {
  if (!bar) return;
  const count = sel.ids.size;
  if (count === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

  bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;'
    + 'padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)';
  bar.innerHTML = `
    <strong style="font-size:13px">${esc(`${count} selecionado(s)`)}</strong>
    <button class="btn btn-secondary btn-sm" id="bulkClear">${esc('Limpar seleção')}</button>
    <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap">
      ${actions.map((a) => a.html
        ? a.html(count)
        : `<button class="btn btn-${a.kind || 'secondary'} btn-sm" data-bulk-action="${esc(a.id)}">${esc(a.label(count))}</button>`
      ).join('')}
    </div>`;

  bar.querySelector('#bulkClear').onclick = () => { sel.ids.clear(); sel.lastClicked = null; onChange(); };

  for (const action of actions) {
    const btn = bar.querySelector(`[data-bulk-action="${action.id}"]`);
    if (!btn) { if (action.wire) action.wire(bar, [...sel.ids]); continue; }
    btn.onclick = async () => {
      const ids = [...sel.ids];
      if (action.confirm && btn.dataset.confirming !== 'true') {
        btn.dataset.confirming = 'true';
        btn.textContent = action.confirmLabel ? action.confirmLabel(ids.length) : 'Confirmar';
        // Times out back to the safe label: a half-pressed destructive button left on screen is a
        // trap for whoever walks up to the machine next.
        setTimeout(() => {
          if (btn.dataset.confirming !== 'true') return;
          btn.dataset.confirming = 'false';
          btn.textContent = action.label(ids.length);
        }, 3000);
        return;
      }
      btn.disabled = true;
      try { await action.run(ids); } finally { btn.disabled = false; }
    };
  }
}

/*
 * Run a per-item operation across a selection when there is no batch endpoint.
 *
 * Sequential on purpose: these are writes, and firing N of them at once at a server that also has
 * players polling it is how a bulk action becomes an outage. Reports what actually happened rather
 * than assuming success — a partial failure the operator is not told about is worse than a refusal.
 */
export async function runEach(ids, fn) {
  const failed = [];
  for (const id of ids) {
    try { await fn(id); } catch (e) { failed.push({ id, message: e.message }); }
  }
  return { ok: ids.length - failed.length, failed };
}
