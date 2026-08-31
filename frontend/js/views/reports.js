import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';

/* O estado de uma tela ou lista. Um estado que ninguem nomeou aparece como ele mesmo -- melhor que uma celula vazia, e melhor que um identificador que parece defeito. */
const STATUS = {
  'draft': 'Rascunho',
  'offline': 'Offline',
  'online': 'Online',
  'published': 'Publicada',
};

/* As especies de exibicao que um play pode ter. */
const ESPECIE = {
  'clock': 'Relógio',
  'file': 'Arquivo',
  'football': 'Futebol',
  'lottery': 'Loteria',
  'news': 'Notícias',
  'others': 'Outros',
  'weather': 'Previsão do tempo',
  'widget': 'Widget',
};

const VOLTAR = {
  'files': 'Todos os arquivos',
  'playlists': 'Todas as listas',
  'screens': 'Todas as telas',
};

const MATRIZ = {
  'day': 'Dia',
  'hour': 'Hora',
  'month': 'Mês',
  'week': 'Semana',
};

const ABA = {
  'files': 'Arquivos',
  'groups': 'Grupos',
  'playlists': 'Listas',
  'screens': 'Telas',
};

const PERIODO = {
  'custom': 'Período personalizado',
  'last15': 'Últimos 15 dias',
  'last3': 'Últimos 3 dias',
  'last30': 'Últimos 30 dias',
  'last7': 'Últimos 7 dias',
  'last_month': 'Mês passado',
  'this_month': 'Mês atual',
  'today': 'Hoje',
  'yesterday': 'Ontem',
};

const TODOS = {
  'files': 'Todos os arquivos',
  'groups': 'Todos os grupos',
  'playlists': 'Todas as listas',
  'screens': 'Todas as telas',
};

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
    { key: 'name', label: 'Tela' },
    { key: 'status', label: 'Situação', render: (r) => statusChip(r.status) },
    { key: 'group_names', label: 'Grupos', muted: true },
    { key: 'playlist_name', label: 'Lista', muted: true },
    { key: 'plays', label: 'Exibições', num: true },
    { key: 'last_play', label: 'Última exibição', muted: true, render: (r) => when(r.last_play) },
  ],
  files: [
    { key: 'filename', label: 'Arquivo' },
    { key: 'plays', label: 'Exibições', num: true },
    { key: 'in_playlists', label: 'Em listas', num: true, muted: true },
    { key: 'on_screens', label: 'Em telas', num: true, muted: true },
    { key: 'last_play', label: 'Última exibição', muted: true, render: (r) => when(r.last_play) },
  ],
  playlists: [
    { key: 'name', label: 'Lista' },
    { key: 'status', label: 'Situação', render: (r) => statusChip(r.status) },
    { key: 'items', label: 'Itens', num: true, muted: true },
    { key: 'duration_sec', label: 'Duração', num: true, muted: true, render: (r) => hms(r.duration_sec) },
    { key: 'on_screens', label: 'Em telas', num: true, muted: true },
    { key: 'plays', label: 'Exibições', num: true },
  ],
  groups: [
    { key: 'name', label: 'Grupo' },
    { key: 'screens', label: 'Telas', num: true, muted: true },
    { key: 'online', label: 'Online', num: true, muted: true },
    { key: 'plays', label: 'Exibições', num: true },
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
  /*
   * Coloured through .row-state, the same classes the screen list uses, so "offline" is red in
   * both places by construction rather than by two people remembering the same rule. It had its
   * own green-or-grey logic here and painted offline grey.
   *
   * Falls back to the raw value, not to the key: t() returns the key it was given when there is
   * no translation, so an unnamed status would print "report.status.provisioning" in a cell —
   * which reads as a broken report rather than as a state nobody has named yet.
   */
  const label = STATUS[s] || s;
  return `<span class="row-state ${esc(s)}">${esc(label)}</span>`;
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
 * says the same thing in one screenful whatever the volume.
 *
 * There is no play-by-play view behind it any more — the CSV that carried one was removed — so the
 * grid and the rankings under it are the whole answer, and they have to be complete on their own.
 */
function renderMatrix(m) {
  if (!m || m.kind === 'none') {
    return `<p class="rep-note">${esc('Este relatório não tem período definido, então não há o que representar.')}</p>`;
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
          <th class="rep-matrix-head">${esc(MATRIZ[m.kind])}</th>
          ${m.columns.map((c) => `<th>${esc(c)}</th>`).join('')}
          <th class="rep-matrix-total">${esc('Total')}</th>
        </tr></thead>
        <tbody>
          ${m.rows.map((r) => `
            <tr>
              <th class="rep-matrix-head">${r.name === null
    ? esc(`outros ${r.count}`)
    : esc(r.name)}</th>
              ${r.cells.map((v) => `<td${shade(v)}>${v || ''}</td>`).join('')}
              <td class="rep-matrix-total">${r.total}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <th class="rep-matrix-head">${esc('Total')}</th>
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
  return `<span class="rep-muted" title="${esc('Estas exibições são anteriores à versão que passou a registrar de qual lista o conteúdo veio. Não são adivinhadas.')}">${esc('lista não registrada')}</span>`;
}

/* ------------------------------------------------------------------ detail: one screen */

function renderScreen(d) {
  const notes = [];
  if (d.timezone_assumed) notes.push('esta tela nunca informou um fuso; horários exibidos em UTC');
  if (d.totals.unattributed) notes.push(`${d.totals.unattributed} sem lista registrada`);

  return `
    <div class="rep-tiles">
      ${tile(d.totals.plays, 'Exibições')}
      ${tile(d.totals.distinct_files, 'Arquivos distintos')}
      ${tile(d.totals.distinct_widgets, 'Widgets distintos')}
      ${tile(d.totals.distinct_lists, 'Listas')}
    </div>
    <p class="rep-note">${esc(`Horários em ${d.timezone}`)}${notes.length ? ' · ' + notes.map(esc).join(' · ') : ''}</p>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h3 class="rep-h">${esc('O que exibiu')}</h3>
        ${table(
    [
      { label: 'Item', get: (r) => esc(r.name) },
      { label: 'Tipo', get: (r) => `<span class="rep-muted">${esc(kindLabel(r.kind))}</span>` },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_item, 'Nada neste período.')}
      </div>
      <div>
        <h3 class="rep-h">${esc('Por tipo')}</h3>
        ${table(
    [
      { label: 'Tipo', get: (r) => esc(kindLabel(r.kind)) },
      { label: 'Exibições', num: true, get: (r) => r.plays },
      { label: '%', num: true, get: (r) => `${r.pct}%` },
    ], d.by_kind, 'Nada neste período.')}

        <h3 class="rep-h">${esc('Por lista')}</h3>
        ${table(
    [
      { label: 'Lista', get: listName },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_list, 'Nada neste período.')}
      </div>
    </div>`;
}

/* The widget kinds a play can be. An unknown one prints itself rather than a key. */
function kindLabel(kind) {
  return ESPECIE[kind] || kind;
}

/* ------------------------------------------------------------------ detail: one file */

function renderFile(d) {
  const lists = d.reach.playlists.map((p) => `
    <li>${esc(p.name)}${p.via ? ` <span class="rep-muted">· ${esc(`através de ${p.via}`)}</span>` : ''}</li>`).join('');
  const screens = d.reach.screens.map((s) => `
    <li>${esc(s.name)}${s.hows.includes('zone') ? ` <span class="rep-muted">· ${esc('em uma zona')}</span>` : ''}</li>`).join('');

  /*
   * The two halves are labelled with their own period IN the label, not only in a heading above
   * them. A screenshot of this page showed "Telas: 1" over a table listing two screens — both
   * correct (one is where the file is TODAY, the other where it PLAYED), and the headings were not
   * enough to stop it reading as a contradiction.
   */
  return `
    <h3 class="rep-h">${esc('Onde está hoje')}</h3>
    <div class="rep-tiles">
      ${tile(d.reach.playlist_count, 'Listas em que está hoje')}
      ${tile(d.reach.screen_count, 'Telas que exibem hoje')}
    </div>
    <div class="rep-cols">
      <div><h4 class="rep-h4">${esc('Nestas listas')}</h4>
        ${lists ? `<ul class="rep-list">${lists}</ul>` : `<p class="rep-note">${esc('Este arquivo não está em nenhuma lista, então nenhuma tela o exibe.')}</p>`}</div>
      <div><h4 class="rep-h4">${esc('Nestas telas')}</h4>
        ${screens ? `<ul class="rep-list">${screens}</ul>` : `<p class="rep-note">${esc('Nenhuma tela roda uma lista com este arquivo.')}</p>`}</div>
    </div>

    <h3 class="rep-h">${esc('O que exibiu no período')}</h3>
    <div class="rep-tiles">
      ${tile(d.totals.plays, 'Exibições no período')}
      ${tile(d.totals.days_on_air, 'Dias no ar')}
      ${tile(d.by_screen.length, 'Telas em que exibiu')}
    </div>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h4 class="rep-h4">${esc('Por tela')}</h4>
        ${table(
    [
      { label: 'Tela', get: (r) => esc(r.name) },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_screen, 'Nada neste período.')}
      </div>
      <div>
        <h4 class="rep-h4">${esc('Por lista')}</h4>
        ${table(
    [
      { label: 'Lista', get: listName },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_list, 'Nada neste período.')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ detail: one list */

function renderPlaylist(d) {
  const screens = d.reach.screens.map((s) => `
    <li>${esc(s.name)}${s.hows.includes('zone') ? ` <span class="rep-muted">· ${esc('em uma zona')}</span>` : ''}</li>`).join('');

  return `
    <h3 class="rep-h">${esc('Onde está hoje')}</h3>
    <div class="rep-tiles">
      ${tile(d.reach.screen_count, 'Telas que exibem hoje')}
      ${tile(d.reach.item_count, 'Itens na lista')}
    </div>
    <div class="rep-cols">
      <div><h4 class="rep-h4">${esc('Nestas telas')}</h4>
        ${screens ? `<ul class="rep-list">${screens}</ul>` : `<p class="rep-note">${esc('Nenhuma tela está rodando esta lista.')}</p>`}</div>
      <div><h4 class="rep-h4">${esc('Ela contém')}</h4>
        ${d.reach.items.length
    ? `<ul class="rep-list">${d.reach.items.map((i) => `<li>${esc(i.name || '--')}${i.kind !== 'file' ? ` <span class="rep-muted">· ${esc(kindLabel(i.kind))}</span>` : ''}</li>`).join('')}</ul>`
    : `<p class="rep-note">${esc('Esta lista está vazia.')}</p>`}</div>
    </div>

    <h3 class="rep-h">${esc('O que veiculou no período')}</h3>
    <div class="rep-tiles">
      ${tile(d.totals.plays, 'Exibições no período')}
      ${tile(d.totals.distinct_items, 'Itens que exibiram')}
      ${tile(d.totals.distinct_screens, 'Telas em que exibiu')}
    </div>

    ${renderMatrix(d.matrix)}

    <div class="rep-cols">
      <div>
        <h4 class="rep-h4">${esc('O que exibiu')}</h4>
        ${table(
    [
      { label: 'Item', get: (r) => esc(r.name) },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_item, 'Nada neste período.')}
      </div>
      <div>
        <h4 class="rep-h4">${esc('Por tela')}</h4>
        ${table(
    [
      { label: 'Tela', get: (r) => esc(r.name) },
      { label: 'Exibições', num: true, get: (r) => r.plays },
    ], d.by_screen, 'Nada neste período.')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ page */

export async function render(container, params) {
  applyParams(params);

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Relatórios</h1><div class="subtitle">Análise de exibição e disponibilidade dos dispositivos</div></div>
    </div>

    <div class="settings-tabs" id="reportTabs">
      ${TABS.map((id) => `<button class="settings-tab" data-tab="${id}">${esc(ABA[id])}</button>`).join('')}
    </div>

    <div class="rep-toolbar">
      <label class="rep-field" id="subjectField">
        <span>${esc('Assunto')}</span>
        <select id="reportSubject" class="input"></select>
      </label>
      <label class="rep-field">
        <span>${esc('Período')}</span>
        <select id="reportPeriod" class="input">
          ${PERIODS.map((p) => `<option value="${p}">${esc(PERIODO[p])}</option>`).join('')}
        </select>
      </label>
      <label class="rep-field rep-custom"><span>${esc('Data de início')}</span>
        <input type="date" id="reportStart" class="input"></label>
      <label class="rep-field rep-custom"><span>${esc('Data de fim')}</span>
        <input type="date" id="reportEnd" class="input"></label>
      <div class="rep-toolbar-end">
        <button class="btn btn-secondary btn-sm" id="exportPdfBtn" hidden>Exportar PDF</button>
      </div>
    </div>

    <div id="reportBody"><div class="empty-state"><h3>Carregando...</h3></div></div>
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

  document.getElementById('exportPdfBtn').addEventListener('click', exportPdf);

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

  const pdf = document.getElementById('exportPdfBtn');
  if (pdf) pdf.hidden = !(state.subject && PDF_TYPE[state.tab]);

  const field = document.getElementById('subjectField');
  field.hidden = !DETAILED[state.tab];

  const sel = document.getElementById('reportSubject');
  sel.innerHTML = `<option value="">${esc(TODOS[state.tab])}</option>`
    + state.subjects.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = state.subject || '';
}

const DETAIL_URL = {
  screens: (id) => `/reports/device/${encodeURIComponent(id)}/summary`,
  files: (id) => `/reports/file/${encodeURIComponent(id)}`,
  playlists: (id) => `/reports/playlist/${encodeURIComponent(id)}/summary`,
};

const RENDER = { screens: renderScreen, files: renderFile, playlists: renderPlaylist };

// The subject a PDF is about, in the words the server route uses.
const PDF_TYPE = { screens: 'screen', files: 'file', playlists: 'playlist' };

function query() {
  return new URLSearchParams({ start: state.start, end: state.end }).toString();
}

async function load() {
  const body = document.getElementById('reportBody');
  const note = document.getElementById('reportNote');
  if (!body) return;
  body.innerHTML = `<div class="empty-state"><h3>Carregando...</h3></div>`;
  note.textContent = '';

  try {
    if (state.subject && DETAILED[state.tab]) {
      const data = await API(`${DETAIL_URL[state.tab](state.subject)}?${query()}`);
      const title = data.device?.name || data.file?.filename || data.playlist?.name || '';
      body.innerHTML = `
        <div class="rep-subject">
          <h2>${esc(title)}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="backToAll">${esc(VOLTAR[state.tab])}</button>
        </div>
        ${RENDER[state.tab](data)}`;
      document.getElementById('backToAll').addEventListener('click', () => {
        state.subject = null;
        syncControls();
        load();
      });
      note.textContent = `De ${state.start} a ${state.end}. O histórico é mantido por ${data.retention_days} dias.`;
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
      body.innerHTML = `<div class="empty-state"><h3>Nada no período</h3><p>Mude as datas ou escolha outra aba.</p></div>`;
    } else {
      body.innerHTML = `
        <div class="rep-scroll">
        <table class="list-table">
          <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc((c.label))}</th>`).join('')}</tr></thead>
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

    note.textContent = `Exibições contam os últimos ${data.retention_days} dias — o histórico mais antigo é descartado. As colunas "Em listas", "Em telas" e "Telas" descrevem como está hoje e não dependem desse período.`;
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${esc(err.message)}</h3></div>`;
  }
}

async function exportPdf() {
  /*
   * Every PDF is recorded as it is handed over and carries the code of that record, so this is not
   * a pure download — it writes a row. Fetched with the token rather than opened as a link: an
   * <a href> cannot send the Authorization header and would save the 401 body as a .pdf.
   */
  try {
    const res = await fetch(`/api/reports/pdf/${PDF_TYPE[state.tab]}/${encodeURIComponent(state.subject)}?${query()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-${state.tab}-${state.start}_${state.end}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function cleanup() {}
