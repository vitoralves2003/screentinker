/*
 * A one-field prompt, in the product's own clothes.
 *
 * Nine views still call the browser's prompt(). It is an unstyled grey box with the ORIGIN printed
 * across the top — "player.loopplayer.com.br diz" — which is the one piece of chrome no product can
 * restyle, and it lands in the middle of a dark dashboard looking like a phishing attempt. It also
 * blocks the main thread, cannot be dismissed with a click outside, and has no validation.
 *
 * Kept deliberately small: one label, one field, two buttons. Anything needing more than that wants
 * a modal of its own, not an option added here.
 *
 * Resolves to the trimmed string, or null when cancelled — the same contract prompt() has, so a
 * call site converts by adding `await`.
 */

import { t } from '../i18n.js';
import { esc } from '../utils.js';

export function showPrompt({ title, label, value = '', placeholder = '', confirmLabel, maxLength = 120 } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3>${esc(title || '')}</h3>
        </div>
        <div class="modal-body">
          <div class="form-group">
            ${label ? `<label for="promptInput">${esc(label)}</label>` : ''}
            <input type="text" id="promptInput" class="input" maxlength="${maxLength}"
                   value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="promptCancel">${esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" id="promptOk">${esc(confirmLabel || t('common.save'))}</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const input = overlay.querySelector('#promptInput');
    input.focus();
    input.select();

    /* Settled once. Enter and the OK button can both fire, and a Promise that resolves twice hides
       the second answer instead of reporting it. */
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const submit = () => {
      const v = input.value.trim();
      close(v === '' ? null : v);   // empty is a cancel, exactly as prompt() treats it
    };

    function onKey(e) {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); submit(); }
    }

    overlay.querySelector('#promptOk').addEventListener('click', submit);
    overlay.querySelector('#promptCancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}
