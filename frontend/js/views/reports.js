import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Reports, by type.
 *
 * The page that was here reported one thing — plays per screen — and was not in the menu. What an
 * operator actually asks is a set of related questions that differ by SUBJECT, not by filter: how
 * are my screens doing, which files are earning their place, which lists are on air, how big is
 * each group. So the page is four tabs over one endpoint shape.
 *
 * TWO KINDS OF NUMBER live side by side here, and the difference matters when a column reads zero:
 *
 *   Exibições / Tempo   counted from the play log, which is pruned at 90 days. A zero can mean
 *                       "nothing played" or "it played before the window".
 *   Em listas / Em telas / Telas
 *                       read from the current shape of things. They are true on day one and never
 *                       decay.
 *
 * The retention line under the table says so, because a report that cannot distinguish "no" from
 * "I do not know" is a report people stop trusting.
 */

const TABS = ['screens', 'files', 'playlists', 'groups'];

// Column -> how to read it, and how to draw it. `num` right-aligns; `muted` is for the structural
// counts, so they read as facts about the setup rather than as measurements.
const COLUMNS = {
  screens: [
    { key: 'name', label: 'report.col.screen' },
    { key: 'status', label: 'report.col.status', render: (r) => statusChip(r.status) },
    { key: 'group_names', label: 'report.col.groups', muted: true },
    { key: 'playlist_name', label: 'report.col.playlist', muted: true },
    { key: 'plays', label: 'report.col.plays', num: true },
    { key: 'seconds', label: 'report.col.airtime', num: true, render: (r) => hms(r.seconds) },
    { key: 'last_play', label: 'report.col.last_play', muted: true, render: (r) => when(r.last_play) },
  ],
  files: [
    { key: 'filename', label: 'report.col.file' },
    { key: 'plays', label: 'report.col.plays', num: true },
    { key: 'seconds', label: 'report.col.airtime', num: true, render: (r) => hms(r.seconds) },
    { key: 'in_playlists', label: 'report.col.in_playlists', num: true, muted: true },
    { key: 'on_screens', label: 'report.col.on_screens', num: true, muted: true },
    { key: 'last_play', label: 'report.col.last_play', muted: true, render: (r) => when(r.last_play) },
  ],
  playlists: [
    { key: 'name', label: 'report.col.playlist' },
    { key: 'status', label: 'report.col.status', render: (r) => statusChip(r.status) },
    { key: 'items', label: 'report.col.items', num: true, muted: true },
    { key: 'duration_sec', label: 'report.col.length', num: true, muted: true, render: (r) => hms(r.duration_sec) },
    { key: 'on_screens', label: 'report.col.on_screens', num: true, muted: true },
    { key: 'plays', label: 'report.col.plays', num: true },
    { key: 'seconds', label: 'report.col.airtime', num: true, render: (r) => hms(r.seconds) },
  ],
  groups: [
    { key: 'name', label: 'report.col.group' },
    { key: 'screens', label: 'report.col.screens', num: true, muted: true },
    { key: 'online', label: 'report.col.online', num: true, muted: true },
    { key: 'plays', label: 'report.col.plays', num: true },
  ],
};

function hms(sec) {
  const n = Number(sec) || 0;
  if (!n) return '—';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h ${m}min` : `${m}min`;
}

function when(epoch) {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusChip(s) {
  if (!s) return '—';
  const on = s === 'online' || s === 'published';
  /*
   * Falls back to the raw value, not to the key. t() returns the key it was given when there is
   * no translation, so an unexpected status would print "report.status.provisioning" in a cell —
   * which looks like a bug in the report rather than a status nobody has named yet.
   */
  const key = `report.status.${s}`;
  const label = t(key) === key ? s : t(key);
  return `<span style="color:${on ? 'var(--success)' : 'var(--text-muted)'}">${esc(label)}</span>`;
}

const API = (url) => fetch('/api' + url, {
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
}).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

let activeTab = 'screens';

export async function render(container) {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().split('T')[0];

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('report.title')}</h1><div class="subtitle">${t('report.subtitle')}</div></div>
    </div>

    <div class="settings-tabs" id="reportTabs">
      ${TABS.map((id) => `<button class="settings-tab${id === activeTab ? ' active' : ''}" data-tab="${id}">${esc(t(`report.tab.${id}`))}</button>`).join('')}
    </div>

    <div class="list-toolbar" style="margin:16px 0">
      <div class="form-group" style="margin:0"><label>${t('report.start_date')}</label>
        <input type="date" id="reportStart" class="input" value="${iso(monthAgo)}"></div>
      <div class="form-group" style="margin:0"><label>${t('report.end_date')}</label>
        <input type="date" id="reportEnd" class="input" value="${iso(today)}"></div>
      <button class="btn btn-primary btn-sm" id="loadReportBtn">${t('report.load_report')}</button>
      <div class="list-toolbar-end">
        <button class="btn btn-secondary btn-sm" id="exportBtn">${t('report.export_csv')}</button>
      </div>
    </div>

    <div id="reportBody"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    <p id="reportNote" style="font-size:12px;color:var(--text-muted);margin-top:12px"></p>`;

  container.querySelectorAll('.settings-tab').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.tab === activeTab) return;
    activeTab = btn.dataset.tab;
    container.querySelectorAll('.settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    load();
  }));

  document.getElementById('loadReportBtn').addEventListener('click', load);

  document.getElementById('exportBtn').addEventListener('click', async () => {
    /*
     * Fetched with the token and handed over as a blob, not opened as a link: the endpoint needs
     * an Authorization header, and a plain href cannot send one — it would download the login
     * page's 401 body as a .csv and look like a corrupt export.
     */
    try {
      const res = await fetch(`/api/reports/by/${activeTab}/export?${query()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `loop-player-${activeTab}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  load();
}

function query() {
  const start = document.getElementById('reportStart')?.value || '';
  const end = document.getElementById('reportEnd')?.value || '';
  return new URLSearchParams({ start, end }).toString();
}

async function load() {
  const body = document.getElementById('reportBody');
  const note = document.getElementById('reportNote');
  body.innerHTML = `<div class="empty-state"><h3>${t('common.loading')}</h3></div>`;

  let data;
  try {
    data = await API(`/reports/by/${activeTab}?${query()}`);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${esc(err.message)}</h3></div>`;
    return;
  }

  const cols = COLUMNS[activeTab];
  if (!data.rows.length) {
    body.innerHTML = `<div class="empty-state"><h3>${t('report.empty_title')}</h3><p>${t('report.empty_desc')}</p></div>`;
  } else {
    body.innerHTML = `
      <div class="table-wrap">
      <table class="list-table">
        <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(t(c.label))}</th>`).join('')}</tr></thead>
        <tbody>
          ${data.rows.map((r) => `<tr>${cols.map((c) => {
    const v = c.render ? c.render(r) : esc(String(r[c.key] ?? '—') || '—');
    const style = c.muted ? ' style="color:var(--text-secondary)"' : '';
    return `<td${c.num ? ' class="num"' : ''}${style}>${v}</td>`;
  }).join('')}</tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  // Which numbers decay and which do not — see the header of this file.
  note.textContent = t('report.retention_note', { days: data.retention_days });
}

export function cleanup() {}
