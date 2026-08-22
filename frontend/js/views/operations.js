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

/*
 * Screens that are offline WHILE THEY SHOULD BE OPEN.
 *
 * A bakery that closes at 19:00 has its panel offline every night, and a list that reports that
 * every night is a list people stop reading — so the night it actually breaks, its warning sits
 * among twelve identical ones. The server filters by each screen's own hours, in its own
 * timezone; this only draws the result.
 *
 * The nudge is shown rather than the block hidden: with nothing configured the list is empty for
 * a reason the reader would otherwise have to guess at.
 */
function attentionBlock(data) {
  const rows = data.attention || [];
  const unconfigured = data.hours_unconfigured || 0;
  if (!rows.length && !unconfigured) return '';

  const list = rows.map((d) => `
    <a href="#/device/${esc(d.id)}" style="display:flex;justify-content:space-between;gap:12px;
       padding:8px 0;border-bottom:1px solid var(--border);color:inherit;text-decoration:none">
      <span>${esc(d.name)}</span>
      <span style="color:var(--danger,#ef4444);font-size:12px">${esc(t('ops.attention_offline'))}</span>
    </a>`).join('');

  return `
    <div class="info-card" style="margin-top:16px">
      <div class="info-card-label">${esc(t('ops.attention'))}</div>
      ${rows.length ? `<div style="margin-top:8px">${list}</div>` : ''}
      ${unconfigured ? `<p style="font-size:12px;color:var(--text-muted);margin-top:10px">
        ${esc(t('ops.attention_unconfigured', { n: unconfigured }))}</p>` : ''}
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
      </div>
      ${attentionBlock(data)}`;
  },

  cleanup() {},
};
