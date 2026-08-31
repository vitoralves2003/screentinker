// Add-User modal (#10). Creates a user account directly with an admin-set
// password and assigns them to a workspace + role (admin-provisioning for
// instances with no outbound email). Two open modes, ONE shared form:
//
//   openAddUserModal({ id, name }, opts)  -> fixed-workspace mode (members view).
//                                            No picker; assigns into that workspace.
//   openAddUserModal(null, opts)          -> picker mode (platform Users admin page).
//                                            Shows an Org/Workspace picker; the admin
//                                            chooses the target workspace.
//
//   opts.onSuccess: (result) => void  - fires on 201 (server response body)
//   opts.mapError:  (err) => string   - translates server error to display text
import { api } from '../api.js';

const PAPEL_MEMBRO = {
  'org_admin': 'Admin da organização',
  'org_owner': 'Dono da organização',
  'workspace_admin': 'Administrador',
  'workspace_editor': 'Editor',
  'workspace_viewer': 'Leitor',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Roles the picker offers. This is the SET POST /api/admin/users accepts
// (server: routes/admin.js WORKSPACE_ROLES) - keep them in sync so we never
// offer a value the endpoint 400s (the platform_operator dropdown/endpoint
// mismatch we already hit). Order here is display order (least-privilege first
// = the default selection); the server validates set membership, not order.
const WORKSPACE_ROLES = ['workspace_viewer', 'workspace_editor', 'workspace_admin'];

// Crockford-ish readable random password: avoids ambiguous chars (0/O, 1/l/I).
function generatePassword(len = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

function wsLabel(w) {
  return `${w.organization_name || '—'} / ${w.name}`;
}

export function openAddUserModal(workspace, opts = {}) {
  const { onSuccess, mapError } = opts;
  // Picker mode whenever no concrete target workspace was supplied.
  const pickerMode = !(workspace && workspace.id);

  const title = pickerMode
    ? 'Adicionar usuário'
    : `Adicionar usuário a ${esc(workspace.name)}`;

  const roleOptions = WORKSPACE_ROLES
    .map(r => `<option value="${r}">${esc(PAPEL_MEMBRO[r])}</option>`)
    .join('');

  // Workspace picker block — only rendered in picker mode. A filter input above
  // a <select> gives type-to-filter for the 70+ workspaces without a dependency.
  const workspaceGroup = pickerMode ? `
        <div class="form-group">
          <label for="addUserWs">Organização / Workspace</label>
          <input id="addUserWsFilter" type="text" class="input" placeholder="Filtrar workspaces…" style="width:100%;margin-bottom:6px" autocomplete="off" autocapitalize="off" spellcheck="false">
          <select id="addUserWs" class="input" style="width:100%">
            <option value="">Carregando workspaces…</option>
          </select>
        </div>` : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="btn-icon" type="button" data-add-close aria-label="Fechar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="addUserEmail">E-mail</label>
          <input id="addUserEmail" type="email" class="input" placeholder="usuario@exemplo.com" style="width:100%" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="form-group">
          <label for="addUserName">Nome</label>
          <input id="addUserName" type="text" class="input" placeholder="Nome completo (opcional)" style="width:100%" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="addUserPassword">Senha</label>
          <div style="display:flex;gap:8px">
            <input id="addUserPassword" type="text" class="input" placeholder="Defina uma senha" style="flex:1" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button class="btn btn-secondary" type="button" id="addUserGenerate" style="white-space:nowrap">Gerar</button>
          </div>
        </div>
        ${workspaceGroup}
        <div class="form-group">
          <label for="addUserRole">Função</label>
          <select id="addUserRole" class="input" style="width:100%">
            ${roleOptions}
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input id="addUserMustChange" type="checkbox" checked>
          Exigir troca de senha no primeiro acesso
        </label>
        <div id="addUserError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-add-close>Cancelar</button>
        <button class="btn btn-primary" type="button" id="addUserSubmit">Criar usuário</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector('#addUserEmail');
  const nameInput = overlay.querySelector('#addUserName');
  const pwInput = overlay.querySelector('#addUserPassword');
  const genBtn = overlay.querySelector('#addUserGenerate');
  const roleSelect = overlay.querySelector('#addUserRole');
  const mustChange = overlay.querySelector('#addUserMustChange');
  const errorEl = overlay.querySelector('#addUserError');
  const submitBtn = overlay.querySelector('#addUserSubmit');
  const wsSelect = overlay.querySelector('#addUserWs');     // null in fixed mode
  const wsFilter = overlay.querySelector('#addUserWsFilter');
  emailInput.focus();

  // Picker mode: load the workspaces this platform_admin can assign into from
  // /me's accessible_workspaces (already org+name shaped, all workspaces for a
  // platform_admin). Filter input rebuilds the option list live.
  let allWs = [];
  function renderWsOptions(filter) {
    const f = (filter || '').trim().toLowerCase();
    const matches = f ? allWs.filter(w => wsLabel(w).toLowerCase().includes(f)) : allWs;
    wsSelect.innerHTML = `<option value="">${esc('Selecione um workspace…')}</option>`
      + matches.map(w => `<option value="${esc(w.id)}">${esc(wsLabel(w))}</option>`).join('');
  }
  if (pickerMode) {
    api.getMe()
      .then(me => {
        allWs = Array.isArray(me?.accessible_workspaces) ? me.accessible_workspaces.slice() : [];
        if (!allWs.length) { wsSelect.innerHTML = `<option value="">${esc('Nenhum workspace disponível')}</option>`; return; }
        renderWsOptions('');
      })
      .catch(() => { wsSelect.innerHTML = `<option value="">${esc('Falha ao carregar os workspaces')}</option>`; });
    wsFilter.addEventListener('input', () => renderWsOptions(wsFilter.value));
  }

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-add-close]').forEach(b => b.addEventListener('click', close));
  genBtn.addEventListener('click', () => { pwInput.value = generatePassword(); pwInput.type = 'text'; });

  async function submit() {
    errorEl.style.display = 'none';
    const email = emailInput.value.trim().toLowerCase();
    const name = nameInput.value.trim();
    const password = pwInput.value;
    const role = roleSelect.value;
    const workspaceId = pickerMode ? (wsSelect.value || '') : workspace.id;
    if (!email || !EMAIL_RE.test(email)) { showError('Informe um e-mail válido.'); emailInput.focus(); return; }
    if (!password || password.length < 8) { showError('A senha precisa ter pelo menos 8 caracteres.'); pwInput.focus(); return; }
    if (pickerMode && !workspaceId) { showError('Selecione um workspace.'); (wsFilter || wsSelect).focus(); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Criando...';
    try {
      const result = await api.adminCreateUser({
        email, name, password, role,
        workspaceId,
        mustChangePassword: mustChange.checked,
      });
      close();
      if (typeof onSuccess === 'function') {
        try { onSuccess(result); }
        catch (e) { console.error('add-user modal onSuccess threw:', e); }
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Criar usuário';
      const msg = (typeof mapError === 'function')
        ? mapError(err)
        : (err?.message || `A ação falhou: ${''}`);
      showError(msg);
    }
  }

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  submitBtn.addEventListener('click', submit);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
