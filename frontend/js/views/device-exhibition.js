/*
 * "O que essa tela exibiu" — the exhibition section of a screen's page.
 *
 * Its own file rather than more of device-detail.js, which is already 2,700 lines: this owns a
 * timer and a fetch cycle, and mixing those into a page that also owns a socket, a remote session
 * and a debug stream is how one of them ends up not being cleaned up.
 *
 * What it will not do:
 *   - show a list for a play that did not record one (see lib/exhibition.js)
 *   - render times in the operator's clock. Every time on this panel is the SCREEN's local time,
 *     said out loud in the header, because the answer is meaningless without it.
 */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

// While "em tempo real" is on. Long enough not to hammer a page that is often left open, short
// enough that a play landing while somebody watches shows up before they give up on it.
const LIVE_MS = 30000;

let timer = null;
let state = null;

function secs(n) {
  if (!n) return '0s';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min ${s}s`;
  return `${s}s`;
}

/*
 * How a play names its list — three outcomes, three different sentences.
 *
 * Collapsing these into one empty cell is the failure this whole feature exists to avoid: "we did
 * not record it", "the list was deleted since" and "here it is" are not the same statement, and
 * only the last one is safe to show a customer as proof.
 */
function listLabel(it) {
  if (it.playlist_name && !it.playlist_deleted) return esc(it.playlist_name);
  if (it.playlist_deleted) {
    return `<span class="exh-muted" title="${esc(t('exhibition.list_deleted_tip'))}">${esc(it.playlist_name)} · ${esc(t('exhibition.list_deleted'))}</span>`;
  }
  return `<span class="exh-muted" title="${esc(t('exhibition.list_unknown_tip'))}">${esc(t('exhibition.list_unknown'))}</span>`;
}

function renderDay(day) {
  const chips = day.lists.map((l) => {
    const name = l.playlist_name
      ? esc(l.playlist_name) + (l.playlist_deleted ? ` · ${esc(t('exhibition.list_deleted'))}` : '')
      : esc(t('exhibition.list_unknown'));
    return `<span class="exh-chip">${name} <b>${l.plays}</b></span>`;
  }).join('');

  return `
    <div class="exh-day">
      <div class="exh-day-head">
        <span class="exh-day-date">${esc(day.date)}</span>
        <span class="exh-muted">${day.plays} · ${esc(secs(day.seconds))}</span>
        <span class="exh-chips">${chips}</span>
      </div>
      <div class="exh-scroll">
        <table class="list-table exh-table">
          <thead><tr>
            <th style="width:74px">${esc(t('exhibition.col.time'))}</th>
            <th>${esc(t('exhibition.col.file'))}</th>
            <th style="width:30%">${esc(t('exhibition.col.list'))}</th>
            <th style="width:90px">${esc(t('exhibition.col.duration'))}</th>
          </tr></thead>
          <tbody>
            ${day.items.map((it) => `
              <tr>
                <td>${esc(it.time)}</td>
                <td>${it.content_id
                  ? `<a href="#/content/${esc(it.content_id)}">${esc(it.content_name || '--')}</a>`
                  : esc(it.content_name || '--')}${it.zone_id ? ` <span class="exh-muted">· ${esc(it.zone_id)}</span>` : ''}</td>
                <td>${listLabel(it)}</td>
                <td>${esc(secs(it.duration_sec))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderBody(data) {
  if (!data.totals.plays) {
    /*
     * An empty window has two meanings and the page must not pick one. Ninety days back it is
     * "nothing played"; further back it is "this was pruned" — and a screen that has genuinely
     * shown nothing all week is exactly what an operator opens this section to find out.
     */
    return `<div class="empty-state" style="padding:24px">
      <h3>${esc(t('exhibition.empty'))}</h3>
      <p>${esc(t('exhibition.empty_hint', { days: data.retention_days || 90 }))}</p>
    </div>`;
  }

  const tiles = [
    [t('exhibition.total.plays'), data.totals.plays],
    [t('exhibition.total.time'), secs(data.totals.seconds)],
    [t('exhibition.total.files'), data.totals.distinct_files],
    [t('exhibition.total.lists'), data.totals.distinct_lists],
  ].map(([label, v]) => `<div class="exh-tile"><div class="exh-tile-v">${esc(String(v))}</div><div class="exh-tile-l">${esc(label)}</div></div>`).join('');

  const notes = [];
  if (data.truncated) notes.push(t('exhibition.truncated', { n: data.limit }));
  // The size of the gap, stated. It shrinks on its own as history accrues, and saying nothing
  // would let an operator read a partial answer as a complete one.
  if (data.totals.unattributed) notes.push(t('exhibition.unattributed', { n: data.totals.unattributed }));
  if (data.timezone_assumed) notes.push(t('exhibition.tz_assumed'));

  return `
    <div class="exh-tiles">${tiles}</div>
    ${notes.length ? `<p class="exh-note">${notes.map(esc).join(' · ')}</p>` : ''}
    ${data.days.map(renderDay).join('')}`;
}

async function load({ quiet = false } = {}) {
  const body = document.getElementById('exhBody');
  if (!body || !state) return; // navigated away mid-flight

  if (!quiet) body.innerHTML = `<div class="empty-state" style="padding:24px"><h3>${esc(t('common.loading'))}</h3></div>`;
  try {
    const q = new URLSearchParams({ start: state.start, end: state.end });
    const data = await api.getDeviceTimeline(state.deviceId, q);
    if (!state) return;
    state.timezone = data.timezone;

    const tzEl = document.getElementById('exhTz');
    if (tzEl) tzEl.textContent = t('exhibition.times_in', { tz: data.timezone });

    body.innerHTML = renderBody(data);
  } catch (err) {
    // A failed refresh must not wipe a panel that is already showing something readable — on the
    // live poll it would blank the page every time the connection hiccuped.
    if (quiet) return;
    body.innerHTML = `<div class="empty-state" style="padding:24px"><h3>${esc(t('exhibition.failed'))}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function setLive(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!on) return;
  timer = setInterval(() => load({ quiet: true }), LIVE_MS);
}

/* 'YYYY-MM-DD', n days back from today on the OPERATOR's clock — see the note in mount(). */
function isoBack(n) {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function renderExhibitionSection() {
  return `
    <div class="device-section" id="tab-exhibition">
      <div class="device-section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>
        </svg>
        ${esc(t('exhibition.title'))}
        <span id="exhTz" class="exh-muted" style="font-weight:400;font-size:12px;margin-left:auto"></span>
      </div>

      <div class="exh-controls">
        <div class="exh-presets" id="exhPresets">
          <button type="button" class="btn btn-secondary btn-sm active" data-days="0">${esc(t('exhibition.range.today'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-days="6">${esc(t('exhibition.range.7d'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-days="29">${esc(t('exhibition.range.30d'))}</button>
        </div>
        <input type="date" id="exhStart" class="input exh-date">
        <input type="date" id="exhEnd" class="input exh-date">
        <button type="button" class="btn btn-secondary btn-sm" id="exhApply">${esc(t('exhibition.apply'))}</button>
        <label class="exh-live"><input type="checkbox" id="exhLive"> ${esc(t('exhibition.live'))}</label>
        <button type="button" class="btn btn-secondary btn-sm" id="exhExport">${esc(t('exhibition.export'))}</button>
      </div>

      <div id="exhBody"></div>
    </div>`;
}

export function mountExhibition(deviceId) {
  const section = document.getElementById('tab-exhibition');
  if (!section) return;

  /*
   * The date inputs open on the OPERATOR's today, because that is the calendar in front of them.
   * The SERVER then resolves those dates in the screen's zone, so a screen fourteen hours ahead
   * still returns its own day rather than a window sliced out of two. The header says which zone
   * the times came back in.
   */
  const today = isoBack(0);
  state = { deviceId, start: today, end: today, timezone: null };

  const startEl = document.getElementById('exhStart');
  const endEl = document.getElementById('exhEnd');
  startEl.value = state.start;
  endEl.value = state.end;

  section.querySelectorAll('#exhPresets button').forEach((btn) => btn.addEventListener('click', () => {
    section.querySelectorAll('#exhPresets button').forEach((b) => b.classList.toggle('active', b === btn));
    state.start = isoBack(Number(btn.dataset.days));
    state.end = today;
    startEl.value = state.start;
    endEl.value = state.end;
    load();
  }));

  document.getElementById('exhApply').addEventListener('click', () => {
    // A backwards range returns nothing and looks like "this screen played nothing", so it is
    // straightened out here rather than silently obeyed.
    let a = startEl.value || today;
    let b = endEl.value || a;
    if (b < a) [a, b] = [b, a];
    startEl.value = a;
    endEl.value = b;
    state.start = a;
    state.end = b;
    section.querySelectorAll('#exhPresets button').forEach((x) => x.classList.remove('active'));
    load();
  });

  document.getElementById('exhLive').addEventListener('change', (e) => setLive(e.target.checked));

  document.getElementById('exhExport').addEventListener('click', async () => {
    /*
     * Fetched with the token and handed over as a blob, not opened as a link: the endpoint needs
     * an Authorization header, and a plain href cannot send one — it would save the 401 body as a
     * .csv and look like a corrupt export.
     */
    try {
      const q = new URLSearchParams({ start: state.start, end: state.end });
      const res = await fetch(`/api/reports/device/${encodeURIComponent(deviceId)}/timeline/export?${q}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `exibicoes-${state.start}_${state.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  load();
}

export function cleanupExhibition() {
  if (timer) { clearInterval(timer); timer = null; }
  state = null;
}
