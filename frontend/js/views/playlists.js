import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { createSelection, selectCell, selectHeaderCell, wireSelection, renderBulkBar, runEach } from '../bulk-select.js';
import { frameDeviceOutput, displayAspectRatio } from '../lib/device-frame.js';
import { abrirModalDeItens, WIDGET_CATALOGUE, CATALOGO, widgetName } from '../components/adicionar-itens-modal.js';
import { abrirEnviarPara } from '../components/enviar-para-modal.js';


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
  return new Date(ts * 1000).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', year: 'numeric' });
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

// As listas automaticas -- o espaco proprio de cada tela -- nao aparecem nesta pagina. Ela e a
// biblioteca do que se reaproveita, e o espaco de uma tela so se alcanca pela tela.

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Playlists</h1>
        <div class="subtitle">Crie e gerencie playlists de conteúdo</div>
      </div>
      <button class="btn btn-primary" id="createPlaylistBtn">+ Nova playlist</button>
    </div>
    <div id="playlistBulkBar" style="display:none"></div>
    <div class="list-toolbar">
      <input type="text" id="playlistSearch" class="input list-toolbar-search" placeholder="Buscar..." value="${esc(searchTerm)}">
      <span id="playlistResultCount" class="list-toolbar-count"></span>
      <!-- Aqui houve um botao "Mostrar autogeradas", ligado por padrao, que ninguem desligava. Ele
           saiu quando as automaticas deixaram de ser listadas: nao ha o que alternar. -->
    </div>
    <!-- The grid styling goes with the cards; the table brings its own wrapper class. -->
    <div id="playlistGrid">
      <div style="color:var(--text-muted);padding:40px;text-align:center">Carregando...</div>
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
    /*
     * O ESPACO PROPRIO DE UMA TELA NAO E UMA PLAYLIST -- e nao aparece aqui.
     *
     * Desde que a tela virou dona do proprio conteudo, cada uma ganha uma lista `is_auto_generated`
     * para guardar o que ela exibe. Elas apareciam nesta pagina com uma etiqueta "auto", ao lado
     * das listas que alguem montou, e o Vitor: "nenhuma playlist auto gerada deve ser exibida em
     * playlists".
     *
     * Esta pagina e a biblioteca do que se REAPROVEITA. O espaco de uma tela nao se reaproveita:
     * ele pertence aquela tela, so se alcanca por ela, e listado aqui vira uma linha que convida
     * a mexer no lugar errado -- editar "Bar do Porto playlist" e editar a tela Bar do Porto sem
     * que a pagina diga isso em lugar nenhum.
     *
     * O corte e AQUI e nao na rota: das dez telas que chamam getPlaylists(), uma delas
     * (device-detail, ao rotular uma lista restaurada) precisa justamente das automaticas. Cortar
     * no servidor apagaria esse rotulo sem dar erro.
     */
    /*
     * E a lista de um CONTRATO tambem nao aparece aqui, pelo mesmo motivo do espaco das telas:
     * esta pagina e a biblioteca do que se REAPROVEITA, e uma lista de contrato pertence aquele
     * contrato. Quem a procura nao pensa "playlist", pensa no nome do anunciante -- e a acha na
     * aba Midias do contrato, ou pelo tipo Contratos no seletor de destino.
     */
    const playlists = (await api.getPlaylists())
      .filter(p => !p.is_auto_generated && !p.contrato_id);
    if (!playlists.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 16px;display:block;opacity:0.4">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <h3 style="margin-bottom:8px;color:var(--text-primary)">Sem playlists ainda</h3>
          <p>Crie sua primeira playlist para organizar conteúdo para suas telas.</p>
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
          ${esc('Nenhuma playlist com esse nome')}
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
        ? '' : `exibindo ${filtered.length} de ${playlists.length}`;
    }
    grid.className = 'list-table-wrap';
    grid.innerHTML = `
    <table class="list-table">
      <thead>
        <tr>
          ${selectHeaderCell(plSel)}
          <th>Nome</th>
          <th class="num">Itens</th>
          <th class="num">Duração</th>
          <th class="num">Criada em</th>
        </tr>
      </thead>
      <tbody>
      ${filtered.map(p => {
        return `
        <tr class="list-row" data-playlist-id="${esc(p.id)}">
          ${selectCell(plSel, p.id)}
          <td>
            <a class="list-name-link" href="#/playlists/${esc(p.id)}">
              <span class="list-name-main">${esc(p.name)}</span>
            </a>
            ${p.description ? `<div class="list-sub">${esc(p.description)}</div>` : ''}
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
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);padding:40px;text-align:center">${`Falha ao carregar playlists: ${esc(err.message)}`}</div>`;
  }
}

function showCreateModal() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:400px;max-width:90vw">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">Nova playlist</h3>
      <input type="text" id="newPlaylistName" class="input" placeholder="Nome da playlist" style="width:100%;margin-bottom:12px" autofocus>
      <textarea id="newPlaylistDesc" class="input" placeholder="Descrição (opcional)" style="width:100%;height:60px;resize:vertical;margin-bottom:16px"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="cancelCreateBtn">Cancelar</button>
        <button class="btn btn-primary" id="confirmCreateBtn">Criar</button>
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
      showToast('Playlist criada');
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
    <div style="color:var(--text-muted);padding:40px;text-align:center">Carregando...</div>
  `;

  try {
    const playlist = await api.getPlaylist(playlistId);
    renderDetailContent(container, playlist);
  } catch (err) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text-muted)">
        <p>${`Falha ao carregar playlists: ${esc(err.message)}`}</p>
        <a href="#/playlists" class="btn btn-secondary" style="margin-top:16px">Voltar para playlists</a>
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
        <strong style="color:var(--text-primary)">Pré-visualizar — ${esc(playlist.name)}</strong>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" id="pvpLandscape">Paisagem (0°)</button>
          <button class="btn btn-secondary btn-sm" id="pvpPortrait">Retrato (90° SH)</button>
          <button class="btn btn-secondary btn-sm" id="pvpClose">Fechar</button>
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
          <button class="btn btn-secondary btn-sm" id="pvpPrev" disabled>&#8249; Anterior</button>
          <span id="pvpPosition" style="color:var(--text-muted);font-size:13px;min-width:110px;text-align:center">&nbsp;</span>
          <button class="btn btn-secondary btn-sm" id="pvpNext" disabled>Próximo &#8250;</button>
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
      position.textContent = d.zoned ? 'As zonas tocam juntas' : '';
      return;
    }
    btnPrev.disabled = btnNext.disabled = false;
    position.textContent = `${(d.index >= 0 ? d.index : 0) + 1} de ${d.total}`;
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
    return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Tela cheia — todo o conteúdo ocupa a tela inteira</div>`;
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
      border:1px solid ${filled ? 'var(--accent-ink)' : 'var(--border)'};
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
        <div>${`${(layout.zones.length) === 1 ? `1 zona` : `${layout.zones.length} zonas`}`}</div>
        ${layout._preview_ambiguous ? `<div style="color:var(--warning)">Há itens usando zonas de mais de um layout</div>` : ''}
      </div>
    </div>`;
}

function renderDetailContent(container, playlist) {

  container.innerHTML = `
    <!--
      A FAIXA "alterações não publicadas" SAIU, e com ela o Publicar e o Descartar.

      As listas aplicam na hora desde 31/08 (decisão do Vitor: "tudo já deveria ficar salvo e
      não ser preciso clicar em salvar ou publicar"), então não existe mais estado pendente —
      a faixa nunca apareceria.

      "Descartar alterações" é a perda real desta mudança: ele desfazia tudo desde a última
      publicação. Sem rascunho não há o que desfazer, e voltar atrás passa a ser tirar o item
      à mão. Fica escrito para não parecer descuido.
    -->

    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="#/playlists" style="color:var(--text-muted);text-decoration:none;font-size:20px" title="Voltar">&larr;</a>
        <div>
          <h1 id="playlistTitle" style="cursor:pointer" title="Clique para renomear">${esc(playlist.name)}</h1>
          <div class="subtitle" id="playlistDesc" style="cursor:pointer" title="Clique para editar a descrição">${playlist.description ? esc(playlist.description) : `<span style="opacity:0.5">Adicionar uma descrição...</span>`}</div>
          ${playlist.display_count ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${`${(playlist.display_count) === 1 ? `Atribuída a 1 tela` : `Atribuída a ${playlist.display_count} telas`}`}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="previewPlaylistBtn">Pré-visualizar</button>
        <button class="btn btn-primary" id="addItemBtn">+ Adicionar conteúdo</button>
        <button class="btn btn-secondary" id="duplicatePlaylistBtn">Duplicar playlist</button>
        <button class="btn btn-secondary" id="deletePlaylistBtn" style="color:var(--danger)">Excluir playlist</button>
      </div>
    </div>

    ${layoutMockup(playlist)}
    
    <div id="playlistItems" style="display:flex;flex-direction:column;gap:8px">
    </div>
  `;

  renderItems(playlist.items || []);

  const previewBtn = document.getElementById('previewPlaylistBtn');
  if (previewBtn) previewBtn.addEventListener('click', () => showPlaylistPreview(playlist));

  document.getElementById('playlistTitle').addEventListener('click', () => inlineEdit(playlist, 'name'));
  document.getElementById('playlistDesc').addEventListener('click', () => inlineEdit(playlist, 'description'));

  document.getElementById('addItemBtn').addEventListener('click', () => abrirModalDeItens({
    titulo: 'Adicionar conteúdo à playlist',
    playlistId: playlist.id,
    adicionar: (data) => api.addPlaylistItem(playlist.id, data),
    aoMudar: async () => {
      const atual = await api.getPlaylist(playlist.id);
      renderItems(atual.items || []);
      refreshAfterMutation();
    },
  }));

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
      showToast(`Copiada como "${copy.name}" — é um rascunho, publique para enviar às telas`);
      window.location.hash = `#/playlists/${copy.id}`;
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
    }
  });

  document.getElementById('deletePlaylistBtn').addEventListener('click', async () => {
    if (!confirm(`Excluir "${playlist.name}"? Isso não pode ser desfeito.`)) return;
    try {
      await api.deletePlaylist(playlist.id);
      showToast('Playlist excluída');
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
        <p style="margin-bottom:8px">Esta playlist está vazia</p>
        <p style="font-size:13px">${'Clique em "Adicionar conteúdo" para adicionar itens.'}</p>
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
        <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.filename || item.widget_name || 'Desconhecido')}</div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:8px;min-width:0">
          <span style="white-space:nowrap">${item.widget_id ? 'Widget' : esc(item.mime_type || 'Tipo desconhecido')}</span>
          ${item.sub_playlist_id ? `
          <!-- Only on a sub-list row: on anything else it would be a control with nothing to
               control. Changing it marks the playlist draft, like every other edit here. -->
          <select class="input item-sub-order" data-item-id="${item.id}"
                  title="${esc('Em sequência toca na ordem da lista. Aleatório embaralha, sem repetir um item antes de passar por todos.')}"
                  style="width:auto;padding:2px 6px;font-size:11px;background:var(--bg-input)">
            <option value="sequence" ${item.sub_order !== 'random' ? 'selected' : ''}>${esc('Em sequência')}</option>
            <option value="random" ${item.sub_order === 'random' ? 'selected' : ''}>${esc('Aleatório')}</option>
          </select>` : ''}
        </div>
      </div>
      <!--
        VÍDEO NÃO TEM DURAÇÃO EDITÁVEL — apontado pelo Vitor em 01/09, conferido no player:
        vídeo avança pelo onended (toca inteiro), e o duration_sec só comanda o avanço de
        imagem e widget. O campo num vídeo era um controle que mente: digitar 10 num clipe de
        26s não cortaria nada. Sub-lista idem: ela toca os próprios itens. O tempo vira
        informação, que é o que ele é — medido no envio, do próprio arquivo.
      -->
      ${(item.mime_type || '').startsWith('video') || item.sub_playlist_id ? `
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0"
           title="${esc('O vídeo toca inteiro — a duração é dele, medida no envio.')}">
        <span style="font-size:12px;color:var(--text-muted)">${item.duration_sec ? Math.ceil(item.duration_sec) + 's' : ''}</span>
      </div>` : `
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <label style="font-size:12px;color:var(--text-muted)">Duração</label>
        <input type="number" class="input item-duration" data-item-id="${item.id}" value="${item.duration_sec}" min="1" style="width:60px;padding:4px 8px;font-size:13px;text-align:center">
        <span style="font-size:12px;color:var(--text-muted)">seg</span>
      </div>`}
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        ${item.widget_id && widgetIsEditable(item.widget_type) ? `
        <button class="btn-icon item-widget-edit" data-item-id="${item.id}" data-widget-id="${esc(item.widget_id)}" data-widget-type="${esc(item.widget_type || '')}" title="Editar widget" aria-label="Editar widget" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
        </button>` : ''}
        <button class="btn-icon item-replace" data-item-id="${item.id}" title="Substituir conteúdo" aria-label="Substituir conteúdo" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
        <button class="btn-icon item-duplicate" data-item-id="${item.id}" title="Duplicar item" aria-label="Duplicar item" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="up" title="Mover para cima" aria-label="Mover para cima" ${i === 0 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === 0 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="down" title="Mover para baixo" aria-label="Mover para baixo" ${i === items.length - 1 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === items.length - 1 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="btn-icon item-remove" data-item-id="${item.id}" title="Excluir" aria-label="Remover item" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
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
        showToast('Ordem alterada — publique a lista para enviar às telas');
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
        showToast('Item removido');
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
        showToast('Item duplicado');
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
      abrirModalDeItens({
        titulo: 'Adicionar conteúdo à playlist',
        playlistId: currentPlaylistId,
        replaceItemId: itemId,
        adicionar: (data) => api.addPlaylistItem(currentPlaylistId, data),
        aoMudar: async () => {
          const atual = await api.getPlaylist(currentPlaylistId);
          renderItems(atual.items || []);
          refreshAfterMutation();
        },
      });
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
      newEl.title = 'Clique para renomear';
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
      newEl.title = 'Clique para editar a descrição';
      if (playlist.description) {
        newEl.textContent = playlist.description;
      } else {
        newEl.innerHTML = `<span style="opacity:0.5">Adicionar uma descrição...</span>`;
      }
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'description'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = current; input.blur(); } });
  }
}


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
            ${esc(CATALOGO[o.labelKey])}
          </label>`).join('')}
       </div>`
    : entry.ask.options
    ? `<select class="input" id="editWidgetValue" style="width:100%">
         ${entry.ask.options.map(o => `<option value="${esc(o.value)}"${o.value === currentValue ? ' selected' : ''}>${esc(CATALOGO[o.labelKey])}</option>`).join('')}
       </select>`
    : entry.ask.remote === 'cities'
      ? `<select class="input" id="editWidgetValue" style="width:100%"><option value="">${esc('Carregando...')}</option></select>`
      : `<input class="input" id="editWidgetValue" style="width:100%" value="${esc(currentValue)}">`;

  modal.innerHTML = `
    <div class="card" style="max-width:440px;width:92%;padding:24px" role="dialog" aria-modal="true">
      <h3 style="margin-bottom:4px;color:var(--text-primary)">${esc('Editar widget')}</h3>
      <p style="margin-bottom:16px;color:var(--text-muted);font-size:13px">${esc(CATALOGO[entry.key])}</p>
      <label style="display:block;margin-bottom:6px;font-size:13px;color:var(--text-muted)">${esc('O que mostrar')}</label>
      ${field}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
        <button class="btn btn-secondary" id="editWidgetCancel">${esc('Cancelar')}</button>
        <button class="btn btn-primary" id="editWidgetSave">${esc('Salvar')}</button>
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
      .catch(() => { select.innerHTML = `<option value="">${esc('Não foi possível carregar as cidades')}</option>`; });
  }

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#editWidgetCancel').addEventListener('click', close);

  modal.querySelector('#editWidgetSave').addEventListener('click', async (e) => {
    const value = multi
      ? [...multi.querySelectorAll('input:checked')].map(cb => cb.value)
      : (select.value || '').trim();
    if (multi && !value.length) {
      return showToast(CATALOGO[entry.key + '_pick_one'], 'error');
    }
    if (!multi && entry.ask.required && !value) {
      return showToast(CATALOGO[entry.key + '_required'], 'error');
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      // The label the operator just read in the dropdown, so a remote-picked city names the widget
      // "Previsão do tempo — Montanha" rather than "— montanha-es".
      const chosenLabel = !multi && select.tagName === 'SELECT' && select.selectedOptions[0]
        ? select.selectedOptions[0].textContent.trim()
        : value;
      await api.updateWidget(widgetId, {
        name: entry.ask.options ? widgetName(entry, value) : `${CATALOGO[entry.key]} — ${chosenLabel}`,
        config: mergedConfig(entry, config, value),
      });
      close();
      showToast('Widget atualizado', 'success');
      // The row shows the widget's name, and the name now carries the setting — redraw so the list
      // stops saying Mega-Sena after it has been changed to Lotofácil.
      await refreshAfterMutation();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Salvar';
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
      /*
       * A LISTA INTEIRA PARA VARIAS TELAS -- o mesmo seletor que a biblioteca usa, com o mesmo
       * componente. Duas copias divergiriam no dia em que alguem acrescentasse grupos a uma e
       * esquecesse a outra.
       *
       * Primeiro na fileira porque e o que se quer fazer com uma lista pronta: por no ar. E o
       * servidor recusa se o plano nao inclui -- por uma lista numa tela e Pro ou Master.
       */
      id: 'enviar-para-tela',
      /*
       * "Enviar para…" e nao "Enviar 3…".
       *
       * O rotulo com a contagem e reticencias -- "Enviar 1…" -- LE COMO TEXTO CORTADO, e foi
       * assim que o Vitor o descreveu: "mostrando apenas uma parte". Nao havia corte nenhum; a
       * reticencia depois de um numero parece um fim de palavra que nao coube.
       *
       * Com "para", a mesma reticencia vira uma pergunta em aberto -- para onde? -- que e
       * exatamente o que o botao faz. E a contagem era redundante: a barra ja diz quantos estao
       * selecionados, dois palmos a esquerda.
       */
      label: () => 'Enviar para…',
      run: async (ids) => {
        await abrirEnviarPara({
          titulo: `Enviar ${ids.length} playlist(s) para…`,
          // Sem 'listas': lista dentro de lista saiu em 31/08 -- é uma camada a mais para o
          // player resolver, e a tela já é onde as listas se juntam, lado a lado.
          permitir: ['grupos', 'telas'],
          enviar: ({ device_ids, group_ids }) =>
            api.batchAssign({ device_ids, group_ids, playlist_ids: ids }),
          aoEnviar: (r) => {
            showToast(`${r.postos} item(ns) em ${r.telas} tela(s) — já exibindo`, 'success');
            plSel.ids.clear();
            loadPlaylists();
          },
        });
      },
    },
    /*
     * A ação em massa "Publicar" saiu: as listas aplicam na hora, então não há o que publicar.
     * O envio para telas, logo acima, é o que se quer fazer com listas selecionadas.
     */
    /*
     * Duplicate, before delete so the destructive button stays last. Sequential like its
     * neighbours: firing N writes at a server that is also serving players is how a bulk action
     * becomes an outage. Every copy lands on no screen at all, so this needs no confirmation.
     */
    {
      id: 'duplicate',
      label: (count) => `${(count) === 1 ? `Duplicar 1` : `Duplicar ${count}`}`,
      run: async (ids) => {
        const { ok, failed } = await runEach(ids, (id) => api.duplicatePlaylist(id));
        showToast(failed.length ? `${ok} concluído(s), ${failed.length} com erro`
          : `${(ok) === 1 ? `1 playlist duplicada — as cópias são rascunhos` : `${ok} playlists duplicadas — as cópias são rascunhos`}`, failed.length ? 'error' : 'success');
        plSel.ids.clear();
        loadPlaylists();
      },
    },
    {
      id: 'delete',
      kind: 'danger',
      confirm: true,
      label: (count) => `${(count) === 1 ? `Excluir 1` : `Excluir ${count}`}`,
      confirmLabel: (count) => `${(count) === 1 ? `Confirmar exclusão de 1` : `Confirmar exclusão de ${count}`}`,
      run: async (ids) => {
        const { ok, failed } = await runEach(ids, (id) => api.deletePlaylist(id));
        showToast(failed.length ? `${ok} concluído(s), ${failed.length} com erro`
          : `${(ok) === 1 ? `1 playlist excluída` : `${ok} playlists excluídas`}`, failed.length ? 'error' : 'success');
        plSel.ids.clear();
        loadPlaylists();
      },
    },
  ], () => loadPlaylists());
}

/*
 * O MODAL DE ADICIONAR ITENS MUDOU DE CASA: components/adicionar-itens-modal.js.
 *
 * A tela passou a ser dona do proprio conteudo e precisava do mesmo seletor. Duas copias do
 * mesmo seletor divergem no dia em que alguem acrescenta um tipo de widget numa e esquece a
 * outra -- e o sintoma, "existe na playlist e nao existe na tela", ninguem liga a uma copia
 * feita meses antes.
 *
 * O catalogo de widgets foi junto, porque e dele que o modal se alimenta. Esta pagina ainda o
 * le em widgetFromType(), e por isso ele e importado de volta.
 */

// #74/#75: per-item schedule editor. Multiple blocks (days + time window + optional
// date range) OR together; an item with no blocks always plays. Client validation
// mirrors the server; saving marks the playlist DRAFT (must re-publish to reach devices).
// showScheduleModal moved to components/schedule-editor.js and now edits the FILE, not the list
// entry. See that file for why. The per-item endpoints stay: the agency API books a slot by
// creating an item with its own window, which is a booking rather than a property of the file.
