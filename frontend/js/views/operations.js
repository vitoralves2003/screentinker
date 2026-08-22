/*
 * Operação — the page the app opens on.
 *
 * What it is for: the two questions an operator has before they have a task. "Is anything down?"
 * and "am I running out of room?" Everything else on this page would be a number they did not ask
 * for, and a number nobody asked for is what turns a landing page into wallpaper.
 *
 * The screen counts moved here from the Telas page, where they sat above the list that already
 * showed the same thing row by row. They are not duplicated back: Telas is where you ACT on a
 * screen, this is where you find out whether you need to.
 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';

/* Bytes as a person reads them. The library is measured in MB today and will be in GB soon, and a
   page that says "196418 MB" makes the reader do the division. */
function human(bytes) {
  if (!bytes || bytes < 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function statCard(label, value, tone) {
  const colour = tone ? `color:${tone}` : '';
  return `
    <div class="info-card" style="flex:1;min-width:140px">
      <div class="info-card-label">${esc(label)}</div>
      <div class="info-card-value" style="${colour}">${esc(String(value))}</div>
    </div>`;
}

function storageBlock(storage) {
  const used = human(storage.used_bytes);

  /*
   * -1 is the plan's own way of saying unlimited. Drawing a bar against it would mean inventing a
   * denominator, and a progress bar that is always at 0% of nothing tells the reader less than a
   * sentence does.
   */
  if (!storage.limit_mb || storage.limit_mb < 0) {
    return `
      <div class="info-card" style="flex:1;min-width:100%">
        <div class="info-card-label">${esc(t('ops.storage'))}</div>
        <div class="info-card-value">${esc(used)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${esc(t('ops.storage_unlimited', { plan: storage.plan || '—' }))}
        </div>
      </div>`;
  }

  const limitBytes = storage.limit_mb * 1024 * 1024;
  const pct = Math.min(100, Math.round((storage.used_bytes / limitBytes) * 100));
  // Amber from 80%, red at 95%: the point of showing this before an upload fails is that there is
  // still time to do something about it.
  const bar = pct >= 95 ? 'var(--danger,#ef4444)' : pct >= 80 ? 'var(--warning,#f0b429)' : 'var(--accent)';

  return `
    <div class="info-card" style="flex:1;min-width:100%">
      <div class="info-card-label">${esc(t('ops.storage'))}</div>
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
        <div class="info-card-value">${esc(used)}</div>
        <div style="font-size:13px;color:var(--text-muted)">
          ${esc(t('ops.storage_of', { limit: human(limitBytes), plan: storage.plan || '—' }))}
        </div>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--bg-input);margin-top:10px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${bar};border-radius:3px"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${pct}%</div>
    </div>`;
}

export const operations = {
  async render(app) {
    app.innerHTML = `
      <div class="page-header">
        <div>
          <h1>${esc(t('ops.title'))}</h1>
          <p class="page-subtitle">${esc(t('ops.subtitle'))}</p>
        </div>
      </div>
      <div id="opsBody" style="color:var(--text-muted);font-size:13px">${esc(t('common.loading'))}</div>`;

    let data;
    try {
      data = await api.getOverview();
    } catch (err) {
      document.getElementById('opsBody').textContent = err.message;
      return;
    }

    const s = data.screens;
    document.getElementById('opsBody').innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${statCard(t('ops.screens_total'), s.total)}
        ${statCard(t('ops.screens_online'), s.online, 'var(--accent)')}
        ${statCard(t('ops.screens_offline'), s.offline, s.offline ? 'var(--danger,#ef4444)' : '')}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px">
        ${statCard(t('ops.playlists'), data.library.playlists)}
        ${statCard(t('ops.files'), data.library.files)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px">
        ${storageBlock(data.storage)}
      </div>`;
  },

  cleanup() {},
};
