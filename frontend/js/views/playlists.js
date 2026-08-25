import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { t, tn } from '../i18n.js';
import { createSelection, selectCell, selectHeaderCell, wireSelection, renderBulkBar, runEach } from '../bulk-select.js';
import { frameDeviceOutput, displayAspectRatio } from '../lib/device-frame.js';

// One selection for the index; the same mechanics the content library uses.
const plSel = createSelection();

// Free-text filter for the index, kept across reloads of the list within a visit.
let searchTerm = '';

/* Seconds -> H:MM:SS, the way a playlist's length is read out loud. */
function formatDuration(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatDate(ts) {
  if (!ts) return '--';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getTypeIcon(item) {
  if (item.widget_id) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>';
  if (item.mime_type && item.mime_type.startsWith('video/')) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
}

// The schedule helpers moved to ../schedule-validate.js when the per-item editor left this view.
// They were used by BOTH, and leaving a copy behind is how the two drift apart.
let currentPlaylistId = null;

export function render(container) {
  const hash = window.location.hash;
  const match = hash.match(/#\/playlists\/(.+)/);
  if (match) {
    currentPlaylistId = match[1];
    renderDetail(container, match[1]);
  } else {
    currentPlaylistId = null;
    renderList(container);
  }
}

export function cleanup() {
  currentPlaylistId = null;
}

// Auto-generated playlists are always listed; the flag is gone rather than pinned to true so
// nothing can quietly hide them again.

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('playlist.title')}</h1>
        <div class="subtitle">${t('playlist.subtitle')}</div>
      </div>
      <button class="btn btn-primary" id="createPlaylistBtn">${t('playlist.new_playlist_btn')}</button>
    </div>
    <div id="playlistBulkBar" style="display:none"></div>
    <div class="list-toolbar">
      <input type="text" id="playlistSearch" class="input list-toolbar-search" placeholder="${t('playlist.search_placeholder')}" value="${esc(searchTerm)}">
      <span id="playlistResultCount" class="list-toolbar-count"></span>
      <!-- "Show auto-generated" was a toggle here, defaulting to ON. Nobody turned it off, and a
           control that only ever has one value is a decision the page is pretending to offer. The
           auto tag on the row still says which is which, without asking anything. -->
    </div>
    <!-- The grid styling goes with the cards; the table brings its own wrapper class. -->
    <div id="playlistGrid">
      <div style="color:var(--text-muted);padding:40px;text-align:center">${t('common.loading')}</div>
    </div>
  `;

  document.getElementById('createPlaylistBtn').addEventListener('click', showCreateModal);
  document.getElementById('playlistSearch').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    loadPlaylists();
  });
  loadPlaylists();
}

async function loadPlaylists() {
  const grid = document.getElementById('playlistGrid');
  if (!grid) return;

  try {
    const playlists = await api.getPlaylists();
    if (!playlists.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 16px;display:block;opacity:0.4">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <h3 style="margin-bottom:8px;color:var(--text-primary)">${t('playlist.empty_title')}</h3>
          <p>${t('playlist.empty_desc')}</p>
        </div>
      `;
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const filtered = playlists
      .filter(p => !term || (p.name || '').toLowerCase().includes(term));
    if (!filtered.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">
          ${playlists.length ? t('playlist.all_auto_generated') : ''}
        </div>
      `;
      return;
    }

    /*
     * A TABLE, not cards.
     *
     * The card said "5 itens" and "3 telas" — the two numbers you least need. What an operator
     * actually asks of this page is "which screens is this on" and "how long does it run", and
     * neither is a number you can card. Both are columns now, and the screens are NAMED rather
     * than counted, because "3 telas" tells you nothing when one of them is the wrong one.
     */
    plSel.order = filtered.map(p => p.id);
    const countEl = document.getElementById('playlistResultCount');
    if (countEl) {
      countEl.textContent = filtered.length === playlists.length
        ? '' : t('bulk.showing', { shown: filtered.length, total: playlists.length });
    }
    grid.className = 'list-table-wrap';
    grid.innerHTML = `
    <table class="list-table">
      <thead>
        <tr>
          ${selectHeaderCell(plSel)}
          <th>${t('playlist.col_name')}</th>
          <th>${t('playlist.col_screens')}</th>
          <th class="num">${t('playlist.col_items')}</th>
          <th class="num">${t('playlist.col_duration')}</th>
          <th class="num">${t('playlist.col_created')}</th>
        </tr>
      </thead>
      <tbody>
      ${filtered.map(p => {
        // The server sends this as JSON (see routes/playlists.js) precisely so there is nothing
        // to split: screen names are typed by people and contain arbitrary punctuation.
        let screens = [];
        try { screens = JSON.parse(p.screen_list || '[]'); } catch { screens = []; }
        return `
        <tr class="list-row" data-playlist-id="${esc(p.id)}">
          ${selectCell(plSel, p.id)}
          <td>
            <a class="list-name-link" href="#/playlists/${esc(p.id)}">
              <span class="list-name-main">${esc(p.name)}</span>
            </a>
            ${p.is_auto_generated ? `<span class="list-tag">${esc(t('playlist.tag_auto'))}</span>` : ''}
            ${p.status === 'draft' ? `<span class="list-tag is-draft">${esc(t('playlist.tag_draft'))}</span>` : ''}
            ${p.description ? `<div class="list-sub">${esc(p.description)}</div>` : ''}
          </td>
          <td>
            ${screens.length
              ? `<div class="list-chips">${screens.map(s =>
                  `<span class="list-chip" title="${esc(s.status === 'online' ? t('device.liveness.healthy') : t('device.liveness.offline'))}"><span class="chip-dot ${s.status === 'online' ? 'is-up' : 'is-down'}"></span>${esc(s.name)}</span>`).join('')}</div>`
              : `<span class="list-sub">${esc(t('playlist.no_screens'))}</span>`}
          </td>
          <td class="num">${p.item_count || 0}</td>
          <td class="num">${esc(formatDuration(p.total_duration))}</td>
          <td class="num">${esc(formatDate(p.created_at))}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;

    wireSelection(grid, plSel, () => loadPlaylists());
    renderPlaylistBulkBar();

  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);padding:40px;text-align:center">${t('playlist.load_failed', { error: esc(err.message) })}</div>`;
  }
}

function showCreateModal() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:400px;max-width:90vw">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">${t('playlist.new_playlist')}</h3>
      <input type="text" id="newPlaylistName" class="input" placeholder="${t('playlist.name_placeholder')}" style="width:100%;margin-bottom:12px" autofocus>
      <textarea id="newPlaylistDesc" class="input" placeholder="${t('playlist.desc_placeholder')}" style="width:100%;height:60px;resize:vertical;margin-bottom:16px"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="cancelCreateBtn">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="confirmCreateBtn">${t('playlist.create_btn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const nameInput = document.getElementById('newPlaylistName');
  nameInput.focus();

  document.getElementById('cancelCreateBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  async function doCreate() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const desc = document.getElementById('newPlaylistDesc').value.trim();
    try {
      const pl = await api.createPlaylist(name, desc);
      modal.remove();
      showToast(t('playlist.toast.created'));
      window.location.hash = `#/playlists/${pl.id}`;
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('confirmCreateBtn').addEventListener('click', doCreate);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
}

async function renderDetail(container, playlistId) {
  container.innerHTML = `
    <div style="color:var(--text-muted);padding:40px;text-align:center">${t('common.loading')}</div>
  `;

  try {
    const playlist = await api.getPlaylist(playlistId);
    renderDetailContent(container, playlist);
  } catch (err) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text-muted)">
        <p>${t('playlist.load_failed', { error: esc(err.message) })}</p>
        <a href="#/playlists" class="btn btn-secondary" style="margin-top:16px">${t('playlist.back_to_playlists')}</a>
      </div>
    `;
  }
}

// #104: draft preview by REUSING the player. Iframes /player in device-free preview
// mode (same-origin -> dashboard CSP frame-src 'self' allows it). The player fetches
// /api/playlists/:id/preview-payload and renders with its unmodified renderer, so the
// preview is byte-identical to what a device shows. Orientation toggle just reloads
// the iframe with &orientation; the server passes it through.
// #238: Portrait here had the same fault as the device preview — the iframe was given the
// as-displayed 9/16 shape AND the player rotated inside it, so the portrait toggle showed sideways
// content. The stage is the panel's face; the iframe is its landscape framebuffer, turned back by
// the stand-in for the wall mount.
function showPlaylistPreview(playlist) {
  let orientation = 'landscape';
  const aspect = () => displayAspectRatio(orientation);
  const frameSrc = () => `/player?preview=1&playlist=${encodeURIComponent(playlist.id)}&orientation=${orientation}&t=${Date.now()}`;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);max-width:95vw;max-height:92vh">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border);gap:12px">
        <strong style="color:var(--text-primary)">${t('widget.preview')} — ${esc(playlist.name)}</strong>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" id="pvpLandscape">${t('device.form.orientation.landscape')}</button>
          <button class="btn btn-secondary btn-sm" id="pvpPortrait">${t('device.form.orientation.portrait')}</button>
          <button class="btn btn-secondary btn-sm" id="pvpClose">${t('widget.close')}</button>
        </div>
      </div>
      <div style="padding:16px;display:flex;align-items:center;justify-content:center;background:#000">
          <!-- The stage is the sized box; the frame inside it is rotated to the panel's own shape
               (#238), so a portrait preview is no longer the double rotation it used to be.
               72vh rather than 78: the modal caps at 92vh with overflow:hidden, and the header plus
               the transport row cost ~12vh — at 78 the skip buttons fell off the bottom. -->
          <div id="pvpStage" style="height:72vh;max-width:92vw;aspect-ratio:${aspect()};background:#000">
            <iframe id="pvpFrame" style="border:0;background:#000" src="${frameSrc()}"></iframe>
          </div>
        </div>
        <div style="display:flex;justify-content:center;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border)">
          <button class="btn btn-secondary btn-sm" id="pvpPrev" disabled>&#8249; ${t('playlist.preview_prev')}</button>
          <span id="pvpPosition" style="color:var(--text-muted);font-size:13px;min-width:110px;text-align:center">&nbsp;</span>
          <button class="btn btn-secondary btn-sm" id="pvpNext" disabled>${t('playlist.preview_next')} &#8250;</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('#pvpStage');
  const frame = overlay.querySelector('#pvpFrame');
  frameDeviceOutput(stage, frame, orientation);
  const btnL = overlay.querySelector('#pvpLandscape');
  const btnP = overlay.querySelector('#pvpPortrait');
  const btnPrev = overlay.querySelector('#pvpPrev');
  const btnNext = overlay.querySelector('#pvpNext');
  const position = overlay.querySelector('#pvpPosition');

  // #239: skip/next. The preview already IS the real player in device-free preview mode, so the
  // control is a message to that one iframe rather than a second copy of the playback logic.
  // Addressing frame.contentWindow (not a broadcast) and pinning targetOrigin to our own origin is
  // what keeps this off any real screen: a live display holds a socket to the server and is not
  // reachable from this page at all, and the preview player itself ignores the message unless it
  // booted with ?preview=1.
  const send = (action) => {
    try { frame.contentWindow?.postMessage({ source: 'screentinker-preview', action }, window.location.origin); } catch (e) {}
  };
  const onPlayerMessage = (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.source !== frame.contentWindow) return;   // ignore any other frame on the page
    const d = ev.data;
    if (!d || d.source !== 'screentinker-player' || d.type !== 'preview:state') return;
    // A multi-zone playlist plays all zones at once, so there is no single item to step through —
    // showing a counter there would be a lie and the buttons would appear dead.
    if (d.zoned || !d.total) {
      btnPrev.disabled = btnNext.disabled = true;
      position.textContent = d.zoned ? t('playlist.preview_zoned') : '';
      return;
    }
    btnPrev.disabled = btnNext.disabled = false;
    position.textContent = t('playlist.preview_position', { current: (d.index >= 0 ? d.index : 0) + 1, total: d.total });
  };
  window.addEventListener('message', onPlayerMessage);
  // The player posts its state as soon as it has content, but an orientation reload restarts it —
  // ask again on every load so the counter can never be left stale from the previous run.
  frame.addEventListener('load', () => send('sync'));

  const setOrientation = (o) => {
    orientation = o;
      // The stage carries the aspect; the frame is rotated inside it (#238).
      stage.style.aspectRatio = aspect();
      frameDeviceOutput(stage, frame, orientation);
      btnPrev.disabled = btnNext.disabled = true;   // reloading: no item until the player says so
      position.textContent = '';
    frame.src = frameSrc();
    btnL.className = 'btn btn-sm ' + (o === 'landscape' ? 'btn-primary' : 'btn-secondary');
    btnP.className = 'btn btn-sm ' + (o.startsWith('portrait') ? 'btn-primary' : 'btn-secondary');
  };
  btnL.onclick = () => setOrientation('landscape');
  btnP.onclick = () => setOrientation('portrait');
  btnPrev.onclick = () => send('prev');
  btnNext.onclick = () => send('next');
  // Listeners are on window/document, so they outlive the overlay unless close() takes them with
  // it — a leaked keydown handler would keep firing at a closed preview.
  const close = () => {
    overlay.remove();
    window.removeEventListener('message', onPlayerMessage);
    document.removeEventListener('keydown', onKey);
  };
  function onKey(ev) {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowRight') send('next');
    else if (ev.key === 'ArrowLeft') send('prev');
  }
  overlay.querySelector('#pvpClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
}

/*
 * A small picture of where this playlist's content actually lands.
 *
 * A playlist has no intrinsic layout — the server derives one from the items' own zone bindings
 * (#104) — so the page could previously show an item tagged "Bottom Ticker" with no indication
 * that the ticker is a thin strip along the bottom. People assigned content to zones by name and
 * found out where it went by looking at a screen.
 *
 * Drawn from the zone percentages, so it is correct for any layout including portrait ones without
 * a stored thumbnail. Zones with no items are dimmed: an empty zone on a real panel shows its
 * background colour, and that is worth seeing BEFORE publishing rather than after.
 */
function layoutMockup(playlist) {
  const layout = playlist && playlist.layout;
  const items = (playlist && playlist.items) || [];

  // No layout means fullscreen — every item shares one frame. Drawing a single empty box would
  // imply a choice was made; say it in words instead.
  if (!layout || !Array.isArray(layout.zones) || layout.zones.length === 0) {
    return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${t('playlist.layout_fullscreen')}</div>`;
  }

  const counts = {};
  for (const it of items) if (it.zone_id) counts[it.zone_id] = (counts[it.zone_id] || 0) + 1;

  const w = Number(layout.width) || 1920;
  const h = Number(layout.height) || 1080;
  const portrait = h > w;
  // Fixed short edge, long edge derived — a portrait mockup must not be as wide as a landscape one
  // or it dominates the page.
  const boxW = portrait ? 90 : 200;
  const boxH = Math.round(boxW * (h / w));

  const zones = layout.zones.map((z) => {
    const n = counts[z.id] || 0;
    const filled = n > 0;
    return `<div title="${esc(z.name)}${filled ? ` — ${n}` : ''}" style="
      position:absolute;
      left:${z.x_percent}%; top:${z.y_percent}%;
      width:${z.width_percent}%; height:${z.height_percent}%;
      box-sizing:border-box;
      border:1px solid ${filled ? 'var(--accent)' : 'var(--border)'};
      background:${filled ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent'};
      display:flex;align-items:center;justify-content:center;
      font-size:9px;line-height:1;color:var(--text-muted);overflow:hidden;
    ">${filled ? n : ''}</div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="position:relative;width:${boxW}px;height:${boxH}px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;flex:none">
        ${zones}
      </div>
      <div style="font-size:12px;color:var(--text-muted)">
        <div>${esc(layout.name || '')} &middot; ${w}&times;${h}${portrait ? ' (portrait)' : ''}</div>
        <div>${tn('playlist.zones_count', layout.zones.length)}</div>
        ${layout._preview_ambiguous ? `<div style="color:var(--warning)">${t('playlist.layout_ambiguous')}</div>` : ''}
      </div>
    </div>`;
}

function renderDetailContent(container, playlist) {
  const isDraft = playlist.status === 'draft';
  const hasPublished = !!playlist.published_snapshot;

  container.innerHTML = `
    ${isDraft ? `
    <div id="draftBanner" style="background:var(--warning-dim);border:1px solid var(--warning);border-radius:var(--radius-lg);padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div style="display:flex;align-items:center;gap:10px;color:var(--warning)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <div style="font-weight:600;font-size:14px">${t('playlist.draft.banner_title')}</div>
          <div style="font-size:12px;color:var(--warning);opacity:0.8">${hasPublished ? t('playlist.draft.devices_showing_published') : t('playlist.draft.never_published')}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${hasPublished ? `<button class="btn btn-secondary btn-sm" id="discardDraftBtn" style="color:var(--warning);border-color:var(--warning)">${t('playlist.draft.discard_changes')}</button>` : ''}
        <button class="btn btn-sm" id="publishBtn" style="background:var(--warning);color:#fff;font-weight:600;border:none">${t('playlist.draft.publish')}</button>
      </div>
    </div>
    ` : ''}

    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="#/playlists" style="color:var(--text-muted);text-decoration:none;font-size:20px" title="${t('playlist.back')}">&larr;</a>
        <div>
          <h1 id="playlistTitle" style="cursor:pointer" title="${t('playlist.click_to_rename')}">${esc(playlist.name)}</h1>
          <div class="subtitle" id="playlistDesc" style="cursor:pointer" title="${t('playlist.click_to_edit_desc')}">${playlist.description ? esc(playlist.description) : `<span style="opacity:0.5">${t('playlist.add_desc_placeholder')}</span>`}</div>
          ${playlist.display_count ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${tn('playlist.assigned_to', playlist.display_count)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="previewPlaylistBtn">${t('widget.preview')}</button>
        <button class="btn btn-primary" id="addItemBtn">${t('playlist.add_content')}</button>
        <button class="btn btn-secondary" id="duplicatePlaylistBtn">${t('playlist.duplicate_playlist')}</button>
        <button class="btn btn-secondary" id="deletePlaylistBtn" style="color:var(--danger)">${t('playlist.delete_playlist')}</button>
      </div>
    </div>

    ${layoutMockup(playlist)}
    
    <div id="playlistItems" style="display:flex;flex-direction:column;gap:8px">
    </div>
  `;

  renderItems(playlist.items || []);

  const publishBtn = document.getElementById('publishBtn');
  if (publishBtn) {
    publishBtn.addEventListener('click', async () => {
      try {
        publishBtn.disabled = true;
        publishBtn.textContent = t('playlist.draft.publishing');
        const updated = await api.publishPlaylist(playlist.id);
        showToast(t('playlist.toast.published'));
        renderDetailContent(container, updated);
      } catch (err) {
        publishBtn.disabled = false;
        publishBtn.textContent = t('playlist.draft.publish');
        showToast(err.message, 'error');
      }
    });
  }
  const previewBtn = document.getElementById('previewPlaylistBtn');
  if (previewBtn) previewBtn.addEventListener('click', () => showPlaylistPreview(playlist));

  const discardBtn = document.getElementById('discardDraftBtn');
  if (discardBtn) {
    discardBtn.addEventListener('click', async () => {
      if (!confirm(t('playlist.confirm_discard_draft'))) return;
      try {
        const updated = await api.discardPlaylistDraft(playlist.id);
        showToast(t('playlist.toast.draft_discarded'));
        renderDetailContent(container, updated);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  document.getElementById('playlistTitle').addEventListener('click', () => inlineEdit(playlist, 'name'));
  document.getElementById('playlistDesc').addEventListener('click', () => inlineEdit(playlist, 'description'));

  document.getElementById('addItemBtn').addEventListener('click', () => showAddItemModal(playlist.id));

  /*
   * Duplicate, then go straight to the copy. Staying on the original would leave the operator
   * looking at an unchanged page wondering whether anything happened, and the reason to duplicate
   * a list is almost always to start editing the copy.
   */
  document.getElementById('duplicatePlaylistBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const copy = await api.duplicatePlaylist(playlist.id);
      showToast(t('playlist.toast.duplicated', { name: copy.name }));
      window.location.hash = `#/playlists/${copy.id}`;
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
    }
  });

  document.getElementById('deletePlaylistBtn').addEventListener('click', async () => {
    if (!confirm(t('playlist.confirm_delete', { name: playlist.name }))) return;
    try {
      await api.deletePlaylist(playlist.id);
      showToast(t('playlist.toast.deleted'));
      window.location.hash = '#/playlists';
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function refreshAfterMutation() {
  if (!currentPlaylistId) return;
  const mainContainer = document.getElementById('draftBanner')?.parentElement || document.querySelector('.page-header')?.parentElement;
  if (!mainContainer) return;
  try {
    const playlist = await api.getPlaylist(currentPlaylistId);
    renderDetailContent(mainContainer, playlist);
  } catch (e) { /* silent */ }
}

function renderItems(items) {
  const itemsEl = document.getElementById('playlistItems');
  if (!itemsEl) return;

  if (!items.length) {
    itemsEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted);border:2px dashed var(--border);border-radius:var(--radius-lg)">
        <p style="margin-bottom:8px">${t('playlist.items_empty')}</p>
        <p style="font-size:13px">${t('playlist.items_empty_hint')}</p>
      </div>
    `;
    return;
  }

  itemsEl.innerHTML = items.map((item, i) => `
    <div class="playlist-item" data-item-id="${item.id}" data-index="${i}" draggable="true" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:grab;transition:border-color 0.15s">
      <div style="color:var(--text-muted);font-size:12px;min-width:24px;text-align:center;user-select:none">${i + 1}</div>
      <div style="width:48px;height:36px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
        ${item.thumbnail_path
          ? `<img data-auth-src="/api/content/${esc(item.content_id)}/thumbnail" style="width:100%;height:100%;object-fit:cover">`
          : `<div style="color:var(--text-muted);opacity:0.5">${getTypeIcon(item)}</div>`
        }
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.filename || item.widget_name || t('common.unknown'))}</div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:8px;min-width:0">
          <span style="white-space:nowrap">${item.widget_id ? t('playlist.item_widget') : esc(item.mime_type || t('playlist.unknown_type'))}</span>
          ${item.sub_playlist_id ? `
          <!-- Only on a sub-list row: on anything else it would be a control with nothing to
               control. Changing it marks the playlist draft, like every other edit here. -->
          <select class="input item-sub-order" data-item-id="${item.id}"
                  title="${esc(t('playlist.sub_order_hint'))}"
                  style="width:auto;padding:2px 6px;font-size:11px;background:var(--bg-input)">
            <option value="sequence" ${item.sub_order !== 'random' ? 'selected' : ''}>${esc(t('playlist.sub_order_sequence'))}</option>
            <option value="random" ${item.sub_order === 'random' ? 'selected' : ''}>${esc(t('playlist.sub_order_random'))}</option>
          </select>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <label style="font-size:12px;color:var(--text-muted)">${t('playlist.duration')}</label>
        <input type="number" class="input item-duration" data-item-id="${item.id}" value="${item.duration_sec}" min="1" style="width:60px;padding:4px 8px;font-size:13px;text-align:center">
        <span style="font-size:12px;color:var(--text-muted)">${t('playlist.sec')}</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        ${item.widget_id && widgetIsEditable(item.widget_type) ? `
        <button class="btn-icon item-widget-edit" data-item-id="${item.id}" data-widget-id="${esc(item.widget_id)}" data-widget-type="${esc(item.widget_type || '')}" title="${t('playlist.edit_widget')}" aria-label="${t('playlist.edit_widget')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
        </button>` : ''}
        <button class="btn-icon item-replace" data-item-id="${item.id}" title="${t('playlist.replace_item')}" aria-label="${t('playlist.replace_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
        <button class="btn-icon item-duplicate" data-item-id="${item.id}" title="${t('playlist.duplicate_item')}" aria-label="${t('playlist.duplicate_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="up" title="${t('playlist.move_up')}" aria-label="${t('playlist.move_up')}" ${i === 0 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === 0 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="down" title="${t('playlist.move_down')}" aria-label="${t('playlist.move_down')}" ${i === items.length - 1 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === items.length - 1 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="btn-icon item-remove" data-item-id="${item.id}" title="${t('common.delete')}" aria-label="${t('playlist.remove_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `).join('');
  hydrateAuthImages(itemsEl);

  itemsEl.querySelectorAll('.item-sub-order').forEach(sel => {
    sel.addEventListener('change', async () => {
      try {
        await api.updatePlaylistItem(currentPlaylistId, sel.dataset.itemId, { sub_order: sel.value });
        showToast(t('playlist.toast.sub_order_saved'));
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  itemsEl.querySelectorAll('.item-duration').forEach(input => {
    input.addEventListener('change', async (e) => {
      const itemId = e.target.dataset.itemId;
      const val = parseInt(e.target.value, 10);
      if (!val || val < 1) { e.target.value = 10; return; }
      try {
        await api.updatePlaylistItem(currentPlaylistId, itemId, { duration_sec: val });
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  itemsEl.querySelectorAll('.item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      try {
        await api.deletePlaylistItem(currentPlaylistId, itemId);
        const playlist = await api.getPlaylist(currentPlaylistId);
        renderItems(playlist.items || []);
        refreshAfterMutation();
        showToast(t('playlist.toast.item_removed'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });


  // #105 duplicate: server copies the row + its schedule blocks, appended at the end.
  itemsEl.querySelectorAll('.item-duplicate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      try {
        e.currentTarget.disabled = true;
        await api.duplicatePlaylistItem(currentPlaylistId, itemId);
        const playlist = await api.getPlaylist(currentPlaylistId);
        renderItems(playlist.items || []);
        refreshAfterMutation();
        showToast(t('playlist.toast.item_duplicated'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Change what an existing widget shows — the lottery modality, the football view, the weather
  // city, the news feed — without deleting the item and adding it back.
  itemsEl.querySelectorAll('.item-widget-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      showEditWidgetModal(e.currentTarget.dataset.widgetId, e.currentTarget.dataset.widgetType);
    });
  });

  // #105 replace: reuse the add-item picker in "replace" mode — swaps content/widget
  // in place, preserving duration/schedule/zone (server-side).
  itemsEl.querySelectorAll('.item-replace').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      showAddItemModal(currentPlaylistId, { replaceItemId: itemId });
    });
  });

  itemsEl.querySelectorAll('.item-move').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (btn.disabled) return;
      const itemId = parseInt(e.currentTarget.dataset.itemId, 10);
      const dir = e.currentTarget.dataset.dir;
      const order = Array.from(itemsEl.querySelectorAll('.playlist-item'))
        .map(el => parseInt(el.dataset.itemId, 10));
      const idx = order.indexOf(itemId);
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= order.length) return;
      [order[idx], order[swap]] = [order[swap], order[idx]];
      try {
        const updated = await api.reorderPlaylistItems(currentPlaylistId, order);
        renderItems(updated);
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  setupDragReorder(itemsEl);
}

function setupDragReorder(container) {
  let dragEl = null;

  container.addEventListener('dragstart', (e) => {
    dragEl = e.target.closest('.playlist-item');
    if (!dragEl) return;
    dragEl.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.style.opacity = '';
    dragEl = null;
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.playlist-item');
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
    if (target && target !== dragEl) {
      target.style.borderTop = '2px solid var(--accent-ink)';
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.playlist-item');
    if (!target || !dragEl || target === dragEl) return;

    container.insertBefore(dragEl, target);

    const order = Array.from(container.querySelectorAll('.playlist-item'))
      .map(el => parseInt(el.dataset.itemId, 10));

    try {
      const items = await api.reorderPlaylistItems(currentPlaylistId, order);
      renderItems(items);
      refreshAfterMutation();
    } catch (err) {
      showToast(err.message, 'error');
      const playlist = await api.getPlaylist(currentPlaylistId);
      renderItems(playlist.items || []);
    }
  });
}

function inlineEdit(playlist, field) {
  const el = field === 'name' ? document.getElementById('playlistTitle') : document.getElementById('playlistDesc');
  if (!el) return;

  const current = playlist[field] || '';
  const isName = field === 'name';

  if (isName) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:24px;font-weight:700;padding:2px 8px;width:100%';
    el.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
      const val = input.value.trim();
      if (!val) { input.value = current; return; }
      try {
        const updated = await api.updatePlaylist(playlist.id, { [field]: val });
        playlist[field] = updated[field];
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('h1');
      newEl.id = 'playlistTitle';
      newEl.style.cursor = 'pointer';
      newEl.title = t('playlist.click_to_rename');
      newEl.textContent = playlist.name;
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'name'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
  } else {
    const input = document.createElement('textarea');
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:13px;padding:4px 8px;width:100%;height:40px;resize:vertical';
    el.replaceWith(input);
    input.focus();

    async function save() {
      const val = input.value.trim();
      try {
        const updated = await api.updatePlaylist(playlist.id, { description: val });
        playlist.description = updated.description;
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('div');
      newEl.className = 'subtitle';
      newEl.id = 'playlistDesc';
      newEl.style.cursor = 'pointer';
      newEl.title = t('playlist.click_to_edit_desc');
      if (playlist.description) {
        newEl.textContent = playlist.description;
      } else {
        newEl.innerHTML = `<span style="opacity:0.5">${t('playlist.add_desc_placeholder')}</span>`;
      }
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'description'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = current; input.blur(); } });
  }
}

/*
 * Loop OS: the FIXED widget catalogue.
 *
 * The standalone widget manager is no longer the tenant's entry point (its nav item is hidden),
 * because "build a widget" is not a job a shop owner wants — "put the weather on that screen" is.
 * So this is a closed list of four things, each of which creates the widget and drops it into the
 * playlist in one click.
 *
 * `ask` is the only configuration any of them takes: null means zero-config, otherwise it is the
 * single field collected before the widget is created. Anything more elaborate belongs in the
 * widget editor, which still exists for whoever needs it.
 *
 * diag-smoothness is deliberately absent — it is an internal frame-rate diagnostic and must never
 * be offered to a customer. Keeping the catalogue a closed list (rather than filtering the full
 * type set) is what guarantees that: a new internal type cannot leak in by being forgotten.
 */
const WIDGET_CATALOGUE = [
  {
    type: 'clock',
    key: 'clock',
    icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    ask: null,
    config: () => ({ format: '24h', show_date: true, font_size: 64, color: '#FFFFFF', background: 'transparent' }),
  },
  {
    type: 'weather',
    key: 'weather',
    icon: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    // A picked CITY, not typed text. The old free-text field fed a name straight to the weather
    // API, which resolves ambiguity by guessing — "Pinheiros" is a town in ES and a district of
    // São Paulo, and the wrong one produces a perfectly plausible temperature for the wrong
    // place. The list carries coordinates (lib/cities-br.js) so there is nothing to guess.
    ask: { field: 'city_id', required: true, remote: 'cities' },
    config: (v) => ({ city_id: v, show_forecast: true }),
    current: (cfg) => cfg.city_id || '',
  },
  {
    type: 'football',
    key: 'football',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 7l4.2 3-1.6 5h-5.2L7.8 10z"/>',
    ask: { field: 'view', required: false, options: [
      { value: 'matches', labelKey: 'football_matches' },
      { value: 'table', labelKey: 'football_table' },
    ] },
    config: (v) => ({ view: v || 'matches', max_rows: v === 'table' ? 10 : 6 }),
    current: (cfg) => cfg.view || 'matches',
  },
  {
    type: 'rss',
    key: 'news',
    icon: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    /*
     * A category picker rather than a feed URL — nobody wants to paste an RSS endpoint into a
     * signage tool — and MULTI, because one source repeats itself. A single portal publishes a
     * dozen stories a day; a widget reading only that shows the same handful over and over. Pick
     * several and the server interleaves them, so consecutive cards come from different newsrooms.
     */
    ask: { field: 'feed_urls', required: false, multi: true, options: [
      { value: 'https://g1.globo.com/rss/g1/', labelKey: 'news_geral' },
      { value: 'https://ge.globo.com/rss/ge/', labelKey: 'news_esportes' },
      { value: 'https://g1.globo.com/rss/g1/economia/', labelKey: 'news_economia' },
      { value: 'https://g1.globo.com/rss/g1/politica/', labelKey: 'news_politica' },
      { value: 'https://g1.globo.com/rss/g1/mundo/', labelKey: 'news_mundo' },
      { value: 'https://g1.globo.com/rss/g1/tecnologia/', labelKey: 'news_tecnologia' },
      { value: 'https://g1.globo.com/rss/g1/ciencia-e-saude/', labelKey: 'news_saude' },
      { value: 'https://g1.globo.com/rss/g1/pop-arte/', labelKey: 'news_entretenimento' },
      { value: 'https://g1.globo.com/rss/g1/carros/', labelKey: 'news_carros' },
      { value: 'https://g1.globo.com/rss/g1/economia/agronegocios/', labelKey: 'news_agro' },
    ] },
    // No scroll_speed/font_size/colour here any more: those configure the crawling ticker, which
    // is now opt-in via mode: 'ticker'. A new news widget is a full-screen card — one headline
    // over its own photograph — and takes none of them.
    unitKey: 'sections',
    /*
     * item_seconds is written EXPLICITLY, not left to the renderer's default, because a widget
     * created before this carried item_seconds: 9 and the edit merge preserved it — so a 15s slot
     * still showed one headline and a slice of the next. A value the catalogue owns has to be
     * (re)stated every time, or the old one silently wins forever.
     */
    config: (v) => ({
      feed_urls: (Array.isArray(v) && v.length) ? v : ['https://g1.globo.com/rss/g1/'],
      item_seconds: 25,
    }),
    // Dead weight from the crawling-ticker era. background:'#000000' in particular was still
    // being applied, painting the card black instead of its themed backdrop.
    drops: ['scroll_speed', 'font_size', 'color', 'background', 'max_items', 'feed_url'],
    // Widgets made before the multi-select carry a single feed_url; read as a list of one.
    current: (cfg) => (Array.isArray(cfg.feed_urls) && cfg.feed_urls.length
      ? cfg.feed_urls : [cfg.feed_url || 'https://g1.globo.com/rss/g1/']),
  },
  {
    type: 'lottery',
    key: 'lottery',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    // Ten modalities, one widget. Each carries its own colour, ball count and result SHAPE
    // server-side (lib/lottery.js) — Federal is a prize table, Super Sete is columns, +Milionária
    // adds clovers — so the only thing chosen here is which draw to show.
    // MULTI: pick several and the widget cycles through them, so one playlist slot covers the
    // draws a customer follows instead of needing a widget per game.
    ask: { field: 'games', required: false, multi: true, options: [
      { value: 'megasena',       labelKey: 'lot_megasena' },
      { value: 'lotofacil',      labelKey: 'lot_lotofacil' },
      { value: 'quina',          labelKey: 'lot_quina' },
      { value: 'lotomania',      labelKey: 'lot_lotomania' },
      { value: 'duplasena',      labelKey: 'lot_duplasena' },
      { value: 'timemania',      labelKey: 'lot_timemania' },
      { value: 'diadesorte',     labelKey: 'lot_diadesorte' },
      { value: 'maismilionaria', labelKey: 'lot_maismilionaria' },
      { value: 'supersete',      labelKey: 'lot_supersete' },
      { value: 'federal',        labelKey: 'lot_federal' },
    ] },
    // game_seconds stated explicitly for the same reason as the news widget: a value the catalogue
    // owns must be rewritten on every save or a stale one outlives every change.
    config: (v) => ({ games: (Array.isArray(v) && v.length) ? v : ['megasena'], game_seconds: 25 }),
    // The old catalogue stamped these into every lottery widget it made; none is read any more,
    // and background:'transparent' fights the themed backdrop.
    drops: ['font_size', 'color', 'accent', 'background', 'game'],
    // Widgets created before the multi-select carry a single `game`; read them as a list of one so
    // the dialog opens on what they actually show rather than on nothing.
    current: (cfg) => (Array.isArray(cfg.games) && cfg.games.length ? cfg.games : [cfg.game || 'megasena']),
  },
];

/*
 * Only widgets that ASK something can be edited — the clock takes no choice today, so offering an
 * edit button on it would open an empty dialog. `current` is what makes editing possible at all:
 * the question's field name is not always the config key it writes (news asks for a "category" and
 * stores a feed_url), so each entry states how to read its own value back rather than the editor
 * guessing.
 */
function catalogueFor(widgetType) {
  return WIDGET_CATALOGUE.find(w => w.type === widgetType) || null;
}
function widgetIsEditable(widgetType) {
  const entry = catalogueFor(widgetType);
  return !!(entry && entry.ask && entry.current);
}

/*
 * Name a widget after what it is AND what it was set to.
 *
 * Four lottery widgets all called "Loteria" is what a playlist looked like before this, and it is
 * genuinely impossible to tell from the list which one shows which draw. The same rule runs on
 * create and on edit, so the name never contradicts the setting.
 */
function widgetName(entry, value) {
  const base = t('playlist.catalogue.' + entry.key);
  if (!value || !entry.ask) return base;
  if (Array.isArray(value)) {
    if (!value.length) return base;
    // One game reads as itself; several read as a count, because six labels in a list row is not
    // a name anybody can scan. The unit is the widget's own word — a news widget reading four
    // sections is not showing "4 modalidades".
    if (value.length === 1) return widgetName(entry, value[0]);
    return `${base} — ${value.length} ${t('playlist.catalogue.' + (entry.unitKey || 'modalities'))}`;
  }
  if (entry.ask.options) {
    const opt = entry.ask.options.find(o => o.value === value);
    return opt ? `${base} — ${t('playlist.catalogue.' + opt.labelKey)}` : base;
  }
  // A free-text or remote-picked value (a city id) is not a label; the caller supplies one.
  return `${base} — ${value}`;
}

/*
 * The config to save: what was there, plus what the catalogue owns, MINUS what it has retired.
 *
 * Merging alone is not enough. A key the catalogue stopped writing keeps whatever value it had
 * forever — that is how a news widget kept item_seconds: 9 through every edit and went on showing
 * a headline and a half in a fifteen-second slot, and how background: '#000000' from the ticker
 * era kept painting the card black under its own backdrop. `drops` names those keys so a save
 * actually retires them; everything not named is left alone.
 */
function mergedConfig(entry, current, value) {
  const next = { ...current, ...entry.config(value) };
  for (const dead of entry.drops || []) {
    if (!(dead in entry.config(value))) delete next[dead];
  }
  return next;
}

/*
 * Reopen the catalogue's question on a widget that already exists.
 *
 * The config is MERGED, not replaced: config() returns a fresh object for a brand-new widget, and
 * writing that over an existing one would silently drop anything else set on it. Changing the
 * lottery modality must change the modality and nothing else.
 */
async function showEditWidgetModal(widgetId, widgetType) {
  const entry = catalogueFor(widgetType);
  if (!entry || !entry.ask) return;

  let widget;
  try {
    widget = await api.getWidget(widgetId);
  } catch (err) { return showToast(err.message, 'error'); }

  let config = {};
  try { config = typeof widget.config === 'string' ? JSON.parse(widget.config || '{}') : (widget.config || {}); }
  catch { config = {}; }
  const currentValue = entry.current ? entry.current(config) : '';

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';

  const field = entry.ask.multi
    ? `<div id="editWidgetMulti" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px 12px">
         ${entry.ask.options.map(o => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-primary);cursor:pointer">
            <input type="checkbox" value="${esc(o.value)}"${(currentValue || []).includes(o.value) ? ' checked' : ''}>
            ${esc(t('playlist.catalogue.' + o.labelKey))}
          </label>`).join('')}
       </div>`
    : entry.ask.options
    ? `<select class="input" id="editWidgetValue" style="width:100%">
         ${entry.ask.options.map(o => `<option value="${esc(o.value)}"${o.value === currentValue ? ' selected' : ''}>${esc(t('playlist.catalogue.' + o.labelKey))}</option>`).join('')}
       </select>`
    : entry.ask.remote === 'cities'
      ? `<select class="input" id="editWidgetValue" style="width:100%"><option value="">${esc(t('common.loading'))}</option></select>`
      : `<input class="input" id="editWidgetValue" style="width:100%" value="${esc(currentValue)}">`;

  modal.innerHTML = `
    <div class="card" style="max-width:440px;width:92%;padding:24px" role="dialog" aria-modal="true">
      <h3 style="margin-bottom:4px;color:var(--text-primary)">${esc(t('playlist.edit_widget'))}</h3>
      <p style="margin-bottom:16px;color:var(--text-muted);font-size:13px">${esc(t('playlist.catalogue.' + entry.key))}</p>
      <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-muted)">${esc(t('playlist.edit_widget_field'))}</label>
      ${field}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
        <button class="btn btn-secondary" id="editWidgetCancel">${esc(t('common.cancel'))}</button>
        <button class="btn btn-primary" id="editWidgetSave">${esc(t('common.save'))}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const select = modal.querySelector('#editWidgetValue');
  const multi = modal.querySelector('#editWidgetMulti');
  if (!multi && entry.ask.remote === 'cities') {
    api.getWeatherCities()
      .then(cities => {
        select.innerHTML = cities.map(c =>
          `<option value="${esc(c.id)}"${c.id === currentValue ? ' selected' : ''}>${esc(c.label)} — ${esc(c.uf)}</option>`).join('');
      })
      .catch(() => { select.innerHTML = `<option value="">${esc(t('playlist.catalogue.weather_load_failed'))}</option>`; });
  }

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#editWidgetCancel').addEventListener('click', close);

  modal.querySelector('#editWidgetSave').addEventListener('click', async (e) => {
    const value = multi
      ? [...multi.querySelectorAll('input:checked')].map(cb => cb.value)
      : (select.value || '').trim();
    if (multi && !value.length) {
      return showToast(t('playlist.catalogue.' + entry.key + '_pick_one'), 'error');
    }
    if (!multi && entry.ask.required && !value) {
      return showToast(t('playlist.catalogue.' + entry.key + '_required'), 'error');
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('common.saving');
    try {
      // The label the operator just read in the dropdown, so a remote-picked city names the widget
      // "Previsão do tempo — Montanha" rather than "— montanha-es".
      const chosenLabel = !multi && select.tagName === 'SELECT' && select.selectedOptions[0]
        ? select.selectedOptions[0].textContent.trim()
        : value;
      await api.updateWidget(widgetId, {
        name: entry.ask.options ? widgetName(entry, value) : `${t('playlist.catalogue.' + entry.key)} — ${chosenLabel}`,
        config: mergedConfig(entry, config, value),
      });
      close();
      showToast(t('playlist.edit_widget_saved'), 'success');
      // The row shows the widget's name, and the name now carries the setting — redraw so the list
      // stops saying Mega-Sena after it has been changed to Lotofácil.
      await refreshAfterMutation();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('common.save');
      showToast(err.message, 'error');
    }
  });
}

/*
 * Bulk actions for the index. Publish and delete are per-playlist on the server, so these run as
 * a sequence rather than one request — deliberately sequential, because firing N writes at a
 * server that is also serving players is how a bulk action becomes an outage. runEach reports what
 * actually happened: a partial failure the operator is not told about is worse than a refusal.
 */
function renderPlaylistBulkBar() {
  renderBulkBar(document.getElementById('playlistBulkBar'), plSel, [
    {
      id: 'publish',
      label: (count) => tn('playlist.bulk_publish', count),
      run: async (ids) => {
        const { ok, failed } = await runEach(ids, (id) => api.publishPlaylist(id));
        showToast(failed.length ? t('bulk.partial', { ok, fail: failed.length })
          : tn('playlist.bulk_published', ok), failed.length ? 'error' : 'success');
        plSel.ids.clear();
        loadPlaylists();
      },
    },
    /*
     * Duplicate, before delete so the destructive button stays last. Sequential like its
     * neighbours: firing N writes at a server that is also serving players is how a bulk action
     * becomes an outage. Every copy lands as a draft on no screen, so this needs no confirmation.
     */
    {
      id: 'duplicate',
      label: (count) => tn('playlist.bulk_duplicate', count),
      run: async (ids) => {
        const { ok, failed } = await runEach(ids, (id) => api.duplicatePlaylist(id));
        showToast(failed.length ? t('bulk.partial', { ok, fail: failed.length })
          : tn('playlist.bulk_duplicated', ok), failed.length ? 'error' : 'success');
        plSel.ids.clear();
        loadPlaylists();
      },
    },
    {
      id: 'delete',
      kind: 'danger',
      confirm: true,
      label: (count) => tn('playlist.bulk_delete', count),
      confirmLabel: (count) => tn('playlist.bulk_delete_confirm', count),
      run: async (ids) => {
        const { ok, failed } = await runEach(ids, (id) => api.deletePlaylist(id));
        showToast(failed.length ? t('bulk.partial', { ok, fail: failed.length })
          : tn('playlist.bulk_deleted', ok), failed.length ? 'error' : 'success');
        plSel.ids.clear();
        loadPlaylists();
      },
    },
  ], () => loadPlaylists());
}

async function showAddItemModal(playlistId, opts = {}) {
  // #105: when opts.replaceItemId is set, picking an item REPLACES that item's
  // content/widget in place (preserving duration/schedule/zone) instead of adding.
  const replaceItemId = opts.replaceItemId || null;
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;max-width:560px;width:95vw;max-height:80vh;display:flex;flex-direction:column">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">${replaceItemId ? t('playlist.replace_modal_title') : t('playlist.add_modal_title')}</h3>
      <div style="display:flex;gap:8px;margin-bottom:12px" id="addItemTabs">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="content">${t('playlist.tab_content')}</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="widgets" style="display:none">${t('playlist.tab_widgets')}</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="sublists" style="display:none">${t('playlist.tab_sublists')}</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="tools">${t('playlist.tab_tools')}</button>
      </div>
      <input type="text" id="addItemSearch" class="input" placeholder="${t('playlist.search_placeholder')}" style="width:100%;margin-bottom:12px">
      <div id="addItemList" style="flex:1;overflow-y:auto;min-height:200px;max-height:400px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-secondary" id="closeAddModal">${t('playlist.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let activeTab = 'content';
  let allContent = [];
  let allPlaylists = [];
  let plan = {};

  try {
    // The plan decides which tabs exist at all (4.3). A failure to read it is treated as "no
    // paid features" by the `|| {}` below rather than as an error — the content tab still works,
    // which is the one every plan has.
    const [content, playlists, sub] = await Promise.all([
      api.getContent(),
      api.getPlaylists ? api.getPlaylists().catch(() => []) : Promise.resolve([]),
      api.getSubscription ? api.getSubscription().catch(() => null) : Promise.resolve(null),
    ]);
    allContent = content || [];
    // Only OTHER playlists can be sub-lists, and only ones that are not themselves nesting —
    // the server enforces this too (lib/sublists.js); filtering here just avoids offering a
    // choice that would be rejected.
    allPlaylists = (playlists || []).filter(p => p.id !== playlistId);
    plan = (sub && sub.plan) || {};
  } catch (err) {
    document.getElementById('addItemList').innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${t('playlist.load_failed', { error: esc(err.message) })}</div>`;
  }

  // 4.3: reveal the paid tabs only when the plan allows them. Hidden rather than shown-disabled,
  // because a tab that exists only to say "upgrade" is noise in a tool someone uses daily.
  const tabs = modal.querySelector('#addItemTabs');
  if (plan.widgets_enabled) tabs.querySelector('[data-tab="widgets"]').style.display = '';
  // Sub-lists are a Corporativo feature and the whole tab hides below it: a tab that exists only
  // to say "upgrade" is noise in a tool someone uses daily. Ferramentas is NOT gated — remote URL
  // and YouTube are available on every plan.
  if (plan.sublists_enabled) tabs.querySelector('[data-tab="sublists"]').style.display = '';

  // Add (or replace) an item, then reflect it in the list. Shared by all three tabs so the
  // post-add behaviour cannot drift between them.
  async function commitItem(data, btn, label) {
    try {
      btn.disabled = true;
      if (replaceItemId) {
        btn.textContent = t('playlist.replacing');
        await api.updatePlaylistItem(playlistId, replaceItemId, data);
        modal.remove();
        const playlist = await api.getPlaylist(playlistId);
        renderItems(playlist.items || []);
        refreshAfterMutation();
        showToast(t('playlist.toast.item_replaced'));
        return;
      }
      btn.textContent = t('playlist.adding');
      await api.addPlaylistItem(playlistId, data);
      btn.textContent = t('playlist.added');
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      refreshAfterMutation();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      showToast(err.message, 'error');
    }
  }

  // The fixed four-widget catalogue (4.2). Each row creates the widget through the existing
  // POST /api/widgets and drops it straight into the playlist — two calls, one click.
  function renderWidgetCatalogue(list) {
    list.innerHTML = WIDGET_CATALOGUE.map(w => {
      let control = '';
      if (w.ask && w.ask.multi) {
        // Checkboxes, not a multi-select list box: on a touch panel a ctrl-click list is close to
        // unusable, and the whole point is that picking several is the normal thing to do here.
        control = `<div class="cat-multi" data-key="${w.key}" style="margin-top:6px;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px 10px">
          ${w.ask.options.map((o, i) => `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-primary);cursor:pointer">
             <input type="checkbox" value="${esc(o.value)}"${i === 0 ? ' checked' : ''}>
             ${esc(t('playlist.catalogue.' + o.labelKey))}
           </label>`).join('')}
        </div>`;
      } else if (w.ask && w.ask.options) {
        control = `<select class="input cat-input" data-key="${w.key}" style="width:100%;margin-top:6px;font-size:12px">
          ${w.ask.options.map(o => `<option value="${esc(o.value)}">${esc(t('playlist.catalogue.' + o.labelKey))}</option>`).join('')}
        </select>`;
      } else if (w.ask && w.ask.remote === 'cities') {
        // Filled in after render from /api/widgets/weather/cities — the list is server-owned so
        // the coordinates behind each entry stay in one place.
        control = `<select class="input cat-input" data-key="${w.key}" style="width:100%;margin-top:6px;font-size:12px">
          <option value="">${esc(t('playlist.catalogue.weather_loading'))}</option>
        </select>`;
      } else if (w.ask) {
        control = `<input type="text" class="input cat-input" data-key="${w.key}" list="cat-list-${w.key}"
                     placeholder="${esc(t('playlist.catalogue.' + w.key + '_placeholder'))}"
                     style="width:100%;margin-top:6px;font-size:12px">
                   <datalist id="cat-list-${w.key}">${(w.ask.list || []).map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
      }
      return `
        <div class="catalogue-row" style="display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px">
          <div style="width:36px;height:36px;border-radius:8px;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--accent)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${w.icon}</svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t('playlist.catalogue.' + w.key))}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(t('playlist.catalogue.' + w.key + '_desc'))}</div>
            ${control}
          </div>
          <button class="btn btn-primary btn-sm cat-add" data-key="${w.key}" style="flex-shrink:0">${replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn')}</button>
        </div>`;
    }).join('');

    // Populate the city picker. Failure is non-fatal: the select keeps its placeholder and the
    // required-field check below stops an empty submission, rather than the row vanishing.
    const citySel = list.querySelector('.cat-input[data-key="weather"]');
    if (citySel && citySel.tagName === 'SELECT') {
      api.getWeatherCities()
        .then(cities => {
          citySel.innerHTML = cities.map(c =>
            `<option value="${esc(c.id)}">${esc(c.label)} — ${esc(c.uf)}</option>`).join('');
        })
        .catch(() => { citySel.innerHTML = `<option value="">${esc(t('playlist.catalogue.weather_load_failed'))}</option>`; });
    }

    list.querySelectorAll('.cat-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entry = WIDGET_CATALOGUE.find(w => w.key === btn.dataset.key);
        const multi = entry.ask && entry.ask.multi
          ? list.querySelector(`.cat-multi[data-key="${entry.key}"]`) : null;
        const input = list.querySelector(`.cat-input[data-key="${entry.key}"]`);
        const value = multi
          ? [...multi.querySelectorAll('input:checked')].map(cb => cb.value)
          : (input ? input.value.trim() : '');
        if (multi && !value.length) {
          showToast(t('playlist.catalogue.' + entry.key + '_pick_one'), 'error');
          return;
        }
        if (entry.ask && entry.ask.required && !value) {
          showToast(t('playlist.catalogue.' + entry.key + '_required'), 'error');
          if (input) input.focus();
          return;
        }
        const label = replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn');
        try {
          btn.disabled = true;
          btn.textContent = t('playlist.adding');
          // Name the widget after what it is plus its distinguishing input, so a playlist with
          // three weather widgets is readable in the item list. Same rule as the edit dialog uses.
          const name = widgetName(entry, value);
          const widget = await api.createWidget({ widget_type: entry.type, name, config: entry.config(value) });
          await commitItem({ widget_id: widget.id }, btn, label);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = label;
          showToast(err.message, 'error');
        }
      });
    });
  }

  // Sub-lists (4.3): every other playlist in the workspace becomes a rotating slot. The server
  // rejects anything that would nest more than one level; this list is just the offer.
  /*
   * Ferramentas: remote URL, YouTube, and — for plans that include them — sub-lists.
   *
   * The two link forms CREATE the content and add it in one step. Doing it in two (add to the
   * library, then come back and pick it) is the round trip that made them worth moving here.
   *
   * Sub-lists are gated per plan INSIDE the pane rather than by hiding the tab, because the link
   * forms are not a paid feature and the tab has to exist for everyone.
   */
  /*
   * Ferramentas: the ways to bring in content that is not already a file in the library.
   *
   * A menu, not a stack of forms. Listing them by name lets the operator choose before reading
   * any fields, and keeps the pane the same height however many tools land here later.
   */
  const TOOLS = [
    {
      id: 'remote',
      title: () => t('content.remote_url'),
      desc: () => t('content.remote_desc'),
      icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      submit: () => t('content.remote_add_btn'),
      fields: () => [
        { id: 'url', placeholder: t('content.remote_url_placeholder'), required: t('content.error_enter_url') },
        { id: 'name', placeholder: t('content.remote_name_placeholder') },
        { id: 'mime', type: 'select', options: [
          ['video/mp4', t('content.mime.video_mp4')], ['video/webm', t('content.mime.video_webm')],
          ['image/jpeg', t('content.mime.image_jpeg')], ['image/png', t('content.mime.image_png')],
        ] },
      ],
      create: (v) => api.addRemoteContent(v.url, v.name, v.mime),
    },
    {
      id: 'youtube',
      title: () => t('content.youtube'),
      desc: () => t('content.youtube_desc'),
      icon: '<path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>',
      submit: () => t('content.youtube_add_btn'),
      fields: () => [
        { id: 'url', placeholder: t('content.youtube_url_placeholder'), required: t('content.error_enter_youtube_url') },
        { id: 'name', placeholder: t('content.youtube_name_placeholder') },
      ],
      create: (v) => api.addYoutubeContent(v.url, v.name),
    },
  ];

  function renderTools(list) {
    list.innerHTML = TOOLS.map(tool => `
      <button class="tool-row" data-tool="${esc(tool.id)}">
        <span class="tool-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${tool.icon}</svg>
        </span>
        <span class="tool-text">
          <span class="tool-title">${esc(tool.title())}</span>
          <span class="tool-desc">${esc(tool.desc())}</span>
        </span>
        <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`).join('');

    list.querySelectorAll('.tool-row').forEach(row => {
      row.onclick = () => openTool(TOOLS.find(x => x.id === row.dataset.tool));
    });
  }

  /*
   * One tool, one dialog. Sits ABOVE the add-item dialog (z-index) rather than replacing it, so
   * cancelling puts the operator back where they were instead of at the start.
   */
  function openTool(tool) {
    if (!tool) return;
    const fields = tool.fields();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1100';
    box.innerHTML = `
      <div class="modal" style="max-width:460px;width:92vw">
        <div class="modal-header">
          <h3>${esc(tool.title())}</h3>
          <button class="btn-icon" data-tool-close aria-label="${esc(t('common.close'))}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">${esc(tool.desc())}</p>
          ${fields.map(f => f.type === 'select'
            ? `<select class="input" data-field="${esc(f.id)}" style="background:var(--bg-input);margin-bottom:10px;width:100%">
                 ${f.options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('')}
               </select>`
            : `<input type="text" class="input" data-field="${esc(f.id)}" placeholder="${esc(f.placeholder)}" style="margin-bottom:10px;width:100%">`
          ).join('')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-tool-close>${esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" data-tool-submit>${esc(tool.submit())}</button>
        </div>
      </div>`;
    document.body.appendChild(box);

    const close = () => box.remove();
    box.querySelectorAll('[data-tool-close]').forEach(b => { b.onclick = close; });
    box.onclick = (e) => { if (e.target === box) close(); };
    box.querySelector('[data-field]')?.focus();

    box.querySelector('[data-tool-submit]').onclick = async (e) => {
      const values = {};
      for (const f of fields) {
        values[f.id] = (box.querySelector(`[data-field="${f.id}"]`)?.value || '').trim();
        if (f.required && !values[f.id]) return showToast(f.required, 'error');
      }
      const btn = e.currentTarget;
      const label = tool.submit();
      btn.disabled = true;
      btn.textContent = t('playlist.adding');

      let created;
      try {
        created = await tool.create(values);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = label;
        return showToast(err.message, 'error');
      }
      /*
       * If creation succeeded but adding fails, the content still exists in the library. Say so —
       * a flat failure makes the operator paste the same link again and end up with a duplicate.
       */
      const id = created && (created.id || (created.content && created.content.id));
      if (!id) {
        btn.disabled = false;
        btn.textContent = label;
        return showToast(t('playlist.add_failed_generic'), 'error');
      }
      close();
      await commitItem({ content_id: id }, e.currentTarget, label);
    };
  }

  function renderSubLists(list, search) {
    if (!list) return;
    const filtered = allPlaylists.filter(p => (p.name || '').toLowerCase().includes(search));
    if (!filtered.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${t('playlist.no_sublists_found')}</div>`;
      return;
    }
    list.innerHTML = filtered.map(p => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius)">
        <div style="width:40px;height:30px;border-radius:4px;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${t('playlist.sublist_item_count', { count: p.item_count || 0 })}</div>
        </div>
        <select class="input btn-sm sub-order" data-id="${esc(p.id)}" style="width:auto;background:var(--bg-input)"
                title="${esc(t('playlist.sub_order_hint'))}">
          <option value="sequence">${esc(t('playlist.sub_order_sequence'))}</option>
          <option value="random">${esc(t('playlist.sub_order_random'))}</option>
        </select>
        <button class="btn btn-primary btn-sm sub-add" data-id="${esc(p.id)}">${replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn')}</button>
      </div>`).join('');

    list.querySelectorAll('.sub-add').forEach(btn => {
      btn.addEventListener('click', () => {
        // Read the order off the row being added, not off some remembered global: two rows can be
        // added in one visit and they are separate decisions.
        const order = list.querySelector(`.sub-order[data-id="${CSS.escape(btn.dataset.id)}"]`)?.value || 'sequence';
        commitItem(
          { sub_playlist_id: btn.dataset.id, sub_order: order },
          btn,
          replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn'),
        );
      });
    });
  }

  function renderTab() {
    const list = document.getElementById('addItemList');
    const search = (document.getElementById('addItemSearch')?.value || '').toLowerCase();

    // The catalogue is four fixed entries, and Ferramentas is two forms plus a short list — a
    // search box above either is furniture, and above Ferramentas it is worse than that: it
    // sits over the URL field and looks like it belongs to it.
    const searchBox = document.getElementById('addItemSearch');
    if (searchBox) searchBox.style.display = (activeTab === 'widgets' || activeTab === 'tools') ? 'none' : '';

    if (activeTab === 'widgets') return renderWidgetCatalogue(list);
    if (activeTab === 'sublists') return renderSubLists(list, search);
    if (activeTab === 'tools') return renderTools(list);

    const items = allContent;
    const filtered = items.filter(item => {
      const name = (item.filename || item.name || '').toLowerCase();
      return name.includes(search);
    });

    if (!filtered.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${t('playlist.no_content_found')}</div>`;
      return;
    }

    list.innerHTML = filtered.map(item => {
      const name = item.filename || item.name || t('common.unknown');
      // #237: the server gives a video item the clip's own length instead of the 10s default.
      // Show that length here so the duration the item lands with is something the operator
      // saw coming, rather than a number that appears in the list after the fact.
      const clipSec = Number(item.duration_sec) > 0 ? Math.ceil(item.duration_sec) : 0;
      const clip = clipSec ? ` · ${Math.floor(clipSec / 60)}:${String(clipSec % 60).padStart(2, '0')}` : '';
      const sub = (item.mime_type || '') + clip;
      const thumb = item.thumbnail_path ? `/api/content/${esc(item.id)}/thumbnail` : null;
      return `
        <div class="add-item-row" data-id="${esc(item.id)}" data-type="content" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius);cursor:pointer;transition:background 0.1s">
          <div style="width:40px;height:30px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${thumb ? `<img data-auth-src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : '<div style="color:var(--text-muted);opacity:0.4"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(sub)}</div>
          </div>
          <button class="btn btn-primary btn-sm add-item-btn" data-id="${esc(item.id)}">${replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn')}</button>
        </div>
      `;
    }).join('');
    hydrateAuthImages(list, { eager: true });

    list.querySelectorAll('.add-item-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        commitItem({ content_id: btn.dataset.id }, btn, replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn'));
      });
    });
  }

  modal.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      modal.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
        b.classList.toggle('btn-secondary', b.dataset.tab !== activeTab);
        b.classList.toggle('active', b.dataset.tab === activeTab);
      });
      renderTab();
    });
  });

  document.getElementById('addItemSearch').addEventListener('input', renderTab);

  document.getElementById('closeAddModal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  renderTab();
}

// #74/#75: per-item schedule editor. Multiple blocks (days + time window + optional
// date range) OR together; an item with no blocks always plays. Client validation
// mirrors the server; saving marks the playlist DRAFT (must re-publish to reach devices).
// showScheduleModal moved to components/schedule-editor.js and now edits the FILE, not the list
// entry. See that file for why. The per-item endpoints stay: the agency API books a slot by
// creating an item with its own window, which is a booking rather than a property of the file.
