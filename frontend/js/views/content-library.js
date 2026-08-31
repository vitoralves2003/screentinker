import { api } from '../api.js';
import { showPrompt } from '../components/prompt-modal.js';
import { mountScheduleRulesEditor } from '../components/schedule-rules-editor.js';
import { showToast } from '../components/toast.js';
import { montarCampoContrato } from '../components/campo-contrato.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { createSelection, selectCell, selectHeaderCell, wireSelection, renderBulkBar } from '../bulk-select.js';

// #216: languages offered in the caption/subtitle pickers. Codes are BCP-47 primary tags —
// enough for signage; extend as needed.
const SUBTITLE_LANGS = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['ja', '日本語'],
  ['ko', '한국어'], ['zh', '中文'],
];

function formatFileSize(bytes) {
  if (!bytes) return '--';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// #157: classify a content item's expiry state for the card. `expired` when the server
// deactivated it (is_active===0) or its expires_at has passed; `dateLabel` is the local
// expiry date/time (present whenever expires_at is set, past or future).
function expiryInfo(c) {
  const hasExpiry = c.expires_at != null && c.expires_at !== '';
  const ts = hasExpiry ? Number(c.expires_at) * 1000 : null;
  const past = ts != null && ts <= Date.now();
  const expired = c.is_active === 0 || past;
  const dateLabel = ts != null
    ? new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  return { expired, dateLabel };
}

// Re-poll while a compression job is outstanding. One timer at a time, cleared by cleanup() when
// the view is torn down so a navigated-away library never keeps hitting the API.
let processingPoll = null;
function clearProcessingPoll() {
  if (processingPoll) { clearTimeout(processingPoll); processingPoll = null; }
}
function scheduleProcessingPoll(anyInFlight) {
  clearProcessingPoll();
  if (!anyInFlight) return;
  // 10s: a transcode takes tens of seconds at minimum, so anything tighter is just noise.
  processingPoll = setTimeout(() => { processingPoll = null; loadContent(); }, 10000);
}

// Loop OS media compression status, for the card. Deliberately NOT a blocking or error state:
// the asset is playable the whole time — the original bytes are served until the compressed
// version replaces them, and 'failed' just means the original is what stays. So this reads as
// an informational note, never as "this upload is broken". 'done' shows nothing at all, which
// is every image and every already-processed video.
/*
 * The scheduling clock beside a filename: on air, waiting its turn, or done.
 *
 * Three states and no fourth. A file with no schedule shows NOTHING — the absence is the signal
 * that it always plays, and a grey clock on every unscheduled file would make the list noisier
 * while saying less. The state is decided by the server (lib/schedule-state.js) so that the badge
 * and the player cannot disagree about what "on air" means.
 *
 * Colour alone is not the message: each clock carries a title, because a red and a green circle
 * eight pixels apart is exactly the distinction a colour-blind reader loses.
 */
const CLOCK_STATES = {
  active: { cls: 'is-active', key: 'No ar agora — dentro da programação' },
  pending: { cls: 'is-pending', key: 'Programado — fora do horário neste momento' },
  expired: { cls: 'is-expired', key: 'Programação encerrada — não entra mais no ar' },
};

function scheduleClock(c) {
  const s = CLOCK_STATES[c.schedule_state];
  if (!s) return '';
  const label = esc((s.key));
  /*
   * Drawn, not typed. The unicode clock characters render as full-colour emoji on Windows and
   * Android, which would ignore the state colour entirely and show the same yellow face for
   * "expired" and "on air".
   */
  return `<span class="sched-clock ${s.cls}" title="${label}" role="img" aria-label="${label}">
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7" fill="currentColor"/>
      <path d="M8 4.2V8.3l2.6 1.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
    </svg></span>`;
}

function processingBadge(c) {
  const s = c.processing_status;
  if (s === 'pending' || s === 'processing') {
    return `<div style="font-size:11px;color:var(--text-muted);margin-top:4px" title="Otimizando este vídeo em segundo plano. Ele já pode ser exibido.">
              <span class="processing-dot"></span>Processando…
            </div>`;
  }
  if (s === 'failed') {
    return `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;opacity:.75" title="Não foi possível comprimir — o arquivo original está sendo usado.">Não otimizado</div>`;
  }
  return '';
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Arquivos</h1>
        <div class="subtitle">Envie e organize suas mídias</div>
      </div>
      <button class="btn btn-primary" id="openAddFiles">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>Adicionar arquivos
      </button>
    </div>

    <!--
      The three ways in — drop a file, paste a URL, paste a YouTube link — behind a button.
      They occupied the top half of the page permanently to serve an action taken occasionally,
      while the library itself, which is what the page is FOR, was pushed below the fold.

      The markup is MOVED, not rebuilt: every handler downstream still finds #uploadArea,
      #fileInput exactly where it expects them. Rebuilding the upload path to gain a dialog would
      have risked the one flow on this page that must not break.
    -->
    <div class="modal-overlay" id="addFilesModal" style="display:none">
      <div class="modal" style="max-width:640px;width:95vw">
        <div class="modal-header">
          <h3>Adicionar arquivos</h3>
          <button class="btn-icon" id="closeAddFiles" aria-label="Fechar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
      <div class="upload-area" id="uploadArea" style="margin-bottom:0">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Solte os arquivos aqui ou clique para enviar</p>
        <p class="upload-hint">Suporta MP4, WebM, AVI, MKV, JPEG, PNG, GIF, WebP</p>
        <input type="file" id="fileInput" style="display:none" multiple accept="video/*,image/*">
        <div class="upload-progress" id="uploadProgress" style="display:none">
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px" id="uploadProgressText">Enviando...</p>
        </div>
        </div>
        </div>
      </div>
    </div>

    <div class="list-toolbar">
      <input type="text" id="contentSearch" class="input list-toolbar-search" placeholder="Buscar arquivos..." value="${esc(state.search)}">
      <select id="contentTypeFilter" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <option value="all" ${state.type === 'all' ? 'selected' : ''}>Todos os tipos</option>
        <option value="video" ${state.type === 'video' ? 'selected' : ''}>Vídeos</option>
        <option value="image" ${state.type === 'image' ? 'selected' : ''}>Imagens</option>
        <option value="youtube" ${state.type === 'youtube' ? 'selected' : ''}>YouTube</option>
        <option value="web" ${state.type === 'web' ? 'selected' : ''}>Web / remoto</option>
      </select>
      <select id="contentSort" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <option value="date_desc" ${state.sort === 'date_desc' ? 'selected' : ''}>Mais recentes</option>
        <option value="date_asc" ${state.sort === 'date_asc' ? 'selected' : ''}>Mais antigos</option>
        <option value="name" ${state.sort === 'name' ? 'selected' : ''}>Nome A–Z</option>
        <option value="size" ${state.sort === 'size' ? 'selected' : ''}>Maiores primeiro</option>
      </select>
      <span id="contentResultCount" class="list-toolbar-count"></span>
      <!-- Folders stay in the data model and the API; the create button leaves the surface
           because nobody was using it, and a control nobody uses is a control that only ever
           gets clicked by mistake. Hidden, not deleted — existing folders keep working. -->
      <button class="btn btn-secondary btn-sm" id="newFolderBtn" hidden style="display:none">+ Nova pasta</button>
      <!-- "Show expired" used to be a toggle here, defaulting to off. Expiry is becoming a
           billing control rather than something the customer sets, and a file hidden from its own
           library because it stopped playing is the one file its owner most needs to see. It is
           always shown now; the red clock and the "Vencido" line say why. -->
    </div>
    <div id="folderBreadcrumb" style="display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:13px;flex-wrap:wrap"></div>
    <div id="batchToolbar" style="display:none"></div>
    <div id="folderGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px"></div>
    <div class="content-grid" id="contentGrid">
      <div class="empty-state" style="grid-column:1/-1"><h3>Carregando...</h3></div>
    </div>
  `;

  // File upload handling
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // Remote URL handling
  // #214: search/type/sort now query the server so results span the whole workspace,
  // not just the items already rendered on the current page. Search is debounced to
  // avoid a request per keystroke.
  let searchTimer = null;
  /*
   * Open and close the add-files dialog. Closing on a successful add is handled by the upload and
   * URL paths themselves (they already call loadContent), so this only owns the surface.
   */
  const addModal = document.getElementById('addFilesModal');
  const closeAdd = () => { if (addModal) addModal.style.display = 'none'; };
  document.getElementById('openAddFiles').onclick = () => { addModal.style.display = 'flex'; };
  document.getElementById('closeAddFiles').onclick = closeAdd;
  // Clicking the backdrop closes; clicking the card must not, or dragging a file onto the
  // dropzone would dismiss the dialog under the cursor.
  addModal.onclick = (e) => { if (e.target === addModal) closeAdd(); };
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && addModal.style.display !== 'none') closeAdd();
  });

  document.getElementById('contentSearch').oninput = (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { state.search = v.trim(); loadContent(); }, 300);
  };
  document.getElementById('contentTypeFilter').onchange = (e) => { state.type = e.target.value; loadContent(); };
  document.getElementById('contentSort').onchange = (e) => { state.sort = e.target.value; loadContent(); };

  // Create folder in the current folder.
  const newFolderBtn = document.getElementById('newFolderBtn');
  if (newFolderBtn) newFolderBtn.onclick = async () => {
    const name = await showPrompt({
      title: 'Nome da pasta:',
      label: 'Nome da pasta:',
    });
    if (!name || !name.trim()) return;
    try {
      await api.createFolder(name.trim(), state.currentFolderId);
      showToast(`Pasta "${name}" criada`, 'success');
      loadContent();
    } catch (err) { showToast(err.message, 'error'); }
  };

  loadContent();
}

// View state — current folder navigation. Lives at module scope so the back button
// and other handlers can read it without threading it through every callback.
// One selection for the page, shared mechanics (see lib bulk-select.js).
const sel = createSelection();

const state = {
  currentFolderId: null, // null = root
  folders: [],           // all folders for this user (flat tree)
  // Expired and deactivated files are ALWAYS listed — see the toolbar comment. The flag is gone
  // rather than pinned to true so nothing can quietly turn it off again.
  search: '',            // #214: server-side text search (spans the whole workspace)
  type: 'all',           // #214: type filter — all | video | image | youtube | web
  sort: 'date_desc',     // #214: sort order — date_desc | date_asc | name | size

  lastClickedId: null,   // #213: anchor for shift-click range selection
};

async function handleFiles(files) {
  const list = Array.from(files);
  if (list.length === 0) return;
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  // #212: send all selected files in a single request with aggregate progress, instead
  // of one sequential XHR per file.
  progress.style.display = 'block';
  progressFill.style.width = '0%';
  const label = list.length === 1 ? list[0].name : `Enviando ${list.length} arquivos...`;
  progressText.textContent = label;

  try {
    await api.uploadContent(list, (pct) => {
      progressFill.style.width = pct + '%';
      progressText.textContent = `${label} — ${pct}%`;
    }, state.currentFolderId);
    showToast(
      list.length === 1
        ? `${list[0].name} enviado com sucesso`
        : `${list.length} arquivos enviados com sucesso`,
      'success'
    );
  } catch (err) {
    showToast(`Falha ao enviar ${label}: ${err.message}`, 'error');
  }

  progress.style.display = 'none';
  loadContent();
}

async function loadContent() {
  const grid = document.getElementById('contentGrid');
  const folderGrid = document.getElementById('folderGrid');
  const breadcrumb = document.getElementById('folderBreadcrumb');
  if (!grid || !folderGrid || !breadcrumb) return;

  try {
    const [content, folders] = await Promise.all([
      api.getContent(state.currentFolderId === null ? null : state.currentFolderId, true, {
        q: state.search, type: state.type, sort: state.sort,
      }),
      api.getFolders(),
    ]);
    state.folders = folders;

    // #214: while a search or type filter is active, results span the whole workspace,
    // so surface a count and note the folder scope no longer applies.
    const countEl = document.getElementById('contentResultCount');
    if (countEl) {
      const filtering = state.search || (state.type && state.type !== 'all');
      countEl.textContent = filtering
        ? `${content.length} resultado(s)`
        : '';
    }

    // Breadcrumb path: walk parent_id chain from current folder up to root.
    const folderById = new Map(folders.map(f => [f.id, f]));
    const path = [];
    let cursor = state.currentFolderId ? folderById.get(state.currentFolderId) : null;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parent_id ? folderById.get(cursor.parent_id) : null;
    }
    /*
     * At the root the trail is a single crumb reading "Todo o conteúdo" — a breadcrumb that says
     * only where you already are, above a table that is obviously all of it. Rendering nothing
     * lets :empty collapse the strip, so the content table starts where the playlists table does;
     * the trail returns the moment you are actually inside a folder and it means something.
     */
    breadcrumb.innerHTML = !state.currentFolderId ? '' : `
      <a href="#" data-folder-nav="" style="color:var(--text-secondary);text-decoration:none">Todos os arquivos</a>
      ${path.map(f => `
        <span style="color:var(--text-muted)">/</span>
        <a href="#" data-folder-nav="${f.id}" style="color:var(--text-primary);text-decoration:none">${esc(f.name)}</a>
      `).join('')}
      ${state.currentFolderId ? `
        <button class="btn btn-secondary btn-sm" id="renameFolderBtn" style="margin-left:auto">Renomear</button>
        <button class="btn btn-danger btn-sm" id="deleteFolderBtn">Excluir pasta</button>
      ` : ''}
    `;
    breadcrumb.querySelectorAll('[data-folder-nav]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.dataset.folderNav;
        state.currentFolderId = id || null;
        loadContent();
      });
      // Make breadcrumb segments drop targets too — otherwise the only way to move
      // a file out of a folder is via the edit modal. Dropping on "All Content"
      // moves to root; dropping on a parent name moves there.
      a.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/content-id')) return;
        e.preventDefault();
        a.style.background = 'var(--accent-ink)';
        a.style.color = '#fff';
        a.style.padding = '2px 8px';
        a.style.borderRadius = '4px';
      });
      a.addEventListener('dragleave', () => {
        a.style.background = '';
        a.style.color = '';
        a.style.padding = '';
        a.style.borderRadius = '';
      });
      a.addEventListener('drop', async (e) => {
        e.preventDefault();
        a.style.background = ''; a.style.color = ''; a.style.padding = ''; a.style.borderRadius = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        const targetFolderId = a.dataset.folderNav || null; // empty string = root
        try {
          await api.moveContent(contentId, targetFolderId);
          showToast(targetFolderId ? 'Movido' : 'Movido para a raiz', 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
    const renameBtn = breadcrumb.querySelector('#renameFolderBtn');
    if (renameBtn) renameBtn.onclick = async () => {
      const current = folderById.get(state.currentFolderId);
      const name = await showPrompt({
        title: 'Renomear pasta:',
        label: 'Renomear pasta:',
        value: current?.name || '',
      });
      if (!name || !name.trim() || name === current?.name) return;
      try {
        await api.renameFolder(state.currentFolderId, name.trim());
        showToast('Pasta renomeada', 'success');
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };
    const deleteBtn = breadcrumb.querySelector('#deleteFolderBtn');
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm('Excluir esta pasta? O conteúdo voltará para o nível raiz. Subpastas também serão excluídas.')) return;
      try {
        const parentId = folderById.get(state.currentFolderId)?.parent_id || null;
        await api.deleteFolder(state.currentFolderId);
        showToast('Pasta excluída', 'success');
        state.currentFolderId = parentId;
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };

    // Render subfolders of the current folder.
    const subfolders = folders.filter(f => (f.parent_id || null) === state.currentFolderId);
    folderGrid.innerHTML = subfolders.map(f => `
      <div class="folder-card" data-folder-id="${f.id}" data-name="${esc(f.name)}"
           style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px"
           data-drop-folder="${f.id}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div style="font-size:14px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
      </div>
    `).join('');
    folderGrid.querySelectorAll('.folder-card').forEach(card => {
      card.addEventListener('click', () => {
        state.currentFolderId = card.dataset.folderId;
        loadContent();
      });
      // Drop target for dragging content items into this folder.
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.outline = '2px solid var(--accent-ink)'; });
      card.addEventListener('dragleave', () => { card.style.outline = ''; });
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.style.outline = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        try {
          await api.moveContent(contentId, card.dataset.folderId);
          showToast('Movido', 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    if (!content.length) {
      grid.innerHTML = subfolders.length ? '' : `
        <div class="empty-state" style="grid-column:1/-1">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3>${state.currentFolderId ? 'Esta pasta está vazia' : 'Nenhum arquivo ainda'}</h3>
          <p>${state.currentFolderId ? 'Arraste o conteúdo para cá ou use a ação Mover.' : 'Envie vídeos e imagens para começar.'}</p>
        </div>
      `;
      return;
    }

    /*
     * A TABLE, not a grid of cards.
     *
     * A card grid is a browser: good for choosing a photograph, poor for managing a library. The
     * moment a customer has sixty files, the questions become "which of these is expiring", "how
     * much is this costing me in storage" and "delete these eleven" — all of which are columns you
     * scan and none of which a wall of thumbnails answers. The thumbnail stays, small, in the name
     * cell: it is how you recognise a video called FAENG.mp4, so it is identity, not decoration.
     */
    sel.order = content.map(c => c.id);
    grid.className = 'list-table-wrap';
    grid.innerHTML = `
    <table class="list-table">
      <thead>
        <tr>
          ${selectHeaderCell(sel)}
          <th>Nome</th>
          <th>Tipo</th>
          <th class="num">Duração</th>
          <th class="num">Tamanho</th>
          <th class="num">Dimensões</th>
        </tr>
      </thead>
      <tbody>
      ${content.map(c => {
        const exp = expiryInfo(c);
        const isYouTube = c.mime_type === 'video/youtube';
        const isVideo = !!c.mime_type?.startsWith('video/');
        const type = isYouTube ? 'YouTube'
          : c.remote_url ? 'URL remota'
          : isVideo ? 'Vídeo' : 'Imagem';
        const thumb = isYouTube && c.thumbnail_path
          ? `<img src="${esc(c.thumbnail_path)}" alt="" loading="lazy">`
          : c.thumbnail_path
            ? `<img data-auth-src="/api/content/${c.id}/thumbnail" alt="">`
            : `<span class="list-thumb-fallback">${isVideo ? '&#9654;' : '&#9635;'}</span>`;
        return `
        <tr class="list-row${exp.expired ? ' is-dim' : ''}" data-content-id="${c.id}" draggable="true">
          ${selectCell(sel, c.id)}
          <td>
            <div class="list-name">
              <span class="list-thumb" data-preview-content="${c.id}" title="${esc('Clique para pré-visualizar')}">${thumb}</span>
              <span class="list-name-text">
                <span class="list-name-main-row">${scheduleClock(c)}<span class="list-name-main is-clickable" data-edit-content="${c.id}" title="${esc('Editar')}">${esc(c.filename)}</span></span>
                ${exp.expired
                  ? `<span class="list-sub is-danger">Vencido${exp.dateLabel ? ` &middot; ${esc(exp.dateLabel)}` : ''}</span>`
                  : exp.dateLabel
                    ? `<span class="list-sub">${esc(`Vence em ${exp.dateLabel}`)}</span>` : ''}
                ${processingBadge(c)}
              </span>
            </div>
          </td>
          <td>${esc(type)}</td>
          <td class="num">${c.duration_sec ? `${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : '—'}</td>
          <td class="num">${c.file_size ? esc(formatFileSize(c.file_size)) : '—'}</td>
          <td class="num">${c.width && c.height ? `${c.width}&times;${c.height}` : '—'}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
    hydrateAuthImages(grid);

    // Drag-to-move survives the layout change: each row exposes its id, folder cards stay the
    // drop targets. Losing it would be a regression nobody asked for.
    grid.querySelectorAll('.list-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/content-id', row.dataset.contentId);
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    wireSelection(grid, sel, () => loadContent());

    // Delete handler via event delegation
    grid.onclick = async (e) => {
      // #213: ignore clicks originating on a selection checkbox (handled above).
      if (e.target.closest('.content-select-wrap')) return;
      // Preview on click (not on delete button)
      const previewTarget = e.target.closest('.content-item-preview');
      if (previewTarget) {
        const item = previewTarget.closest('.content-item');
        const id = item?.dataset.contentId;
        if (id) {
          const c = content.find(x => x.id === id);
          if (c) showPreview(c);
        }
        return;
      }

      // Edit button
      const editBtn = e.target.closest('[data-edit-content]');
      if (editBtn) {
        const id = editBtn.dataset.editContent;
        const c = content.find(x => x.id === id);
        if (c) showEditModal(c, loadContent);
        return;
      }

    };

    // #213: batch-operations toolbar reflects the current selection.
    renderBatchToolbar();

    // Video compression finishes on the server with no push to this view, so a card would sit
    // on "Processando…" until the operator happened to reload. Poll only while something is
    // actually in flight, and stop as soon as nothing is — no timer on a settled library.
    scheduleProcessingPoll(content.some(c => c.processing_status === 'pending' || c.processing_status === 'processing'));

  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Falha ao carregar o conteúdo</h3><p>${esc(err.message)}</p></div>`;
  }
}

/*
 * The batch toolbar, now built from the shared module so the three list pages behave identically.
 * The ACTIONS stay here: only this page knows that "move" means a folder and that both operations
 * have real batch endpoints behind them (#212/#213), so they act atomically server-side rather
 * than as a loop of requests.
 */
/*
 * The "add the selected files to a list" picker.
 *
 * Playlists are fetched ONCE, the first time the picker is opened, not on page load: most visits
 * to the library never touch it, and the listing endpoint carries per-playlist screen counts and
 * durations that are wasted on a name search.
 */
let playlistCache = null;

async function wireAddToPlaylist(bar, ids) {
  const input = bar.querySelector('#addToListInput');
  const results = bar.querySelector('#addToListResults');
  if (!input || !results) return;

  /*
   * The chosen lists survive typing. Filtering the visible rows must not silently drop a list that
   * was already ticked and has scrolled out of the filter — otherwise the count on the button and
   * what actually gets written disagree, which is the worst kind of quiet.
   */
  const picked = new Set();
  let onDocDown = null;

  function close() {
    results.hidden = true;
    if (onDocDown) { document.removeEventListener('mousedown', onDocDown); onDocDown = null; }
  }

  async function open() {
    if (!playlistCache) {
      try { playlistCache = await api.getPlaylists(); }
      catch (err) { showToast(err.message, 'error'); return; }
    }
    render();
    results.hidden = false;
    /*
     * Closed by a click ELSEWHERE, not by the input losing focus. With checkboxes inside, every
     * tick blurs the input, and a blur-close would shut the panel on the first one.
     */
    if (!onDocDown) {
      onDocDown = (e) => { if (!bar.contains(e.target)) close(); };
      document.addEventListener('mousedown', onDocDown);
    }
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const hits = playlistCache.filter((p) => !q || (p.name || '').toLowerCase().includes(q)).slice(0, 8);
    const rows = hits.length
      ? hits.map((p) => `<label class="bulk-picker-item">
            <input type="checkbox" data-playlist="${esc(p.id)}" ${picked.has(p.id) ? 'checked' : ''}>
            <span class="bulk-picker-name">${esc(p.name)}</span>
            <span class="bulk-picker-meta">${esc(`${p.item_count || 0} itens`)}</span>
          </label>`).join('')
      : `<div class="bulk-picker-empty">${esc('Nenhuma lista com esse nome')}</div>`;
    results.innerHTML = `${rows}
      <div class="bulk-picker-foot">
        <button type="button" class="btn btn-primary btn-sm" id="addToListGo" ${picked.size ? '' : 'disabled'}>
          ${esc(`Adicionar a ${picked.size} lista(s)`)}
        </button>
      </div>`;
  }

  input.oninput = () => { if (results.hidden) open(); else render(); };
  input.onfocus = open;
  input.onkeydown = (e) => { if (e.key === 'Escape') { close(); input.blur(); } };

  results.onchange = (e) => {
    const box = e.target.closest('[data-playlist]');
    if (!box) return;
    if (box.checked) picked.add(box.dataset.playlist); else picked.delete(box.dataset.playlist);
    // Only the button's label and enabled state change; re-rendering the rows here would fight
    // the checkbox the reader just clicked.
    const go = results.querySelector('#addToListGo');
    if (go) {
      go.disabled = picked.size === 0;
      go.textContent = `Adicionar a ${picked.size} lista(s)`;
    }
  };

  results.onclick = async (e) => {
    if (!e.target.closest('#addToListGo') || !picked.size) return;
    const chosen = [...picked];
    close();
    input.disabled = true;
    try {
      const r = await api.batchAddPlaylistItems(chosen, ids);
      /*
       * Say what happened, including the part nobody asked about: the lists are drafts now, so
       * nothing reaches a screen until they are published. Adding files and watching a screen not
       * change is the confusion this sentence exists to prevent.
       */
      const names = r.results.filter((x) => x.added).map((x) => x.name).join(', ')
        || r.results.map((x) => x.name).join(', ');
      const msg = r.skipped
        ? `${r.added} adicionado(s) a "${names}", ${r.skipped} já estava(m) na lista — publique para enviar às telas`
        : `${r.added} arquivo(s) adicionado(s) a "${names}" — publique a lista para enviar às telas`;
      showToast(msg, r.added ? 'success' : 'info');
      sel.ids.clear();
      sel.lastClicked = null;
      // The item counts in the cache are stale now, and the next open should show the truth.
      playlistCache = null;
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      input.disabled = false;
    }
  };
}

function renderBatchToolbar() {
  renderBulkBar(document.getElementById('batchToolbar'), sel, [
    /*
     * "Move to folder" used to be here. There is one folder — the library you are looking at —
     * and nobody had ever made a second one, so the control could only ever be clicked by mistake.
     * The folder plumbing underneath is untouched and dormant.
     */
    {
      id: 'add-to-playlist',
      // Type the list's name and pick it. A <select> of every playlist stops being usable at the
      // point a customer has thirty of them, and typing is how you find one you already know.
      html: () => `<span class="bulk-picker">
          <input type="text" id="addToListInput" class="input btn-sm" autocomplete="off"
            placeholder="${esc('Adicionar à lista…')}" style="width:230px;background:var(--bg-input)">
          <div id="addToListResults" class="bulk-picker-results" hidden></div>
        </span>`,
      wire: (bar, ids) => wireAddToPlaylist(bar, ids),
    },
    {
      id: 'delete',
      kind: 'danger',
      confirm: true,
      label: (count) => `Excluir (${count})`,
      confirmLabel: (count) => `Clique de novo para excluir ${count}`,
      run: async (ids) => {
        try {
          await api.batchDeleteContent(ids);
          showToast(`${ids.length} item(ns) excluído(s)`, 'success');
          sel.ids.clear();
          sel.lastClicked = null;
          loadContent();
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    },
  ], () => loadContent());
}

function showEditModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;
  const isYoutube = contentItem.mime_type === 'video/youtube';
  const isUploadedVideo = !isRemote && contentItem.mime_type?.startsWith('video/');
  // #216: language <option>s shared by the caption + subtitle pickers.
  const langOptions = (sel) => SUBTITLE_LANGS
    .map(([code, label]) => `<option value="${code}" ${sel === code ? 'selected' : ''}>${label}</option>`)
    .join('');

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;width:95vw">
      <div class="modal-header">
        <h3>Editar conteúdo</h3>
        <button class="btn-icon" id="closeEditModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Nome do arquivo / Exibição</label>
          <input type="text" id="editFilename" class="input" value="${esc(contentItem.filename)}">
        </div>
        <!--
          De qual contrato este arquivo é (Etapa 6). Preenchido depois da abertura, e só para
          quem tem Gestão — sem ela não existe contrato, e o campo seria uma pergunta sem
          resposta possível.
        -->
        <div id="editContratoHost"></div>
        ${isRemote ? `
        <div class="form-group" hidden>
          <label>URL remota</label>
          <input type="text" id="editRemoteUrl" class="input" value="${esc(contentItem.remote_url)}">
        </div>
        ` : ''}
        <div class="form-group" hidden>
          <label>Tipo MIME</label>
          <select id="editMimeType" class="input" style="background:var(--bg-input)">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>Vídeo (MP4)</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>Vídeo (WebM)</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>Imagem (JPEG)</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>Imagem (PNG)</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>Imagem (GIF)</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>Imagem (WebP)</option>
              ${['video/mp4','video/webm','image/jpeg','image/png','image/gif','image/webp'].includes(contentItem.mime_type) ? '' : `
              <!-- The item's ACTUAL type, for the cases the six choices above cannot express:
                   video/youtube, and uploads the sniffer accepts but this list omits (.mov, .svg,
                   .heic, .avif, .bmp). Without it no option matched, the browser selected the first
                   one - video/mp4 - and pressing Save with nothing else changed rewrote the item's
                   type. mime_type is the renderer selector in every player, so a YouTube item became
                   an "MP4" whose source is an embed page: a dead slide on every screen, and
                   unrecoverable here because there was no option to set it back. -->
              <option value="${esc(contentItem.mime_type || '')}" selected>${esc(contentItem.mime_type || '')}</option>`}
          </select>
        </div>
        <div class="form-group" hidden>
          <label>Pasta</label>
          <select id="editFolderId" class="input" style="background:var(--bg-input)">
            <option value="">— Raiz —</option>
            ${state.folders.map(f => `<option value="${f.id}" ${contentItem.folder_id === f.id ? 'selected' : ''}>${esc(folderPath(f, state.folders))}</option>`).join('')}
          </select>
        </div>
        <!-- The expiry date used to be edited here. It is becoming a BILLING control — the way an
             unpaid file stops playing — so it is not the customer's to set, and it now lives on
             the Administração page. It is still enforced exactly as before: past the instant, the
             file leaves every playlist.

             The save below must therefore leave expires_at ALONE. It cannot simply read the
             missing input: the old code reached for the field with optional chaining and fell
             back to an empty string, which reads exactly like "cleared" — and the server resets
             is_active=1 whenever expiry changes. Hiding the control naively would have meant any
             customer save silently un-blocking their own unpaid content. -->
        <div class="form-group">
          <label>Quando pode ser exibido</label>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">Escolha um tipo para adicionar uma regra. Regras do mesmo tipo somam; de tipos diferentes, todas precisam valer. Vale para todas as listas que contêm este arquivo. Sem nenhuma regra, ele toca sempre.</p>
          <!-- The editor is embedded, not a modal on top of this one. It used to open over the
               file dialog: two Cancel buttons and two Save buttons on screen, and the inner one
               wrote immediately while the outer one had its own Save — so a schedule could be
               stored and then apparently undone by pressing Cancelar underneath. One form, one
               Save. -->
          <div id="editScheduleHost"></div>
        </div>
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editUnstableConnection" ${contentItem.unstable_connection ? 'checked' : ''} style="width:auto;margin:0">
            <span>Conexão instável (limitar a 720p)</span>
          </label>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Limita o YouTube a 720p para que um Wi-Fi fraco ou instável trave menos. Deixe desligado para qualidade máxima.</p>
        </div>
        ` : ''}
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editCaptionsEnabled" ${contentItem.captions_enabled ? 'checked' : ''} style="width:auto;margin:0">
            <span>Ativar legendas</span>
          </label>
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">Idioma das legendas</label>
            <select id="editCaptionsLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.captions_lang || 'en')}</select>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Liga as legendas do YouTube no idioma escolhido em todas as telas. Depende de o vídeo ter legendas disponíveis.</p>
        </div>
        ` : ''}
        ${isUploadedVideo ? `
        <div class="form-group" hidden>
          <label>Arquivo de legenda (.vtt)</label>
          ${contentItem.subtitle_url ? `<p style="font-size:11px;color:var(--text-secondary);margin:2px 0 6px">Já existe uma legenda anexada. Escolha um novo arquivo para substituir.</p>` : ''}
          <input type="file" id="editSubtitleFile" accept=".vtt,text/vtt" style="font-size:13px;color:var(--text-secondary)">
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">Idioma da legenda</label>
            <select id="editSubtitleLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.subtitle_lang || 'en')}</select>
          </div>
          ${contentItem.subtitle_url ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px"><input type="checkbox" id="editSubtitleRemove" style="width:auto;margin:0"><span>Remover a legenda atual</span></label>` : ''}
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Envie um arquivo WebVTT (.vtt) para exibir legendas neste vídeo em todas as telas.</p>
        </div>
        ` : ''}
        ${!isRemote ? `
        <div class="form-group">
          <label>Substituir arquivo</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*" style="font-size:13px;color:var(--text-secondary)">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Deixe vazio para manter o arquivo atual</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="deleteContentBtn" style="margin-right:auto">Excluir</button>
        <button class="btn btn-secondary" id="previewContentBtn">Pré-visualizar</button>
        <button class="btn btn-secondary" id="cancelEditBtn">Cancelar</button>
        <button class="btn btn-primary" id="saveEditBtn">Salvar alterações</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#closeEditModal').onclick = () => overlay.remove();

  /*
   * Delete, confirmed in place rather than through a second dialog. The filename is on screen the
   * whole time — which the row button could never manage — so "delete which one?" answers itself,
   * and a modal stacked on a modal only trains people to click through both.
   */
  const delBtn = overlay.querySelector('#deleteContentBtn');
  delBtn.onclick = async () => {
    if (delBtn.dataset.confirming !== 'true') {
      delBtn.dataset.confirming = 'true';
      delBtn.textContent = 'Confirmar exclusão?';
      setTimeout(() => {
        // Back to the safe label: a half-pressed destructive button left on screen is a trap for
        // whoever walks up to the machine next.
        if (delBtn.dataset.confirming !== 'true') return;
        delBtn.dataset.confirming = 'false';
        delBtn.textContent = 'Excluir';
      }, 3000);
      return;
    }
    delBtn.disabled = true;
    delBtn.textContent = 'Excluindo...';
    try {
      await api.deleteContent(contentItem.id);
      showToast('Conteúdo excluído', 'success');
      overlay.remove();
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message, 'error');
      delBtn.disabled = false;
      delBtn.dataset.confirming = 'false';
      delBtn.textContent = 'Excluir';
    }
  };
  /*
   * The recurring rule, edited on the FILE.
   *
   * Saving marks every published playlist holding this file as draft rather than republishing
   * them behind the operator's back: a list may be mid-edit, and pushing someone else's
   * unfinished work to a wall because a schedule changed is a worse surprise than a "republish"
   * badge. The server reports how many are affected so the operator is told rather than left to
   * notice.
   */
  /*
   * Mounted, not opened. The editor reads its blocks now and hands them over when the form is
   * saved — see saveEditBtn below, which is the only thing in this dialog that writes.
   */
  /*
   * O CAMPO DE CONTRATO, montado depois de abrir -- e so para quem tem Gestao.
   *
   * Sem Gestao nao existe contrato, e o campo seria uma pergunta sem resposta possivel. Perguntar
   * o plano custa uma ida ao servidor que o dialogo nao espera: ele abre, e o campo aparece
   * quando a resposta chega. Falhar aqui simplesmente nao desenha o campo -- e melhor um campo a
   * menos que um dialogo que nao abre.
   */
  let campoContrato = null;
  (async () => {
    try {
      const assinatura = await api.getSubscription();
      if (!assinatura?.plan?.gestao_enabled) return;
      const host = overlay.querySelector("#editContratoHost");
      if (host) {
        campoContrato = montarCampoContrato(host, {
          contratoAtual: contentItem.contrato_id || null,
          nomeAtual: contentItem.contrato_nome || null,
        });
      }
    } catch (e) { /* sem plano, sem campo */ }
  })();

  let scheduleEditor = null;
  (async () => {
    let rules = [];
    try { rules = (await api.getScheduleRules(contentItem.id))?.rules || []; }
    catch (e) { /* nothing saved yet */ }
    const host = overlay.querySelector('#editScheduleHost');
    if (host) scheduleEditor = mountScheduleRulesEditor(host, rules);
  })();

  /*
   * A preview OVER the edit dialog, which is the one place stacking is right.
   *
   * The rule that took the schedule editor out of a modal-on-a-modal was about two FORMS: two
   * Save buttons and two Cancels on screen, the inner one writing immediately. A preview writes
   * nothing, has one way out, and "show me the file" is exactly what the button promises — so it
   * opens on top and hands focus back when it closes.
   */
  overlay.querySelector('#previewContentBtn').onclick = () => {
    showPreview(contentItem);
  };

  overlay.querySelector('#cancelEditBtn').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector('#saveEditBtn').onclick = async () => {
    /*
     * Blocks first, and refused BEFORE anything else is written if they do not validate. Saving
     * the name and the expiry and then rejecting the schedule would leave the dialog half
     * applied, with no way for the reader to tell which half.
     */
    let scheduleRules = null;
    if (scheduleEditor) {
      const { rules, error } = scheduleEditor.read();
      if (error) { showToast(error, 'error'); return; }
      scheduleRules = rules;
    }
    const filename = overlay.querySelector('#editFilename').value.trim();
    const mimeType = overlay.querySelector('#editMimeType').value;
    const remoteUrl = overlay.querySelector('#editRemoteUrl')?.value.trim();
    const replaceFile = overlay.querySelector('#editFileReplace')?.files[0];

    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: 'Bearer ' + token };

      // Update metadata
      const folderId = overlay.querySelector('#editFolderId')?.value || '';
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      /*
       * Expiry is sent ONLY when the control is on screen, which in this dialog it is not.
       * Omitting the key is the difference between "I did not touch it" and "I cleared it" — the
       * server treats any expires_at it receives as a change and resets is_active=1 with it, so a
       * blanket send would reactivate content that billing had stopped.
       */
      /*
       * O contrato so vai quando MUDOU -- `valor()` devolve undefined quando nada mudou. Mandar
       * a toa faria o servidor republicar as listas deste arquivo em toda gravacao, porque ele
       * trata qualquer contrato_id recebido como uma mudanca.
       */
      const contratoNovo = campoContrato?.valor();
      if (contratoNovo !== undefined) updateData.contrato_id = contratoNovo;

      const expiryInput = overlay.querySelector('#editExpiresAt');
      if (expiryInput) {
        const newExpiry = expiryInput.value ? Math.floor(new Date(expiryInput.value).getTime() / 1000) : null;
        const curExpiry = contentItem.expires_at != null ? Number(contentItem.expires_at) : null;
        if (newExpiry !== curExpiry) updateData.expires_at = newExpiry;
      }
      // #217: YouTube-only "unstable connection" quality cap.
      const unstableEl = overlay.querySelector('#editUnstableConnection');
      if (unstableEl) {
        const newUnstable = unstableEl.checked ? 1 : 0;
        if (newUnstable !== (contentItem.unstable_connection ? 1 : 0)) updateData.unstable_connection = newUnstable;
      }
      // #216: YouTube captions (checkbox + language).
      const captionsEl = overlay.querySelector('#editCaptionsEnabled');
      if (captionsEl) {
        const newCaptions = captionsEl.checked ? 1 : 0;
        if (newCaptions !== (contentItem.captions_enabled ? 1 : 0)) updateData.captions_enabled = newCaptions;
        const capLang = overlay.querySelector('#editCaptionsLang')?.value || null;
        if (capLang !== (contentItem.captions_lang || 'en')) updateData.captions_lang = capLang;
      }
      // #216: uploaded-video subtitle language change / removal (the FILE is sent separately below).
      const subtitleFile = overlay.querySelector('#editSubtitleFile')?.files[0];
      const subLangEl = overlay.querySelector('#editSubtitleLang');
      const subRemove = overlay.querySelector('#editSubtitleRemove')?.checked;
      if (subRemove) {
        updateData.subtitle_url = null;
        updateData.subtitle_lang = null;
      } else if (subLangEl && !subtitleFile) {
        // Lang-only change (no new file) — the upload endpoint handles lang when a file IS sent.
        const subLang = subLangEl.value || null;
        if (contentItem.subtitle_url && subLang !== (contentItem.subtitle_lang || 'en')) updateData.subtitle_lang = subLang;
      }

      if (Object.keys(updateData).length > 0) {
        await fetch('/api/content/' + contentItem.id, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
      }

      // #216: upload a new subtitle .vtt if one was chosen (skipped when "remove" is ticked).
      if (subtitleFile && !subRemove) {
        const subForm = new FormData();
        subForm.append('subtitle', subtitleFile);
        if (subLangEl?.value) subForm.append('subtitle_lang', subLangEl.value);
        await fetch('/api/content/' + contentItem.id + '/subtitle', {
          method: 'POST',
          headers,
          body: subForm
        });
      }

      overlay.remove();
      if (scheduleRules) {
        const r = await api.setScheduleRules(contentItem.id, scheduleRules);
        if (r?.playlists_to_republish) {
          showToast(`Horários salvos — ${r.playlists_to_republish} lista(s) precisam ser publicadas de novo`, 'info');
        }
      }
      showToast('Conteúdo atualizado', 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || 'Falha ao atualizar', 'error');
    }
  };
}

function showPreview(content) {
  const isYoutube = content.mime_type === 'video/youtube';
  const isVideo = !isYoutube && content.mime_type?.startsWith('video/');
  const src = content.remote_url || `/uploads/content/${content.filepath}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
      <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
      <div style="max-width:80vw;max-height:80vh">
        ${isYoutube
          ? `<iframe referrerpolicy="strict-origin-when-cross-origin" src="${(() => { /* #YT153 ROOT CAUSE: the dashboard sends Referrer-Policy: no-referrer (helmet default), so a raw YouTube iframe reaches youtube.com with NO Referer -> YouTube can't identify the embedding site -> "Video player configuration error" (153). referrerpolicy on THIS iframe overrides the page policy to send just our origin, which YouTube uses to validate the embed. (The device player dodges no-referrer differently: YT.Player's iframe_api origin postMessage handshake, which doesn't rely on Referer.) The enablejsapi/origin URL params are inert in a raw iframe (no API loaded), so they're dropped. */ try { const u = new URL(src); u.searchParams.set('mute', '1'); u.searchParams.delete('enablejsapi'); u.searchParams.delete('origin'); return u.toString(); } catch { return src; } })()}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>`
          : isVideo
            ? `<video src="${esc(src)}" controls autoplay style="max-width:80vw;max-height:80vh;display:block"></video>`
            : `<img src="${esc(src)}" style="max-width:80vw;max-height:80vh;display:block">`
        }
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-weight:500">${esc(content.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(content.mime_type)} ${content.remote_url ? `(URL remota)` : ''}</div>
      </div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#closePreview').onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// Build a "Parent / Child / Leaf" path for a folder so the move-to dropdown is unambiguous
// when two folders share a name in different branches.
function folderPath(folder, all) {
  const byId = new Map(all.map(f => [f.id, f]));
  const parts = [folder.name];
  let cursor = folder;
  while (cursor.parent_id && byId.has(cursor.parent_id)) {
    cursor = byId.get(cursor.parent_id);
    parts.unshift(cursor.name);
  }
  return parts.join(' / ');
}

export function cleanup() {
  // Drop the compression poll — otherwise navigating away leaves it re-fetching the library
  // (and re-rendering into a grid that is no longer on the page) until the job happens to end.
  clearProcessingPoll();
}
