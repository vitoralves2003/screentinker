import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Reports — the one place in the product where play history is read.
 *
 * It used to be spread out: an always-open panel on the screen's page and a page of its own for
 * each file. Both were pages for DOING things, and a screen looping a 15-second clip makes 5,760
 * plays a day, so the analysis always ended up burying the settings above it. Xibo, OptiSigns and
 * Yodeck all keep reporting in one place; the competitor embeds it, but behind a tab — closed
 * until asked for. Ours was open by default, which is the whole difference.
 *
 * ONE page, two depths:
 *
 *   ALL — the comparative table, which is how you find the screen or the file worth looking at.
 *   ONE — that subject's own report, reached by picking it above or clicking its row.
 *
 * TWO KINDS OF NUMBER live here and the difference matters whenever one reads zero:
 *
 *   Exibições / Tempo    counted from the play log, pruned at 90 days. Zero can mean "nothing
 *                        played" or "it played before the window".
 *   Em listas / Em telas read from the current shape of things. True on day one, and they do not
 *                        decay.
 *
 * A report that cannot tell "no" from "I do not know" is one people stop trusting, so both are
 * labelled with the period they describe rather than left to be read as the same kind of fact.
 */

const TABS = ['screens', 'files', 'playlists', 'groups'];

// The subject of a detailed report. Groups have no per-subject report — a group is a way of
// selecting screens, not something that plays — so it stays comparative-only.
const DETAILED = { screens: true, files: true, playlists: true, groups: false };

/*
 * The period vocabulary, in the words an operator uses. The two bare date fields that were here
 * made the common cases — today, yesterday, last week — a calendar exercise every time.
 *
 * Resolved on the OPERATOR's clock, then resolved again server-side in the SCREEN's timezone, so
 * "hoje" means the screen's today and not the browser's. See lib/zoned-day.js.
 */
const PERIODS = ['today', 'yesterday', 'last3', 'last7', 'last15', 'last30', 'this_month', 'last_month', 'custom'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const back = (n) => iso(new Date(Date.now() - n * 86400000));

function resolvePeriod(id) {
  const now = new Date();
  const first = (y, m) => iso(new Date(y, m, 1));
  const last = (y, m) => iso(new Date(y, m + 1, 0));
  switch (id) {
    case 'today': return { start: back(0), end: back(0) };
    case 'yesterday': return { start: back(1), end: back(1) };
    case 'last3': return { start: back(2), end: back(0) };
    case 'last7': return { start: back(6), end: back(0) };
    case 'last15': return { start: back(14), end: back(0) };
    case 'last30': return { start: back(29), end: back(0) };
    case 'this_month': return { start: first(now.getFullYear(), now.getMonth()), end: back(0) };
    case 'last_month': return {
      start: first(now.getFullYear(), now.getMonth() - 1),
      end: last(now.getFullYear(), now.getMonth() - 1),
    };
    default: return null; // custom: the fields decide
  }
}

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

// Which field names a row, per tab — used to fill the subject picker from the comparative rows
// rather than fetching a second list of the same things.
const NAME_KEY = { screens: 'name', files: 'filename', playlists: 'name', groups: 'name' };

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
   * Falls back to the raw value, not to the key. t() returns the key it was given when there is no
   * translation, so an unexpected status would print "report.status.provisioning" in a cell —
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

const state = {
  tab: 'screens',
  subject: null,        // null = the comparative view
  period: 'last30',
  start: back(29),
  end: back(0),
  subjects: [],         // {id, name}, filled from the comparative rows
};

/* ------------------------------------------------------------------ the grid */

/*
 * Rows down the side, hours or days across the top.
 *
 * This replaced a chronological list of every play, which is what the screen's page used to show
 * and what the competitor's per-screen PDF still prints — fifteen pages for a single day. A grid
 * says the same thing in one screenful whatever the volume, and the play-by-play detail is a CSV
 * away for anyone who genuinely wants it.
 */
function renderMatrix(m) {
  if (!m || m.kind === 'none') {
    return `<p class="rep-note">${esc(t('report.matrix_too_long'))}</p>`;
  }
  if (!m.total) return '';

  const shade = (v) => {
    if (!v) return '';
    // Relative to the busiest cell, so the eye finds the peak without reading every number. Floored
    // well above zero: a faint tint on a cell with a real value in it reads as empty.
    const a = 0.15 + 0.55 * (v / (m.peak || 1));
    return ` style="background:color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)"`;
  };

  return `
    <div class="rep-scroll">
      <table class="rep-matrix">
        <thead><tr>
          <th class="rep-matrix-head">${esc(t(`report.matrix.${m.kind}`))}</th>
          ${m.columns.map((c) => `<th>${esc(c)}</th>`).join('')}
          <th class="rep-matrix-total">${esc(t('report.col.total'))}</th>
        </tr></thead>
        <tbody>
          ${m.rows.map((r) => `
            <tr>
              <th class="rep-matrix-head">${r.name === null
    ? esc(t('report.matrix_others', { n: r.count }))
    : esc(r.name)}</th>
              ${r.cells.map((v) => `<td${shade(v)}>${v || ''}</td>`).join('')}
              <td class="rep-matrix-total">${r.total}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <th class="rep-matrix-head">${esc(t('report.col.total'))}</th>
          ${m.col_totals.map((v) => `<td>${v || ''}</td>`).join('')}
          <td class="rep-matrix-total">${m.total}</td>
        </tr></tfoot>
      </table>
    </div>`;
}

const tile = (v, label) =>
  `<div class="rep-tile"><div class="rep-tile-v">${esc(String(v))}</div><div class="rep-tile-l">${esc(label)}</div></div>`;

function table(cols, rows, empty) {
  if (!rows.length) return `<p class="rep-note">${esc(empty)}</p>`;
  return `
    <div class="rep-scroll">
      <table class="list-table rep-table">
        <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.get(r)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

/* The name a list goes by, and the three different reasons it might not have one. */
function listName(l) {
  if (l.name) return esc(l.name);
  return `<span class="rep-muted" title="${esc(t('report.list_unknown_tip'))}">${esc(t('report.list_unknown'))}</span>`;
}

/* ------------------------------------------------------------------ detail: one screen */

function renderScreen(d) {
  const notes = [];
  if (d.timezone_assumed) notes.push(t('report.tz_assumed'));
  if (d.totals.unattributed) notes.push(t('report.unattributed', { n: d.totals.unattributed }));

  return `
    <div class="rep-tiles">
      ${tile(d.totals.plays, t('report.tile.plays'))}
      ${tile(hms(d.totals.seconds), t('report.tile.airtime'))}
      ${tile(d.totals.distinct_files, t('report.tile.files'))}
      ${tile(d.totals.distinct_widgets, t('report.tile.widgets'))}
      ${tile(d.totals.distinct_lists, t('report.tile.lists'))}
    </div>
    <p class="rep-note">${esc(t('report.times_in', { tz: d.timezone }))}${notes.length ? ' · ' + notes.map(esc).join(' · ') : ''}</p>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h3 class="rep-h">${esc(t('report.what_played'))}</h3>
        ${table(
    [
      { label: t('report.col.item'), get: (r) => esc(r.name) },
      { label: t('report.col.kind'), get: (r) => `<span class="rep-muted">${esc(kindLabel(r.kind))}</span>` },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: t('report.col.airtime'), num: true, get: (r) => hms(r.seconds) },
    ], d.by_item, t('report.empty_period'))}
      </div>
      <div>
        <h3 class="rep-h">${esc(t('report.by_kind'))}</h3>
        ${table(
    [
      { label: t('report.col.kind'), get: (r) => esc(kindLabel(r.kind)) },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: '%', num: true, get: (r) => `${r.pct}%` },
    ], d.by_kind, t('report.empty_period'))}

        <h3 class="rep-h">${esc(t('report.by_list'))}</h3>
        ${table(
    [
      { label: t('report.col.list'), get: listName },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
    ], d.by_list, t('report.empty_period'))}
      </div>
    </div>`;
}

/* The widget kinds a play can be. An unknown one prints itself rather than a key. */
function kindLabel(kind) {
  const key = `report.kind.${kind}`;
  return t(key) === key ? kind : t(key);
}

/* ------------------------------------------------------------------ detail: one file */

function renderFile(d) {
  const lists = d.reach.playlists.map((p) => `
    <li>${esc(p.name)}${p.via ? ` <span class="rep-muted">· ${esc(t('report.via_sublist', { list: p.via }))}</span>` : ''}</li>`).join('');
  const screens = d.reach.screens.map((s) => `
    <li>${esc(s.name)}${s.hows.includes('zone') ? ` <span class="rep-muted">· ${esc(t('report.via_zone'))}</span>` : ''}</li>`).join('');

  /*
   * The two halves are labelled with their own period IN the label, not only in a heading above
   * them. A screenshot of this page showed "Telas: 1" over a table listing two screens — both
   * correct (one is where the file is TODAY, the other where it PLAYED), and the headings were not
   * enough to stop it reading as a contradiction.
   */
  return `
    <h3 class="rep-h">${esc(t('report.where_now'))}</h3>
    <div class="rep-tiles">
      ${tile(d.reach.playlist_count, t('report.tile.lists_now'))}
      ${tile(d.reach.screen_count, t('report.tile.screens_now'))}
    </div>
    <div class="rep-cols">
      <div><h4 class="rep-h4">${esc(t('report.in_lists'))}</h4>
        ${lists ? `<ul class="rep-list">${lists}</ul>` : `<p class="rep-note">${esc(t('report.in_no_list'))}</p>`}</div>
      <div><h4 class="rep-h4">${esc(t('report.on_screens'))}</h4>
        ${screens ? `<ul class="rep-list">${screens}</ul>` : `<p class="rep-note">${esc(t('report.on_no_screen'))}</p>`}</div>
    </div>

    <h3 class="rep-h">${esc(t('report.what_it_played'))}</h3>
    <div class="rep-tiles">
      ${tile(d.totals.plays, t('report.tile.plays_period'))}
      ${tile(d.totals.days_on_air, t('report.tile.days'))}
      ${tile(hms(d.totals.seconds), t('report.tile.airtime'))}
      ${tile(d.by_screen.length, t('report.tile.screens_period'))}
    </div>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h4 class="rep-h4">${esc(t('report.by_screen'))}</h4>
        ${table(
    [
      { label: t('report.col.screen'), get: (r) => esc(r.name) },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: t('report.col.airtime'), num: true, get: (r) => hms(r.seconds) },
    ], d.by_screen, t('report.empty_period'))}
      </div>
      <div>
        <h4 class="rep-h4">${esc(t('report.by_list'))}</h4>
        ${table(
    [
      { label: t('report.col.list'), get: listName },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: t('report.col.airtime'), num: true, get: (r) => hms(r.seconds) },
    ], d.by_list, t('report.empty_period'))}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ detail: one list */

function renderPlaylist(d) {
  const screens = d.reach.screens.map((s) => `
    <li>${esc(s.name)}${s.hows.includes('zone') ? ` <span class="rep-muted">· ${esc(t('report.via_zone'))}</span>` : ''}</li>`).join('');

  return `
    <h3 class="rep-h">${esc(t('report.where_now'))}</h3>
    <div class="rep-tiles">
      ${tile(d.reach.screen_count, t('report.tile.screens_now'))}
      ${tile(d.reach.item_count, t('report.tile.items'))}
    </div>
    <div class="rep-cols">
      <div><h4 class="rep-h4">${esc(t('report.on_screens'))}</h4>
        ${screens ? `<ul class="rep-list">${screens}</ul>` : `<p class="rep-note">${esc(t('report.list_no_screen'))}</p>`}</div>
      <div><h4 class="rep-h4">${esc(t('report.list_holds'))}</h4>
        ${d.reach.items.length
    ? `<ul class="rep-list">${d.reach.items.map((i) => `<li>${esc(i.name || '--')}${i.kind !== 'file' ? ` <span class="rep-muted">· ${esc(kindLabel(i.kind))}</span>` : ''}</li>`).join('')}</ul>`
    : `<p class="rep-note">${esc(t('report.list_empty'))}</p>`}</div>
    </div>

    <h3 class="rep-h">${esc(t('report.what_it_broadcast'))}</h3>
    <div class="rep-tiles">
      ${tile(d.totals.plays, t('report.tile.plays_period'))}
      ${tile(hms(d.totals.seconds), t('report.tile.airtime'))}
      ${tile(d.totals.distinct_items, t('report.tile.items_played'))}
      ${tile(d.totals.distinct_screens, t('report.tile.screens_period'))}
    </div>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h4 class="rep-h4">${esc(t('report.what_played'))}</h4>
        ${table(
    [
      { label: t('report.col.item'), get: (r) => esc(r.name) },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: t('report.col.airtime'), num: true, get: (r) => hms(r.seconds) },
    ], d.by_item, t('report.empty_period'))}
      </div>
      <div>
        <h4 class="rep-h4">${esc(t('report.by_screen'))}</h4>
        ${table(
    [
      { label: t('report.col.screen'), get: (r) => esc(r.name) },
      { label: t('report.col.plays'), num: true, get: (r) => r.plays },
      { label: t('report.col.airtime'), num: true, get: (r) => hms(r.seconds) },
    ], d.by_screen, t('report.empty_period'))}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ page */

export async function render(container, params) {
  applyParams(params);

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('report.title')}</h1><div class="subtitle">${t('report.subtitle')}</div></div>
    </div>

    <div class="settings-tabs" id="reportTabs">
      ${TABS.map((id) => `<button class="settings-tab" data-tab="${id}">${esc(t(`report.tab.${id}`))}</button>`).join('')}
    </div>

    <div class="rep-toolbar">
      <label class="rep-field" id="subjectField">
        <span>${esc(t('report.subject'))}</span>
        <select id="reportSubject" class="input"></select>
      </label>
      <label class="rep-field">
        <span>${esc(t('report.period'))}</span>
        <select id="reportPeriod" class="input">
          ${PERIODS.map((p) => `<option value="${p}">${esc(t(`report.period.${p}`))}</option>`).join('')}
        </select>
      </label>
      <label class="rep-field rep-custom"><span>${esc(t('report.start_date'))}</span>
        <input type="date" id="reportStart" class="input"></label>
      <label class="rep-field rep-custom"><span>${esc(t('report.end_date'))}</span>
        <input type="date" id="reportEnd" class="input"></label>
      <div class="rep-toolbar-end">
        <button class="btn btn-secondary btn-sm" id="exportBtn">${t('report.export_csv')}</button>
      </div>
    </div>

    <div id="reportBody"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    <p id="reportNote" class="rep-note"></p>`;

  container.querySelectorAll('.settings-tab').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.tab === state.tab) return;
    state.tab = btn.dataset.tab;
    // The subject belongs to the tab it was picked in; carrying it across would ask for a file
    // report about a screen.
    state.subject = null;
    state.subjects = [];
    syncControls();
    load();
  }));

  document.getElementById('reportPeriod').addEventListener('change', (e) => {
    state.period = e.target.value;
    const r = resolvePeriod(state.period);
    if (r) { state.start = r.start; state.end = r.end; }
    syncControls();
    load();
  });

  for (const id of ['reportStart', 'reportEnd']) {
    document.getElementById(id).addEventListener('change', () => {
      // A backwards range returns nothing, which reads exactly like "this played nothing" — the
      // one conclusion this page must never reach by accident.
      let a = document.getElementById('reportStart').value || state.start;
      let b = document.getElementById('reportEnd').value || state.end;
      if (b < a) [a, b] = [b, a];
      state.start = a;
      state.end = b;
      state.period = 'custom';
      syncControls();
      load();
    });
  }

  document.getElementById('reportSubject').addEventListener('change', (e) => {
    state.subject = e.target.value || null;
    load();
  });

  document.getElementById('exportBtn').addEventListener('click', exportCsv);

  syncControls();
  load();
}

/* A deep link from a screen, a file or a list: #/reports?tab=screens&id=... */
function applyParams(params) {
  if (!params) return;
  const tab = params.get('tab');
  if (tab && TABS.includes(tab)) { state.tab = tab; state.subjects = []; }
  if (params.has('id')) state.subject = params.get('id') || null;
  const period = params.get('period');
  if (period && PERIODS.includes(period)) {
    state.period = period;
    const r = resolvePeriod(period);
    if (r) { state.start = r.start; state.end = r.end; }
  }
}

function syncControls() {
  document.querySelectorAll('.settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  document.getElementById('reportPeriod').value = state.period;
  document.getElementById('reportStart').value = state.start;
  document.getElementById('reportEnd').value = state.end;

  const custom = state.period === 'custom';
  document.querySelectorAll('.rep-custom').forEach((el) => { el.hidden = !custom; });

  const field = document.getElementById('subjectField');
  field.hidden = !DETAILED[state.tab];

  const sel = document.getElementById('reportSubject');
  sel.innerHTML = `<option value="">${esc(t(`report.all.${state.tab}`))}</option>`
    + state.subjects.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = state.subject || '';
}

const DETAIL_URL = {
  screens: (id) => `/reports/device/${encodeURIComponent(id)}/summary`,
  files: (id) => `/reports/file/${encodeURIComponent(id)}`,
  playlists: (id) => `/reports/playlist/${encodeURIComponent(id)}/summary`,
};

const EXPORT_URL = {
  screens: (id) => `/api/reports/device/${encodeURIComponent(id)}/timeline/export`,
  files: (id) => `/api/reports/file/${encodeURIComponent(id)}/export`,
  playlists: (id) => `/api/reports/playlist/${encodeURIComponent(id)}/export`,
};

const RENDER = { screens: renderScreen, files: renderFile, playlists: renderPlaylist };

function query() {
  return new URLSearchParams({ start: state.start, end: state.end }).toString();
}

async function load() {
  const body = document.getElementById('reportBody');
  const note = document.getElementById('reportNote');
  if (!body) return;
  body.innerHTML = `<div class="empty-state"><h3>${t('common.loading')}</h3></div>`;
  note.textContent = '';

  try {
    if (state.subject && DETAILED[state.tab]) {
      const data = await API(`${DETAIL_URL[state.tab](state.subject)}?${query()}`);
      const title = data.device?.name || data.file?.filename || data.playlist?.name || '';
      body.innerHTML = `
        <div class="rep-subject">
          <h2>${esc(title)}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="backToAll">${esc(t(`report.back.${state.tab}`))}</button>
        </div>
        ${RENDER[state.tab](data)}`;
      document.getElementById('backToAll').addEventListener('click', () => {
        state.subject = null;
        syncControls();
        load();
      });
      note.textContent = t('report.period_note', { start: state.start, end: state.end, days: data.retention_days });
      return;
    }

    const data = await API(`/reports/by/${state.tab}?${query()}`);

    // The picker is filled from the rows already fetched rather than from a second list of the
    // same things — one request, and the two can never be out of step with each other.
    if (DETAILED[state.tab]) {
      state.subjects = data.rows.map((r) => ({ id: r.id, name: r[NAME_KEY[state.tab]] })).filter((s) => s.id && s.name);
      syncControls();
    }

    const cols = COLUMNS[state.tab];
    if (!data.rows.length) {
      body.innerHTML = `<div class="empty-state"><h3>${t('report.empty_title')}</h3><p>${t('report.empty_desc')}</p></div>`;
    } else {
      body.innerHTML = `
        <div class="rep-scroll">
        <table class="list-table">
          <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(t(c.label))}</th>`).join('')}</tr></thead>
          <tbody>
            ${data.rows.map((r) => `<tr${DETAILED[state.tab] && r.id ? ` class="rep-row" data-id="${esc(r.id)}"` : ''}>${cols.map((c) => {
    const v = c.render ? c.render(r) : esc(String(r[c.key] ?? '—') || '—');
    const style = c.muted ? ' style="color:var(--text-secondary)"' : '';
    return `<td${c.num ? ' class="num"' : ''}${style}>${v}</td>`;
  }).join('')}</tr>`).join('')}
          </tbody>
        </table></div>`;

      // Clicking the row is the same act as picking it above; both end in the same place.
      body.querySelectorAll('.rep-row').forEach((tr) => tr.addEventListener('click', () => {
        state.subject = tr.dataset.id;
        syncControls();
        load();
      }));
    }

    note.textContent = t('report.retention_note', { days: data.retention_days });
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${esc(err.message)}</h3></div>`;
  }
}

async function exportCsv() {
  /*
   * Fetched with the token and handed over as a blob, not opened as a link: the endpoint needs an
   * Authorization header, and a plain href cannot send one — it would save the login page's 401
   * body as a .csv and look like a corrupt export.
   */
  const detail = state.subject && DETAILED[state.tab];
  const url = detail
    ? `${EXPORT_URL[state.tab](state.subject)}?${query()}`
    : `/api/reports/by/${state.tab}/export?${query()}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const objectUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `loop-player-${state.tab}${detail ? '-detalhe' : ''}-${state.start}_${state.end}.csv`;
    a.click();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function cleanup() {}
