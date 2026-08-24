/*
 * One file: where it reaches, and what it has done.
 *
 * A page rather than another tab in the library modal. The modal is for editing a file; this is
 * for reading about one, it is worth linking to (a play row on a screen's page points here), and
 * a chart plus three tables in a dialog on a phone is a scrollbar inside a scrollbar.
 *
 * THE DISTINCTION THE PAGE IS BUILT AROUND: the reach numbers are structural — true today, true on
 * the day the product was installed, and they do not decay. The play numbers come from a log that
 * is pruned at ninety days. Presenting them as one set of four equal tiles would invite reading a
 * zero in the second kind as "it never played" when it means "not in this window".
 */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

let state = null;

function secs(n) {
  if (!n) return '0s';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min ${n % 60}s`;
  return `${n}s`;
}

function isoBack(n) {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/*
 * The daily series, as bars.
 *
 * Inline SVG, no chart library: the whole shape needed is "which days were busy", and a dependency
 * that has to be inlined into a CSP-restricted page is a lot of weight for eleven lines.
 *
 * Days with no plays are rendered as gaps rather than skipped. A series that omits them draws a
 * flat, healthy-looking line across a week the screen was off.
 */
function chart(days, from, to) {
  if (!days.length) return '';

  const byDate = new Map(days.map((d) => [d.date, d.plays]));
  const all = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    all.push({ date: key, plays: byDate.get(key) || 0 });
    if (all.length > 400) break; // a year and a bit; beyond that the bars are thinner than a pixel
  }

  const max = Math.max(...all.map((d) => d.plays), 1);
  const w = 100 / all.length;
  const bars = all.map((d, i) => {
    const h = (d.plays / max) * 100;
    return `<rect x="${(i * w).toFixed(3)}%" y="${(100 - h).toFixed(2)}%" width="${(w * 0.8).toFixed(3)}%"
      height="${h.toFixed(2)}%" rx="1" fill="${d.plays ? 'var(--accent)' : 'transparent'}">
      <title>${esc(d.date)}: ${d.plays}</title></rect>`;
  }).join('');

  return `
    <div class="cd-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
           aria-label="${esc(t('filereport.chart_label'))}">${bars}</svg>
      <div class="cd-chart-axis"><span>${esc(all[0].date)}</span><span>${max} / ${esc(t('filereport.per_day'))}</span><span>${esc(all.at(-1).date)}</span></div>
    </div>`;
}

function reachPanel(data) {
  const lists = data.reach.playlists.map((p) => `
    <li>
      <a href="#/playlists/${esc(p.id)}">${esc(p.name)}</a>
      ${p.via ? `<span class="cd-muted">· ${esc(t('filereport.via_sublist', { list: p.via }))}</span>` : ''}
    </li>`).join('');

  const screens = data.reach.screens.map((s) => `
    <li>
      <a href="#/device/${esc(s.id)}">${esc(s.name)}</a>
      ${s.hows.includes('zone') ? `<span class="cd-muted">· ${esc(t('filereport.via_zone'))}</span>` : ''}
    </li>`).join('');

  return `
    <div class="cd-cols">
      <div class="cd-col">
        <h3>${esc(t('filereport.in_lists'))}</h3>
        ${lists ? `<ul class="cd-list">${lists}</ul>` : `<p class="cd-muted">${esc(t('filereport.in_no_list'))}</p>`}
      </div>
      <div class="cd-col">
        <h3>${esc(t('filereport.on_screens'))}</h3>
        ${screens ? `<ul class="cd-list">${screens}</ul>` : `<p class="cd-muted">${esc(t('filereport.on_no_screen'))}</p>`}
      </div>
    </div>`;
}

function playsPanel(data) {
  if (!data.totals.plays) {
    return `<div class="empty-state" style="padding:20px">
      <h3>${esc(t('filereport.no_plays'))}</h3>
      <p>${esc(t('filereport.no_plays_hint', { days: data.retention_days || 90 }))}</p>
    </div>`;
  }

  const screens = data.by_screen.map((s) => `
    <tr>
      <td><a href="#/device/${esc(s.id)}">${esc(s.name)}</a></td>
      <td>${s.plays}</td>
      <td>${esc(secs(s.seconds))}</td>
    </tr>`).join('');

  const lists = data.by_list.map((l) => `
    <tr>
      <td>${l.name
        ? esc(l.name) + (l.deleted ? ` <span class="cd-muted">· ${esc(t('filereport.list_deleted'))}</span>` : '')
        : `<span class="cd-muted" title="${esc(t('filereport.list_unknown_tip'))}">${esc(t('filereport.list_unknown'))}</span>`}</td>
      <td>${l.plays}</td>
      <td>${esc(secs(l.seconds))}</td>
    </tr>`).join('');

  return `
    ${chart(data.by_day, state.start, state.end)}
    <div class="cd-cols">
      <div class="cd-col">
        <h3>${esc(t('filereport.by_screen'))}</h3>
        <div class="cd-scroll"><table class="list-table cd-table">
          <thead><tr><th>${esc(t('filereport.col.screen'))}</th><th style="width:90px">${esc(t('filereport.col.plays'))}</th><th style="width:100px">${esc(t('filereport.col.time'))}</th></tr></thead>
          <tbody>${screens}</tbody>
        </table></div>
      </div>
      <div class="cd-col">
        <h3>${esc(t('filereport.by_list'))}</h3>
        <div class="cd-scroll"><table class="list-table cd-table">
          <thead><tr><th>${esc(t('filereport.col.list'))}</th><th style="width:90px">${esc(t('filereport.col.plays'))}</th><th style="width:100px">${esc(t('filereport.col.time'))}</th></tr></thead>
          <tbody>${lists}</tbody>
        </table></div>
      </div>
    </div>`;
}

function renderBody(data) {
  /*
   * Two rows of tiles, labelled, and never mixed. The top row is true right now; the bottom row is
   * bounded by the window and by retention, which is said in the heading above it rather than in a
   * footnote nobody reads.
   */
  const tile = (v, label) => `<div class="cd-tile"><div class="cd-tile-v">${esc(String(v))}</div><div class="cd-tile-l">${esc(label)}</div></div>`;

  return `
    <h2 class="cd-h">${esc(t('filereport.where_title'))}</h2>
    <p class="cd-sub">${esc(t('filereport.where_sub'))}</p>
    <div class="cd-tiles">
      ${tile(data.reach.playlist_count, t('filereport.tile.lists'))}
      ${tile(data.reach.screen_count, t('filereport.tile.screens'))}
    </div>
    ${reachPanel(data)}

    <h2 class="cd-h">${esc(t('filereport.plays_title'))}</h2>
    <p class="cd-sub">${esc(t('filereport.plays_sub', { start: data.window.start, end: data.window.end, days: data.retention_days || 90 }))}</p>
    <div class="cd-tiles">
      ${tile(data.totals.plays, t('filereport.tile.plays'))}
      ${tile(data.totals.days_on_air, t('filereport.tile.days'))}
      ${tile(secs(data.totals.seconds), t('filereport.tile.time'))}
    </div>
    ${playsPanel(data)}`;
}

async function load() {
  const body = document.getElementById('cdBody');
  if (!body || !state) return;
  body.innerHTML = `<div class="empty-state" style="padding:24px"><h3>${esc(t('common.loading'))}</h3></div>`;
  try {
    const q = new URLSearchParams({ start: state.start, end: state.end });
    const data = await api.getFileReport(state.contentId, q);
    if (!state) return; // navigated away mid-flight
    const title = document.getElementById('cdTitle');
    if (title) title.textContent = data.file.filename;
    body.innerHTML = renderBody(data);
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="padding:24px"><h3>${esc(t('filereport.failed'))}</h3><p>${esc(err.message)}</p></div>`;
  }
}

export async function render(container, contentId) {
  state = { contentId, start: isoBack(29), end: isoBack(0) };

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 id="cdTitle">${esc(t('common.loading'))}</h1>
        <div class="subtitle"><a href="#/content">${esc(t('filereport.back'))}</a></div>
      </div>
    </div>

    <div class="list-toolbar" style="margin:16px 0">
      <div class="form-group" style="margin:0"><label>${esc(t('report.start_date'))}</label>
        <input type="date" id="cdStart" class="input" value="${esc(state.start)}"></div>
      <div class="form-group" style="margin:0"><label>${esc(t('report.end_date'))}</label>
        <input type="date" id="cdEnd" class="input" value="${esc(state.end)}"></div>
      <button class="btn btn-secondary btn-sm" id="cdApply">${esc(t('exhibition.apply'))}</button>
      <div class="list-toolbar-end">
        <button class="btn btn-secondary btn-sm" id="cdExport">${esc(t('exhibition.export'))}</button>
      </div>
    </div>

    <div id="cdBody"></div>`;

  document.getElementById('cdApply').addEventListener('click', () => {
    // A backwards range returns nothing, which on this page reads as "this file never played" —
    // the one conclusion it must never reach by accident.
    let a = document.getElementById('cdStart').value || isoBack(29);
    let b = document.getElementById('cdEnd').value || isoBack(0);
    if (b < a) [a, b] = [b, a];
    document.getElementById('cdStart').value = a;
    document.getElementById('cdEnd').value = b;
    state.start = a;
    state.end = b;
    load();
  });

  document.getElementById('cdExport').addEventListener('click', async () => {
    // Fetched with the token rather than opened as a link: a plain href cannot send the
    // Authorization header and would save the 401 body as a .csv.
    try {
      const q = new URLSearchParams({ start: state.start, end: state.end });
      const res = await fetch(`/api/reports/file/${encodeURIComponent(state.contentId)}/export?${q}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `arquivo-${state.start}_${state.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  load();
}

export function cleanup() {
  // No timer here — but the in-flight load() checks this on the way back, so a slow response
  // cannot paint over the page the operator has already moved to.
  state = null;
}
