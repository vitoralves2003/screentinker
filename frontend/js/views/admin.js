import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { openManageWorkspacesModal } from '../components/admin-user-workspaces-modal.js';
import { openCreateOrgModal } from '../components/admin-create-org-modal.js';
import { openTypeToConfirmModal } from '../components/type-to-confirm-modal.js';
// Reuse the members view's server-error -> friendly-string mapper (handles the
// 409 duplicate-email / weak-password / invalid-email cases) so we don't fork a
// second mapper.
import { mapMutationError } from './workspace-members.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

// #14: the platform user-management dropdown manages users.role (the
// PLATFORM-level role) only - workspace/org roles are managed in the members
// views. Options are the current model; the legacy 'admin'/'superadmin' strings
// were normalized away. #13 adds 'platform_operator' (cross-org staff).
const PLATFORM_ROLE_OPTIONS = ['user', 'platform_operator', 'platform_admin'];

// Platform staff have cross-org access (no single workspace), so the Workspace
// column shows read-only "Platform (all)" for them. Note utils.isPlatformAdmin
// only covers admin/superadmin; operators are staff here too.
function isPlatformStaffRole(role) {
  return role === 'platform_admin' || role === 'superadmin' || role === 'platform_operator';
}

// Short summary of a user's workspace membership for the Users-table cell.
// Platform staff have cross-org access (not per-workspace membership) -> "Platform
// (all)". Otherwise: Unassigned (0), the workspace name (1), or "N workspaces".
function workspaceSummary(u) {
  if (isPlatformStaffRole(u.role)) return t('admin.workspace.platform_all');
  const count = u.workspace_count || 0;
  if (count === 0) return t('admin.workspace.unassigned');
  if (count === 1) return esc(u.workspace_name || '');
  return t('admin.workspace.multi', { n: count });
}

// Workspace cell: a summary + a "Manage" button that opens the full membership
// modal (add/remove workspaces, set per-workspace role). Manage is offered for
// everyone, including staff (you can grant them explicit memberships too).
function workspaceCell(u) {
  return `<td style="padding:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="color:var(--text-muted);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${workspaceSummary(u)}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-ws-manage="${esc(u.id)}">${t('admin.workspace.manage')}</button>
    </div>
  </td>`;
}

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>${t('admin.access_denied')}</h3><p>${t('admin.access_denied_desc')}</p></div>`;
    return;
  }

  const serverUrl = `${window.location.protocol}//${window.location.host}`;
  const widgetIsolationDisabled = !!user.current_organization?.widget_sandbox_isolation_disabled;
  // Typed-phrase confirmation. Translated with the modal it appears in: a warning in Portuguese
  // that demands an English sentence back reads like a bug, and the friction is the point — the
  // phrase has to be one the person can actually read before typing it.
  const WIDGET_ISOLATION_CONFIRM_PHRASE = t('settings.wsi.phrase');

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('admin.title')}</h1><div class="subtitle">${t('admin.subtitle')}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="adminCreateOrgBtn">${t('admin.create_org.button')}</button>
        <button class="btn btn-primary" id="adminAddUserBtn">${t('admin.add_user')}</button>
      </div>
    </div>

    <!-- Single sign-on removal approvals. First, because it is the only screen on this page an
         operator is DIRECTED to by an email, and because a tenant is locked out of their own
         product while it sits here. -->
    <div class="settings-section" id="ssoOnlySection" style="display:none">
      <h3>${t('admin.sso_only.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.sso_only.desc')}</p>
      <div id="ssoOnlyRequests"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.all_users')}</h3>
      <div id="allUsersTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.orgs.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.orgs.desc')}</p>
      <div id="orgsTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.branding.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.branding.desc')}</p>
      <div id="brandingForm"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.plans')}</h3>
      <div id="plansTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <!-- Per-organization SSO. It lived on the customer's Settings page, where it was offered to
         every tenant — signup makes each new account the org_owner of its own organization, so
         "can administer an organization" was no gate at all. Loop Player configures SSO for a
         customer that asks; it is not self-service, and misapplied SSO is one of the quickest ways
         for a tenant to lock itself out. It acts on the organization currently switched to. -->
    <div class="settings-section" id="ssoCard" style="display:none">
      <h3>${t('sso.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('sso.blurb')}</p>
      <div id="ssoList"></div>
      <details id="ssoAddDetails" style="margin-top:12px">
        <summary style="cursor:pointer;font-size:13px">${t('sso.add')}</summary>
        <div style="margin-top:12px;display:grid;gap:10px;max-width:560px">
          <div class="form-group"><label>${t('sso.f_name')}</label>
            <input type="text" id="ssoName" class="input" placeholder="Acme SSO"></div>
          <div class="form-group"><label>${t('sso.f_issuer')}</label>
            <input type="url" id="ssoIssuer" class="input" placeholder="https://login.example.com">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_issuer_hint')}</div></div>
          <div class="form-group"><label>${t('sso.f_client_id')}</label>
            <input type="text" id="ssoClientId" class="input"></div>
          <div class="form-group"><label>${t('sso.f_client_secret')}</label>
            <input type="password" id="ssoClientSecret" class="input" autocomplete="new-password">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_client_secret_hint')}</div></div>
          <div class="form-group"><label>${t('sso.f_domains')}</label>
            <input type="text" id="ssoDomains" class="input" placeholder="acme.com, acme.co.uk">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_domains_hint')}</div></div>
          <div><button class="btn btn-primary btn-sm" id="ssoCreateBtn">${t('sso.create')}</button></div>
        </div>
      </details>
    </div>

    <!-- API tokens. Machine access to a workspace is a real feature, but it is an integration
         surface with its own scopes and blast radius, and nothing in the current plans sells it —
         so it is issued by whoever runs the installation, not self-served from a customer page. -->
    <div class="settings-section">
      <h3>${t('apitoken.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.desc')}</p>
      <p style="font-size:13px;margin-bottom:16px"><a href="/docs" target="_blank" rel="noopener" style="color:var(--accent)">${t('apitoken.docs_link')}</a></p>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:180px">
          <label>${t('apitoken.col_name')}</label>
          <input type="text" id="tokName" class="input" placeholder="${esc(t('apitoken.name_placeholder'))}">
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:200px">
          <label>${t('apitoken.col_scope')}</label>
          <select id="tokScope" class="input" style="background:var(--bg-input)">
            <option value="read">${esc(t('apitoken.scope_read'))}</option>
            <option value="write">${esc(t('apitoken.scope_write'))}</option>
            <option value="full">${esc(t('apitoken.scope_full'))}</option>
            <option value="agency">${esc(t('apitoken.scope_agency'))}</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" id="createTokenBtn">${t('apitoken.create')}</button>
      </div>
      <div id="agencyPlaylistPicker" style="display:none;margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)">
        <label style="display:block;font-weight:500;margin-bottom:4px">${t('apitoken.agency_playlists_label')}</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_playlists_hint')}</p>
        <div id="agencyPlaylistList" style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto"></div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-weight:500">
          <input type="checkbox" id="tokAutoPublish"> ${t('apitoken.auto_publish_label')}
        </label>
        <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0">${t('apitoken.auto_publish_hint')}</p>
        <label style="display:block;font-weight:500;margin-top:12px;margin-bottom:4px">${t('apitoken.agency_folder_label')}</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_folder_hint')}</p>
        <select id="tokUploadFolder" class="input" style="width:100%"><option value="">${t('apitoken.agency_folder_auto')}</option></select>
      </div>
      <div id="tokenSecretBox" style="display:none"></div>
      <div id="tokenList"><p style="color:var(--text-muted);font-size:13px">${t('settings.loading_users')}</p></div>
      <div id="tokenEditPanel" style="display:none"></div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.security')}</h3>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="min-width:260px;flex:1">
          <div style="font-weight:600">${t('settings.widget_isolation')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
            ${t('settings.widget_isolation_desc')}
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="widgetSandboxIsolationToggle" ${widgetIsolationDisabled ? '' : 'checked'}>
          <span>${widgetIsolationDisabled ? t('settings.isolation_off') : t('settings.isolation_on')}</span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.system')}</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.status_debug.title')}</h3>
      <div id="statusDebugForm"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.install_stats')}</h3>
      <div id="telemetryBody"><p style="color:var(--text-muted);font-size:13px">${t('common.loading')}</p></div>
    </div>

    <!-- Where this install lives and how to point a panel at it. Self-hosting furniture: a
         subscriber neither runs the server nor pairs screens by typing its address. -->
    <div class="settings-section">
      <h3>${t('settings.server_info')}</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">${t('settings.server_url')}</div>
          <div class="info-card-value small">${serverUrl}</div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('settings.server_url_hint')}</p>
        </div>
        <div class="info-card">
          <div class="info-card-label">${t('settings.api_endpoint')}</div>
          <div class="info-card-value small">${serverUrl}/api</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.setup_guide')}</h3>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.8">
        <ol style="padding-left:20px;list-style:decimal">
          <li>${t('settings.setup_step_1')}</li>
          <li>${t('settings.setup_step_2_prefix')} <code style="background:var(--bg-input);padding:2px 6px;border-radius:4px">${serverUrl}</code></li>
          <li>${t('settings.setup_step_3')}</li>
          <li>${t('settings.setup_step_4')}</li>
          <li>${t('settings.setup_step_5')}</li>
          <li>${t('settings.setup_step_6')}</li>
        </ol>
      </div>
    </div>

    <!-- Import bulk-creates devices, content and playlists from an arbitrary dump: a migration
         tool for the operator. Export is the tenant's own data and stays on their Settings page. -->
    <div class="settings-section">
      <h3>${t('settings.import_data')}</h3>
      <button class="btn btn-secondary btn-sm" id="importDataBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        ${t('settings.import_data')}
      </button>
      <input type="file" id="importFileInput" accept=".json,.zip" style="display:none">
      <div id="importStatus" style="display:none;margin-top:12px;padding:12px;border-radius:var(--radius);font-size:13px"></div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.license')}</h3>
      <p style="color:var(--text-muted);font-size:13px">${t('settings.license_mit')}</p>
    </div>
  `;

  // Add User (#10): platform admin provisions a user into ANY workspace. The
  // page is platform_admin-gated; the modal opens in picker mode (no fixed
  // workspace) so the admin chooses the target org/workspace. The endpoint
  // additionally enforces canAdminWorkspace (platform_admin passes everywhere).
  document.getElementById('adminAddUserBtn')?.addEventListener('click', () => {
    openAddUserModal(null, {
      onSuccess: (result) => {
        showToast(t('members.success.user_created', { email: result.email }), 'success');
        loadUsers();
      },
      mapError: mapMutationError,
    });
  });

  // Create Organization (#35): platform admin provisions a new customer org +
  // its first workspace (owned by the admin). The modal reloads on success so
  // the new org shows up in the switcher.
  document.getElementById('adminCreateOrgBtn')?.addEventListener('click', () => {
    openCreateOrgModal({
      onSuccess: (result) => showToast(t('admin.create_org.success', { name: result.name }), 'success'),
    });
  });

  // ==================== API tokens ====================
  const fmtTokenDate = (ts) => {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return String(ts); }
  };
  const scopeLabel = (s) => ({
    read: t('apitoken.scope_read'),
    write: t('apitoken.scope_write'),
    full: t('apitoken.scope_full'),
    agency: t('apitoken.scope_agency'),
  }[s] || s);

  async function loadTokens() {
    const el = document.getElementById('tokenList');
    if (!el) return;
    const tokens = await api.getTokens().catch(() => []);
    if (!tokens.length) {
      el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('apitoken.none')}</p>`;
      return;
    }
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_token')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_name')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_scope')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_created')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_last_used')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500"></th>
          </tr>
        </thead>
        <tbody>
          ${tokens.map(tok => `
            <tr style="border-bottom:1px solid var(--border)${tok.revoked_at ? ';opacity:0.55' : ''}">
              <td style="padding:10px 12px;font-family:monospace">${esc(tok.prefix)}&hellip;</td>
              <td style="padding:10px 12px">${esc(tok.name || '')}</td>
              <td style="padding:10px 12px">${esc(scopeLabel(tok.scope))}${
                tok.scope === 'agency' && Array.isArray(tok.targets)
                  ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t('apitoken.targets_label')} ${tok.targets.length ? tok.targets.map(p => esc(p.name)).join(', ') : '—'}${tok.auto_publish ? ' · ' + esc(t('apitoken.auto_publish_on')) : ''}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t('apitoken.folder_label')} ${tok.upload_folder ? esc(tok.upload_folder) : esc(t('apitoken.folder_root'))}</div>`
                  : ''}</td>
              <td style="padding:10px 12px">${esc(fmtTokenDate(tok.created_at))}</td>
              <td style="padding:10px 12px">${tok.last_used_at ? esc(fmtTokenDate(tok.last_used_at)) : t('apitoken.never')}</td>
              <td style="padding:10px 12px;white-space:nowrap;text-align:right">
                ${tok.revoked_at
                  ? `<span style="color:var(--text-muted);font-size:12px">${t('apitoken.revoked')}</span>`
                  : `${tok.scope === 'agency' ? `<button class="btn btn-secondary btn-sm edit-targets-btn" data-id="${esc(String(tok.id))}" data-targets="${esc((tok.targets || []).map(p => p.id).join(','))}">${t('apitoken.edit_targets')}</button> <button class="btn btn-secondary btn-sm edit-folder-btn" data-id="${esc(String(tok.id))}" data-folder="${esc(String(tok.upload_folder_id || ''))}">${t('apitoken.edit_folder')}</button> ` : ''}<button class="btn btn-secondary btn-sm revoke-token-btn" data-id="${esc(String(tok.id))}">${t('apitoken.revoke')}</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;

    el.querySelectorAll('.revoke-token-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('apitoken.revoke_confirm'))) return;
        try {
          await api.revokeToken(btn.dataset.id);
          showToast(t('apitoken.revoked_toast'), 'success');
          loadTokens();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // #73: edit an agency token's playlist designations -> PUT /:id/targets (atomic re-designate).
    el.querySelectorAll('.edit-targets-btn').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const current = new Set((btn.dataset.targets || '').split(',').filter(Boolean));
      const panel = document.getElementById('tokenEditPanel');
      const pls = await api.getPlaylists().catch(() => []);
      panel.style.display = 'block';
      panel.innerHTML = `
        <div style="border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.edit_targets')}</h4>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;margin-bottom:12px">
            ${pls.length
              ? pls.map(p => p.zoned
                  ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc(t('apitoken.zoned_playlist_reason'))}</span></label>`
                  : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="edit-pl" value="${esc(String(p.id))}"${current.has(String(p.id)) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')
              : `<p style="color:var(--text-muted);font-size:12px">${t('apitoken.agency_no_playlists')}</p>`}
          </div>
          <button class="btn btn-primary btn-sm" id="saveTargetsBtn">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" id="cancelTargetsBtn">${t('common.cancel')}</button>
        </div>`;
      document.getElementById('saveTargetsBtn').onclick = async () => {
        const ids = [...panel.querySelectorAll('.edit-pl:checked')].map(c => c.value);
        if (!ids.length) return showToast(t('apitoken.agency_needs_playlists'), 'error');
        try {
          await api.setTokenTargets(id, ids);
          showToast(t('apitoken.targets_updated'), 'success');
          panel.style.display = 'none';
          loadTokens();
        } catch (err) { showToast(err.message, 'error'); }
      };
      document.getElementById('cancelTargetsBtn').onclick = () => { panel.style.display = 'none'; };
    }));

    // #158: rebind an agency token's upload folder -> PUT /:id/upload-folder (null = root).
    el.querySelectorAll('.edit-folder-btn').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const current = btn.dataset.folder || '';
      const panel = document.getElementById('tokenEditPanel');
      const folders = await api.getFolders().catch(() => []);
      panel.style.display = 'block';
      panel.innerHTML = `
        <div style="border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.edit_folder')}</h4>
          <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_folder_hint')}</p>
          <select id="rebindFolder" class="input" style="width:100%;margin-bottom:12px">
            <option value="">${t('apitoken.folder_root')}</option>
            ${folders.map(f => `<option value="${esc(String(f.id))}"${String(f.id) === current ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="saveFolderBtn">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" id="cancelFolderBtn">${t('common.cancel')}</button>
        </div>`;
      document.getElementById('saveFolderBtn').onclick = async () => {
        try {
          await api.setTokenUploadFolder(id, document.getElementById('rebindFolder').value || null);
          showToast(t('apitoken.folder_updated'), 'success');
          panel.style.display = 'none';
          loadTokens();
        } catch (err) { showToast(err.message, 'error'); }
      };
      document.getElementById('cancelFolderBtn').onclick = () => { panel.style.display = 'none'; };
    }));
  }

  // #73: agency scope reveals a playlist picker (the token's allowlist). Loaded lazily once.
  const tokScopeSel = document.getElementById('tokScope');
  let agencyPlaylistsLoaded = false;
  tokScopeSel?.addEventListener('change', async () => {
    const picker = document.getElementById('agencyPlaylistPicker');
    const isAgency = tokScopeSel.value === 'agency';
    picker.style.display = isAgency ? 'block' : 'none';
    if (isAgency && !agencyPlaylistsLoaded) {
      agencyPlaylistsLoaded = true;
      const list = document.getElementById('agencyPlaylistList');
      const pls = await api.getPlaylists().catch(() => []);
      list.innerHTML = pls.length
        ? pls.map(p => p.zoned
            ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc(t('apitoken.zoned_playlist_reason'))}</span></label>`
            : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="agency-pl" value="${esc(String(p.id))}"> ${esc(p.name)}</label>`).join('')
        : `<p style="color:var(--text-muted);font-size:12px">${t('apitoken.agency_no_playlists')}</p>`;
      // #158: offer existing folders to bind, or leave on the auto-create default.
      const folders = await api.getFolders().catch(() => []);
      const fsel = document.getElementById('tokUploadFolder');
      if (fsel && folders.length) fsel.insertAdjacentHTML('beforeend', folders.map(f => `<option value="${esc(String(f.id))}">${esc(f.name)}</option>`).join(''));
    }
  });

  document.getElementById('createTokenBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('tokName').value.trim();
    const scope = document.getElementById('tokScope').value;
    const payload = { name, scope };
    if (scope === 'agency') {
      const ids = [...document.querySelectorAll('#agencyPlaylistList .agency-pl:checked')].map(c => c.value);
      if (!ids.length) return showToast(t('apitoken.agency_needs_playlists'), 'error');
      payload.target_playlist_ids = ids;
      payload.auto_publish = !!document.getElementById('tokAutoPublish')?.checked;
      // #158: blank = auto-create "Agency — <name>"; a value binds that existing folder.
      const fv = document.getElementById('tokUploadFolder')?.value;
      if (fv) payload.upload_folder_id = fv;
    }
    const btn = document.getElementById('createTokenBtn');
    btn.disabled = true;
    try {
      const r = await api.createToken(payload);
      const box = document.getElementById('tokenSecretBox');
      box.style.display = 'block';
      // #73: for agency tokens, surface the handoff (portal URL + a copyable invite). The key
      // is in the invite TEXT, never in a URL (Cloudflare logs query strings + chat apps unfurl
      // links). window.location.origin is the real public host the admin is on (correct behind CF).
      const portalUrl = window.location.origin + '/agency';
      const inviteText = t('apitoken.invite_text', { url: portalUrl, key: r.token });
      box.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-bottom:16px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.secret_title')}</h4>
          <p style="color:var(--danger);font-size:12px;margin-bottom:12px"><strong>${t('apitoken.secret_warning')}</strong></p>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="input" readonly value="${esc(r.token)}" style="font-family:monospace;flex:1" onclick="this.select()">
            <button class="btn btn-secondary btn-sm" id="copyTokenBtn">${t('apitoken.copy')}</button>
          </div>
          ${scope === 'agency' ? `
          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
            <label style="font-size:12px;color:var(--text-muted)">${t('apitoken.portal_url_label')}</label>
            <input type="text" class="input" readonly value="${esc(portalUrl)}" style="width:100%;margin-top:4px" onclick="this.select()">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-top:10px">${t('apitoken.invite_label')}</label>
            <textarea class="input" readonly rows="2" style="width:100%;margin-top:4px;font-size:13px;font-family:inherit" onclick="this.select()">${esc(inviteText)}</textarea>
            <button class="btn btn-secondary btn-sm" id="copyInviteBtn" style="margin-top:8px">${t('apitoken.copy_invite')}</button>
          </div>` : ''}
        </div>
      `;
      document.getElementById('copyTokenBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          showToast(t('apitoken.copied'), 'success');
        } catch { /* clipboard may be unavailable; the field is selectable */ }
      });
      document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteText); // full "go here + paste key" text
          showToast(t('apitoken.copied'), 'success');
        } catch { /* field is selectable as a fallback */ }
      });
      document.getElementById('tokName').value = '';
      showToast(t('apitoken.created_toast'), 'success');
      loadTokens();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ==================== Widget sandbox isolation ====================
  document.getElementById('widgetSandboxIsolationToggle')?.addEventListener('change', async (e) => {
    const checkbox = e.currentTarget;
    const shouldEnableIsolation = !!checkbox.checked;
    const workspaceId = user.current_workspace_id;
    if (!workspaceId) {
      checkbox.checked = !shouldEnableIsolation;
      showToast('No active workspace', 'error');
      return;
    }

    if (!shouldEnableIsolation) {
      const confirmed = await openWidgetSandboxDisableConfirmModal(WIDGET_ISOLATION_CONFIRM_PHRASE);
      if (!confirmed) {
        checkbox.checked = true;
        return;
      }
      try {
        await api.updateWorkspaceSecuritySettings(workspaceId, {
          widgetSandboxIsolationDisabled: true,
          confirmationPhrase: WIDGET_ISOLATION_CONFIRM_PHRASE,
        });
        const nextUser = { ...user, current_organization: { ...(user.current_organization || {}), widget_sandbox_isolation_disabled: 1 } };
        localStorage.setItem('user', JSON.stringify(nextUser));
        showToast('Widget sandbox isolation disabled', 'success');
      } catch (err) {
        checkbox.checked = true;
        showToast(err.message, 'error');
      }
      return;
    }

    try {
      await api.updateWorkspaceSecuritySettings(workspaceId, { widgetSandboxIsolationDisabled: false });
      const nextUser = { ...user, current_organization: { ...(user.current_organization || {}), widget_sandbox_isolation_disabled: 0 } };
      localStorage.setItem('user', JSON.stringify(nextUser));
      showToast('Widget sandbox isolation enabled', 'success');
    } catch (err) {
      checkbox.checked = false;
      showToast(err.message, 'error');
    }
  });

  // ==================== Data import ====================
  document.getElementById('importDataBtn')?.addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';
    const statusEl = document.getElementById('importStatus');
    statusEl.style.display = 'block';
    statusEl.style.background = 'var(--bg-secondary)';
    statusEl.style.border = '1px solid var(--border)';
    statusEl.style.color = 'var(--text-secondary)';
    statusEl.textContent = t('settings.import.reading_file');
    try {
      let data;
      if (isZip) {
        // For ZIP, show basic info and skip preview parsing
        data = { format: 'screentinker-export-v1', _isZip: true };
        statusEl.innerHTML = `${t('settings.import.zip_detected', { name: esc(file.name), size: (file.size / 1048576).toFixed(1) })}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">${t('settings.import.confirm')}</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">${t('common.cancel')}</button>`;
      } else {
        const text = await file.text();
        data = JSON.parse(text);
        if (!data.format || !data.format.startsWith('screentinker-export')) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = t('settings.import.invalid_file');
          return;
        }
        const summary = [
          data.devices?.length ? t('settings.import.summary_devices', { n: data.devices.length }) : null,
          data.content?.length ? t('settings.import.summary_content', { n: data.content.length }) : null,
          data.widgets?.length ? t('settings.import.summary_widgets', { n: data.widgets.length }) : null,
          data.layouts?.length ? t('settings.import.summary_layouts', { n: data.layouts.length }) : null,
          data.schedules?.length ? t('settings.import.summary_schedules', { n: data.schedules.length }) : null,
          data.video_walls?.length ? t('settings.import.summary_walls', { n: data.video_walls.length }) : null,
          data.kiosk_pages?.length ? t('settings.import.summary_kiosk', { n: data.kiosk_pages.length }) : null,
        ].filter(Boolean).join(', ');
        statusEl.innerHTML = `${t('settings.import.found_summary', { summary: esc(summary) || t('settings.import.empty_export'), email: esc(data.user?.email) || t('common.unknown'), date: esc(data.exported_at?.split('T')[0]) || t('common.unknown') })}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">${t('settings.import.confirm')}</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">${t('common.cancel')}</button>`;
      }
      document.getElementById('cancelImportBtn').onclick = () => { statusEl.style.display = 'none'; e.target.value = ''; };
      document.getElementById('confirmImportBtn').onclick = async () => {
        statusEl.innerHTML = isZip ? t('settings.import.uploading_zip') : t('settings.import.importing');
        try {
          const token = localStorage.getItem('token');
          let res;
          if (isZip) {
            const formData = new FormData();
            formData.append('file', file);
            res = await fetch('/api/status/import', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            });
          } else {
            res = await fetch('/api/status/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(data),
            });
          }
          const result = await res.json();
          if (res.ok) {
            const imported = Object.entries(result.stats).filter(([k,v]) => v > 0 && k !== 'files_restored').map(([k,v]) => `${v} ${k}`).join(', ');
            statusEl.style.color = 'var(--success)';
            let html = t('settings.import.complete', { imported });
            if (result.device_pairings?.length) {
              html += `<br><br><strong>${t('settings.import.pairing_codes_title')}</strong><br><table style="margin-top:8px;font-size:12px;border-collapse:collapse">` +
                result.device_pairings.map(d => `<tr><td style="padding:4px 12px 4px 0">${esc(d.name)}</td><td style="font-family:monospace;font-weight:700;font-size:14px;letter-spacing:2px">${d.pairing_code}</td></tr>`).join('') +
                `</table><br>${t('settings.import.pairing_codes_hint')}`;
            }
            html += `<br><br>${(result.notes || []).map(n => '&bull; ' + n).join('<br>')}`;
            statusEl.innerHTML = html;
            showToast(t('settings.toast.import_success'), 'success');
          } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = result.error || t('settings.import.failed');
          }
        } catch (err) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = t('settings.import.failed_with_error', { error: err.message });
        }
        e.target.value = '';
      };
    } catch (err) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = t('settings.import.read_failed', { error: err.message });
    }
  });

  /*
   * Install statistics. Shows the ACTUAL payload rather than a description of it — the whole
   * proposition is "you can check instead of trusting us", and the code is public, so a sentence
   * that didn't match the bytes would be found. Also shows what was last really sent.
   */
  async function loadTelemetry() {
    const box = document.getElementById('telemetryBody');
    if (!box) return;
    let info;
    try { info = await api.adminGetTelemetry(); }
    catch { box.innerHTML = `<p style="color:var(--text-muted);font-size:13px">Unavailable.</p>`; return; }

    const on = info.state === 'on';
    const sent = info.last_report
      ? `Last sent ${new Date(info.last_report.at * 1000).toLocaleString()}.`
      : 'Nothing has been sent yet.';

    // A blocked outbound connection is the normal failure on a self-hosted box, and it is
    // otherwise invisible — the operator just sees nothing arriving. Name the failure and the
    // host, so the fix is "allow this in the firewall" rather than "guess".
    const failed = on && info.last_error;
    const why = failed
      ? ({ network: 'the connection was refused or the address did not resolve',
           timeout: 'the connection timed out' }[info.last_error.reason]
         || `the server replied ${esc(info.last_error.reason)}`)
      : '';

    box.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
        The upstream project can't see how widely it's deployed, because most installs are private
        by design. Sharing lets it say how many screens are running — nothing more.
      </p>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <input type="checkbox" id="telemetryToggle" ${on ? 'checked' : ''}>
        Share install statistics
      </label>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:6px">
        Everything that would be sent, in full:
      </p>
      <pre style="background:var(--bg-input,rgba(0,0,0,.2));padding:10px;border-radius:var(--radius);font-size:12px;overflow-x:auto;margin-bottom:8px">${esc(JSON.stringify(info.payload, null, 2))}</pre>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:${info.extra_endpoint ? '4' : '8'}px">
        ${on ? 'Sent once a day to' : 'When enabled, sent once a day to'}
        <code style="font-size:11px">${esc(info.endpoint || '')}</code>. If this server's outbound
        traffic is filtered, that address has to be allowed or the reports never arrive.
      </p>
      ${info.extra_endpoint ? `
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
        A second copy also goes to your own collector at
        <code style="font-size:11px">${esc(info.extra_endpoint)}</code>, configured on this server
        with <code style="font-size:11px">TELEMETRY_EXTRA_ENDPOINT</code>. That is in addition to
        the above, not instead of it — turn the switch off if you want your own statistics without
        sharing.
      </p>` : ''}
      ${failed ? `
      <p style="font-size:12px;color:var(--danger);margin-bottom:8px">
        The last attempt (${esc(new Date(info.last_error.at * 1000).toLocaleString())}) did not get
        through — ${why}. Check that outbound HTTPS to that address is permitted.
      </p>` : ''}
      <p style="color:var(--text-muted);font-size:12px">
        No names, addresses, content, or user details. The ID is random and identifies the install
        only so repeat reports aren't counted twice. ${esc(sent)}
      </p>
    `;

    document.getElementById('telemetryToggle')?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        // Turning it on sends immediately, so a blocked firewall is reported here and now rather
        // than failing quietly tonight — say so plainly instead of a cheerful success toast.
        const r = await api.adminSetTelemetry(enabled);
        if (!enabled) showToast('Install statistics off', 'success');
        else if (r.first_report && r.first_report.sent) showToast('Shared — thank you', 'success');
        else showToast('Saved, but the first report did not get through — see below', 'error');
        loadTelemetry();
      } catch {
        e.target.checked = !enabled;
        showToast('Could not save that setting', 'error');
      }
    });
  }

  /* ── Per-organization SSO ──────────────────────────────────────────────────────────────────
   *
   * Acts on the organization currently switched to. The server enforces the same rule (and
   * answers 404, not 403, so an outsider learns nothing) — this just avoids showing a card that
   * cannot be used.
   */
  const orgId = user.current_organization?.id;
  const canManageSso = orgId && ['org_owner', 'org_admin'].includes(user.current_org_role);

  async function loadSso() {
    const card = document.getElementById('ssoCard');
    if (!card || !canManageSso) return;
    card.style.display = '';
    const listEl = document.getElementById('ssoList');
    let providers = [];
    try {
      const res = await fetch(`/api/organizations/${orgId}/sso`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error('load failed');
      providers = (await res.json()).providers || [];
    } catch {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('sso.load_failed'))}</p>`;
      return;
    }

    if (!providers.length) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('sso.none'))}</p>`;
      return;
    }

    // Requiring SSO is a separate decision from having it, so it gets its own block rather than
    // hiding inside a provider — an organization may have several providers and one answer.
    let onlyState = null;
    try {
      const r = await fetch(`/api/organizations/${orgId}/sso-only`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (r.ok) onlyState = await r.json();
    } catch { /* the providers still render; the toggle simply does not appear */ }

    const origin = `${window.location.protocol}//${window.location.host}`;
    listEl.innerHTML = providers.map((p) => `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div>
            <strong>${esc(p.name)}</strong>
            ${p.enabled ? '' : `<span style="font-size:11px;color:var(--text-muted)"> — ${esc(t('sso.disabled'))}</span>`}
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(p.issuer)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${esc(t('sso.domains_label'))}: ${esc(p.email_domains || '—')}</div>
            ${((p.domains || []).some((d) => !d.verified) || (p.domains || []).length === 0)
              ? `<div style="font-size:12px;color:var(--warning,#b45309);margin-top:2px">⚠️ ${esc(t('sso.unverified_warning'))}</div>`
              : ''}
          </div>
          <!-- wrap, do not shrink-to-clip: at 375px this row ran to x=417 on a 375px viewport and
               the page does not scroll horizontally, so "Remove" was simply unreachable. -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-secondary btn-sm" data-sso-test="${esc(p.id)}">${esc(t('sso.test'))}</button>
            <button class="btn btn-secondary btn-sm" data-sso-edit="${esc(p.id)}">${esc(t('sso.edit'))}</button>
            <button class="btn btn-secondary btn-sm" data-sso-toggle="${esc(p.id)}" data-enabled="${p.enabled ? '1' : '0'}">
              ${esc(p.enabled ? t('sso.disable') : t('sso.enable'))}
            </button>
            <button class="btn btn-danger btn-sm" data-sso-delete="${esc(p.id)}">${esc(t('sso.delete'))}</button>
          </div>
        </div>
        <!-- The admin has to paste this into their identity provider, and it must match character
             for character, so it is shown rather than described. -->
        <div style="margin-top:8px;font-size:12px">
          <div style="color:var(--text-muted)">${esc(t('sso.callback_label'))}</div>
          <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px">${esc(origin + p.callback_url)}</code>
        </div>

        <!-- Editing is per provider, because an organization may have several (one per domain, or
             one per identity provider after a merger) and they are configured independently. -->
        <!-- Domain proof. A claimed domain routes NOBODY until DNS confirms the organization
             controls it, so the state of each one is shown plainly rather than left to be inferred
             from a login that silently does not work. -->
        ${(p.domains || []).length ? `
        <div style="margin-top:10px;font-size:12px">
          <div style="color:var(--text-muted);margin-bottom:4px">${esc(t('sso.domains_heading'))}</div>
          ${p.domains.map((d, di) => `
            <div style="border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div><strong>${esc(d.domain)}</strong>
                  ${d.verified
                    ? `<span style="color:var(--success,#15803d)"> — ${esc(t('sso.domain_verified'))}</span>`
                    : `<span style="color:var(--warning,#b45309)"> — ${esc(t('sso.domain_pending'))}</span>`}
                </div>
                ${d.verified ? '' : `<button class="btn btn-secondary btn-sm" data-sso-verify="${esc(p.id)}" data-domain="${esc(d.domain)}" data-di="${di}">${esc(t('sso.verify_now'))}</button>`}
              </div>
              ${d.verified ? '' : `
                <div style="margin-top:6px;color:var(--text-muted)">${esc(t('sso.dns_instructions'))}</div>
                <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px;margin-top:4px">${esc(d.record_name)}  TXT  ${esc(d.txt_value)}</code>
`}
              <!-- ONE place for the outcome. The last failure is persisted server-side and was
                   rendered here, while the click handler wrote the live result into a second
                   element below it — so retrying showed the identical sentence twice, in two
                   different colours. The handler replaces this element's text instead. -->
              <div id="ssoVerify-${esc(p.id)}-${di}" style="margin-top:4px;color:var(--danger,#b91c1c)">${d.verified ? '' : esc(d.last_error || '')}</div>
            </div>`).join('')}
        </div>` : ''}

        <div id="ssoTest-${esc(p.id)}" style="display:none;margin-top:8px;font-size:12px"></div>
        <div id="ssoEdit-${esc(p.id)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:none">
          <div style="display:grid;gap:10px;max-width:560px">
            <div class="form-group"><label>${esc(t('sso.f_name'))}</label>
              <input type="text" class="input" data-f="name" value="${esc(p.name)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_issuer'))}</label>
              <input type="url" class="input" data-f="issuer" value="${esc(p.issuer)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_client_id'))}</label>
              <input type="text" class="input" data-f="client_id" value="${esc(p.client_id)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_client_secret'))}</label>
              <input type="password" class="input" data-f="client_secret" autocomplete="new-password"
                     placeholder="${esc(p.has_client_secret ? t('sso.secret_set') : t('sso.secret_none'))}">
              <!-- A secret can never be shown back: the API does not return it. Blank therefore means
                   "leave it alone" rather than "clear it", which is what stops a save from silently
                   wiping a working configuration. Clearing is a separate, explicit choice. -->
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(t('sso.secret_edit_hint'))}</div>
              ${p.has_client_secret ? `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px">
                <input type="checkbox" data-f="clear_secret"> ${esc(t('sso.secret_clear'))}
              </label>` : ''}
            </div>
            <div class="form-group"><label>${esc(t('sso.f_domains'))}</label>
              <input type="text" class="input" data-f="email_domains" value="${esc(p.email_domains)}"></div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" data-sso-save="${esc(p.id)}">${esc(t('sso.save'))}</button>
              <button class="btn btn-secondary btn-sm" data-sso-cancel="${esc(p.id)}">${esc(t('sso.cancel'))}</button>
            </div>
          </div>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('[data-sso-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await ssoRequest('PUT', `/${btn.dataset.ssoToggle}`, { enabled: btn.dataset.enabled !== '1' });
      });
    });
    /*
     * Ask the server to look for the DNS record now. Pull-based on purpose: the admin has just
     * edited DNS and wants an answer, and a failure has to say WHICH failure — not published yet,
     * published wrong, or the claim expired and the record has changed underneath them.
     */
    if (onlyState) {
      const pend = onlyState.pending_removal_request;
      const box = document.createElement('div');
      box.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:4px';
      box.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px">${esc(t('sso.only_heading'))}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc(t('sso.only_help'))}</div>
        ${onlyState.sso_only ? `
          <div style="font-size:13px;margin-bottom:8px">✅ ${esc(t('sso.only_on'))}</div>
          ${pend
            ? `<div style="font-size:12px;color:var(--warning,#b45309)">⏳ ${esc(t('sso.only_pending'))}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyCancel" data-req="${esc(pend.id)}" style="margin-top:6px">${esc(t('sso.only_cancel'))}</button>`
            : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${esc(t('sso.only_remove_help'))}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyRequest">${esc(t('sso.only_request'))}</button>`}
        ` : `
          <div style="font-size:13px;margin-bottom:8px">${esc(t('sso.only_off'))}</div>
          ${onlyState.verified_domains
            ? `<button class="btn btn-secondary btn-sm" id="ssoOnlyEnable">${esc(t('sso.only_enable'))}</button>`
            : `<div style="font-size:12px;color:var(--warning,#b45309)">⚠️ ${esc(t('sso.only_needs_domain'))}</div>`}
        `}`;
      listEl.appendChild(box);

      const post = async (url, body, method = 'POST') => {
        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || t('sso.only_failed'), 'error'); return null; }
        return j;
      };

      const enableBtn = box.querySelector('#ssoOnlyEnable');
      if (enableBtn) enableBtn.addEventListener('click', async () => {
        // Confirmed, because it removes the only way in for everyone at these domains, and the way
        // back needs the operator rather than this button.
        if (!window.confirm(t('sso.only_confirm'))) return;
        const r = await post(`/api/organizations/${orgId}/sso-only`);
        if (r) {
          showToast(t('sso.only_on'), 'success');
          /*
           * Name the people who just lost their only way in. The server reports them precisely so
           * the admin finds out HERE rather than from a support ticket — and it was being thrown
           * away, which made the whole warning pointless.
           */
          const stranded = r.stranded_members || [];
          if (stranded.length) {
            window.alert(t('sso.only_stranded', { list: stranded.join('\n') }));
          }
          await loadSso();
        }
      });

      const reqBtn = box.querySelector('#ssoOnlyRequest');
      if (reqBtn) reqBtn.addEventListener('click', async () => {
        const reason = window.prompt(t('sso.only_reason_prompt')) || '';
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request`, { reason });
        if (r) { showToast(t('sso.only_requested'), 'success'); await loadSso(); }
      });

      const cancelBtn = box.querySelector('#ssoOnlyCancel');
      if (cancelBtn) cancelBtn.addEventListener('click', async () => {
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request/${cancelBtn.dataset.req}`, null, 'DELETE');
        if (r) { showToast(t('sso.only_cancelled'), 'success'); await loadSso(); }
      });
    }

    listEl.querySelectorAll('[data-sso-verify]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.ssoVerify;
        const domain = btn.dataset.domain;
        // Indexed, not derived from the domain: `a.b.test` and `a-b.test` both slugify to
        // `a-b-test`, and getElementById would put one domain's answer in the other's box.
        const out = document.getElementById(`ssoVerify-${id}-${btn.dataset.di}`);
        btn.disabled = true;
        if (out) { out.style.color = 'var(--text-muted)'; out.textContent = t('sso.verifying'); }
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/domains/${encodeURIComponent(domain)}/verify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const body = await res.json().catch(() => ({}));
          if (body.ok) {
            showToast(t('sso.domain_verified_toast', { domain }), 'success');
            await loadSso();       // re-render: the domain now routes, and the card must say so
            return;
          }
          // An expired claim has already been reissued server-side, so the records on screen are
          // stale — reload rather than leaving the admin publishing a value that no longer matches.
          if (body.expired) {
            showToast(body.error || t('sso.verify_failed'), 'error');
            await loadSso();
            return;
          }
          if (out) { out.style.color = 'var(--danger,#b91c1c)'; out.textContent = body.error || t('sso.verify_failed'); }
        } catch {
          if (out) { out.style.color = 'var(--danger,#b91c1c)'; out.textContent = t('sso.verify_failed'); }
        } finally {
          btn.disabled = false;
        }
      });
    });
    listEl.querySelectorAll('[data-sso-test]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.ssoTest;
        const out = document.getElementById(`ssoTest-${id}`);
        if (!out) return;
        out.style.display = '';
        out.textContent = t('sso.testing');
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/test`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const data = await res.json();
          if (!res.ok) { out.textContent = data.error || t('sso.test_failed'); return; }
          /*
           * Literal keys, never a key built by concatenating a check name. Doing that defeats the
           * check in server/test/i18n-keys-exist.js that every key an operator can see is
           * translated — and a check name the UI does not know would render as raw key text. The
           * fallback keeps an unknown one readable instead.
           */
          const CHECK_LABELS = {
            discovery: t('sso.check_discovery'),
            endpoints: t('sso.check_endpoints'),
            signing_keys: t('sso.check_signing_keys'),
          };
          const rows = (data.checks || []).map((c) => `
            <div>${c.ok ? '✅' : '❌'} ${esc(CHECK_LABELS[c.name] || c.name)} — <span style="color:var(--text-muted)">${esc(c.detail || '')}</span></div>`).join('');
          /*
           * The caveat is shown on SUCCESS, not tucked away. Discovery and keys prove the provider
           * exists and that we could verify a token it signs — they say nothing about whether the
           * client id, the secret, or the redirect URI registration are right. A green tick that
           * implied "SSO works" would send an admin away from the one thing still to check.
           */
          out.innerHTML = rows + (data.ok
            ? `<div style="margin-top:6px;color:var(--text-muted)">${esc(t('sso.test_caveat'))}</div>`
            : '');
        } catch {
          out.textContent = t('sso.test_failed');
        }
      });
    });
    listEl.querySelectorAll('[data-sso-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoEdit}`);
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    });
    listEl.querySelectorAll('[data-sso-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoCancel}`);
        if (panel) panel.style.display = 'none';
      });
    });
    listEl.querySelectorAll('[data-sso-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoSave}`);
        if (!panel) return;
        const val = (f) => panel.querySelector(`[data-f="${f}"]`)?.value?.trim() ?? '';
        const body = {
          name: val('name'),
          issuer: val('issuer'),
          client_id: val('client_id'),
          email_domains: val('email_domains'),
        };
        /*
         * Three states, and only these three:
         *   typed a value        -> replace the secret
         *   ticked "remove"      -> send '' so the server clears it
         *   left blank, unticked -> send NOTHING, so the stored secret survives
         * Sending '' on every save is the bug this shape exists to avoid.
         */
        const typed = panel.querySelector('[data-f="client_secret"]')?.value || '';
        const clearing = panel.querySelector('[data-f="clear_secret"]')?.checked;
        if (typed) body.client_secret = typed;
        else if (clearing) body.client_secret = '';

        if (!body.name || !body.issuer || !body.client_id) {
          showToast(t('sso.missing_fields'), 'error');
          return;
        }
        await ssoRequest('PUT', `/${btn.dataset.ssoSave}`, body);
      });
    });
    listEl.querySelectorAll('[data-sso-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('sso.confirm_delete'))) return;
        await ssoRequest('DELETE', `/${btn.dataset.ssoDelete}`);
      });
    });
  }

  async function ssoRequest(method, path = '', body) {
    try {
      const res = await fetch(`/api/organizations/${orgId}/sso${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      // The server's message is the useful one here — a bad issuer or a domain already claimed by
      // another organization both say exactly what went wrong, and a generic failure would not.
      if (!res.ok) { showToast(data.error || t('sso.save_failed'), 'error'); return false; }
      // "Saved" for a DELETE read as though nothing had been destroyed.
      showToast(t(method === 'DELETE' ? 'sso.removed' : 'sso.saved'), 'success');
      await loadSso();
      return true;
    } catch {
      showToast(t('sso.save_failed'), 'error');
      return false;
    }
  }

  document.getElementById('ssoCreateBtn')?.addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('ssoName').value.trim(),
      issuer: document.getElementById('ssoIssuer').value.trim(),
      client_id: document.getElementById('ssoClientId').value.trim(),
      client_secret: document.getElementById('ssoClientSecret').value,
      email_domains: document.getElementById('ssoDomains').value.trim(),
    };
    if (!payload.name || !payload.issuer || !payload.client_id) {
      showToast(t('sso.missing_fields'), 'error');
      return;
    }
    if (await ssoRequest('POST', '', payload)) {
      ['ssoName', 'ssoIssuer', 'ssoClientId', 'ssoClientSecret', 'ssoDomains']
        .forEach((id) => { document.getElementById(id).value = ''; });
      document.getElementById('ssoAddDetails').open = false;
    }
  });

  loadUsers();
  loadOrgs();
  loadSsoOnlyRequests();
  loadBranding();
  loadPlans();
  loadSso();
  loadTokens();
  loadSystem();
  loadStatusDebug();
  loadTelemetry();

}

function openWidgetSandboxDisableConfirmModal(confirmationPhrase) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="width:min(760px,96vw)">
        <div class="modal-header"><h3>${t('settings.wsi.title')}</h3></div>
        <div class="modal-body" style="white-space:pre-wrap;line-height:1.45">${t('settings.wsi.body')}
          <div class="form-group" style="margin-top:16px">
            <label for="widgetSandboxConfirmInput">${t('settings.wsi.type_phrase')}</label>
            <div style="margin:6px 0 8px;font-weight:600">${esc(confirmationPhrase)}</div>
            <input id="widgetSandboxConfirmInput" type="text" class="input" autocomplete="off">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="widgetSandboxConfirmCancel">${t('common.cancel')}</button>
          <button class="btn btn-danger" id="widgetSandboxConfirmSubmit" disabled>${t('settings.wsi.confirm_btn')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#widgetSandboxConfirmInput');
    const submit = overlay.querySelector('#widgetSandboxConfirmSubmit');
    const close = (ok) => {
      overlay.remove();
      resolve(ok);
    };
    const updateEnabled = () => {
      submit.disabled = input.value.trim() !== confirmationPhrase;
    };
    input.addEventListener('input', updateEnabled);
    overlay.querySelector('#widgetSandboxConfirmCancel').addEventListener('click', () => close(false));
    submit.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
  });
}

// #36: list organizations with owner + resource counts; platform admin can
// cascade-delete an org or an individual workspace (type-the-name confirm).
/*
 * Pending "stop requiring single sign-on" requests.
 *
 * The notification email tells the operator to review this under Admin, and for a while it did not
 * exist — the only way to approve was curl, while the customer sat locked out. The section hides
 * itself when there is nothing pending so it is never noise.
 */
async function loadSsoOnlyRequests() {
  const section = document.getElementById('ssoOnlySection');
  const host = document.getElementById('ssoOnlyRequests');
  if (!section || !host) return;
  // NB: `api` is a map of named methods, not a generic client — there is no api.get(), and calling
  // one silently hid this whole section behind the catch below.
  const authed = (path, init = {}) => fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...(init.headers || {}) },
  });

  let requests = [];
  try {
    const res = await authed('/organizations/sso-only/removal-requests');
    if (!res.ok) throw new Error(String(res.status));
    requests = (await res.json()).requests || [];
  } catch {
    section.style.display = 'none';
    return;
  }
  // Clear as well as hide: leaving the last decided request in the tree kept its live
  // Approve/Reject listeners attached to a request that no longer exists.
  if (!requests.length) { host.innerHTML = ''; section.style.display = 'none'; return; }
  section.style.display = '';

  host.innerHTML = requests.map((r) => `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
      <div><strong>${esc(r.organization_name || r.organization_id)}</strong></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
        ${esc(t('admin.sso_only.requested_by', { who: r.requested_by_email || 'unknown' }))}
      </div>
      ${r.reason ? `<div style="font-size:12px;margin-top:6px">${esc(r.reason)}</div>` : ''}
      <div style="font-size:12px;color:var(--warning,#b45309);margin-top:8px">${esc(t('admin.sso_only.effect'))}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-danger btn-sm" data-sso-approve="${esc(r.id)}">${esc(t('admin.sso_only.approve'))}</button>
        <button class="btn btn-secondary btn-sm" data-sso-reject="${esc(r.id)}">${esc(t('admin.sso_only.reject'))}</button>
      </div>
    </div>`).join('');

  const decide = async (id, decision) => {
    try {
      const res = await authed(`/organizations/sso-only/removal-requests/${id}/${decision}`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || String(res.status));
      showToast(t(decision === 'approve' ? 'admin.sso_only.approved' : 'admin.sso_only.rejected'), 'success');
      await loadSsoOnlyRequests();
    } catch (e) {
      showToast((e && e.message) || t('admin.sso_only.failed'), 'error');
    }
  };
  // Approving RE-OPENS password sign-in for a whole organization, so it is confirmed; rejecting
  // only leaves the safe state in place and is not.
  host.querySelectorAll('[data-sso-approve]').forEach((b) => b.addEventListener('click', () => {
    if (window.confirm(t('admin.sso_only.confirm'))) decide(b.dataset.ssoApprove, 'approve');
  }));
  host.querySelectorAll('[data-sso-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.ssoReject, 'reject')));
}

async function loadOrgs() {
  const el = document.getElementById('orgsTable');
  if (!el) return;
  let orgs;
  try {
    orgs = await api.adminListOrgs();
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message || 'Failed to load organizations')}</p>`;
    return;
  }
  if (!orgs.length) {
    el.innerHTML = `<p style="color:var(--text-muted)">${t('admin.orgs.empty')}</p>`;
    return;
  }
  el.innerHTML = orgs.map(o => {
    const wsRows = (o.workspaces || []).map(w => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-top:1px solid var(--border)">
        <div style="font-size:13px">${esc(w.name)}
          <span style="color:var(--text-muted);font-size:11px">· ${w.device_count} ${t('admin.orgs.devices')} · ${w.member_count} ${t('admin.orgs.members')}</span>
        </div>
        <button class="btn btn-danger btn-sm" data-del-ws="${esc(w.id)}" data-ws-name="${esc(w.name)}">${t('admin.orgs.delete_ws')}</button>
      </div>`).join('');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary)">
          <div>
            <div style="font-weight:600">${esc(o.name)}</div>
            <div style="color:var(--text-muted);font-size:11px">
              ${t('admin.orgs.owner')}: ${esc(o.owner_email || '—')} ·
              ${o.workspace_count} ${t('admin.orgs.workspaces')} · ${o.device_count} ${t('admin.orgs.devices')} · ${o.member_count} ${t('admin.orgs.members')}
            </div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-org="${esc(o.id)}" data-org-name="${esc(o.name)}">${t('admin.orgs.delete_org')}</button>
        </div>
        ${wsRows}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-del-org]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delOrg, name = btn.dataset.orgName;
    openTypeToConfirmModal({
      title: t('admin.orgs.delete_org_title'),
      body: t('admin.orgs.delete_org_body', { name: esc(name) }),
      expected: name,
      confirmLabel: t('admin.orgs.delete_org'),
      onConfirm: async () => {
        await api.adminDeleteOrg(id);
        showToast(t('admin.orgs.org_deleted', { name }), 'success');
        loadOrgs(); loadUsers();
      },
    });
  }));
  el.querySelectorAll('[data-del-ws]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delWs, name = btn.dataset.wsName;
    openTypeToConfirmModal({
      title: t('admin.orgs.delete_ws_title'),
      body: t('admin.orgs.delete_ws_body', { name: esc(name) }),
      expected: name,
      confirmLabel: t('admin.orgs.delete_ws'),
      onConfirm: async () => {
        await api.adminDeleteWorkspace(id);
        showToast(t('admin.orgs.ws_deleted', { name }), 'success');
        loadOrgs();
      },
    });
  }));
}

// #15: instance-level default branding form (platform default; every workspace
// without its own white-label inherits this, as does the login page).
async function loadBranding() {
  const el = document.getElementById('brandingForm');
  if (!el) return;
  let b = {};
  try { b = await api.adminGetBranding(); } catch (e) { el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load')}</p>`; return; }
  const v = (x) => esc(x == null ? '' : x);
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:640px">
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.brand_name')}</label><input type="text" id="brBrandName" class="input" placeholder="Loop Player" value="${v(b.brand_name)}"></div>
      <div class="form-group"><label>${t('admin.branding.primary_color')}</label><input type="text" id="brPrimary" class="input" placeholder="#3B82F6" value="${v(b.primary_color)}"></div>
      <div class="form-group"><label>${t('admin.branding.bg_color')}</label><input type="text" id="brBg" class="input" placeholder="#111827" value="${v(b.bg_color)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.logo_url')}</label><input type="text" id="brLogo" class="input" placeholder="https://…/logo.png" value="${v(b.logo_url)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.favicon_url')}</label><input type="text" id="brFavicon" class="input" placeholder="https://…/favicon.ico" value="${v(b.favicon_url)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.custom_css')}</label><textarea id="brCss" class="input" rows="3" placeholder="/* optional */">${v(b.custom_css)}</textarea></div>
      <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="brHide" ${b.hide_branding ? 'checked' : ''}> ${t('admin.branding.hide_branding')}
      </label>
    </div>
    <button class="btn btn-primary btn-sm" id="brSave" style="margin-top:12px">${t('admin.branding.save')}</button>
  `;
  document.getElementById('brSave').onclick = async () => {
    try {
      await api.adminSetBranding({
        brand_name: document.getElementById('brBrandName').value.trim() || 'Loop Player',
        primary_color: document.getElementById('brPrimary').value.trim() || null,
        bg_color: document.getElementById('brBg').value.trim() || null,
        logo_url: document.getElementById('brLogo').value.trim() || null,
        favicon_url: document.getElementById('brFavicon').value.trim() || null,
        custom_css: document.getElementById('brCss').value.trim() || null,
        hide_branding: document.getElementById('brHide').checked,
      });
      showToast(t('admin.branding.saved'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };
}

async function loadUsers() {
  const el = document.getElementById('allUsersTable');
  try {
    const [users, plans] = await Promise.all([
      API('/auth/users'),
      fetch('/api/subscription/plans').then(r => r.json()),
    ]);
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.user')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.auth')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.last_login')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.role')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.workspace')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.actions')}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--border)">
              <!-- ESCAPED: these come from self-registration and from an identity provider's
                   email claim, so they are attacker-chosen. A reviewer registered an address whose
                   local part was an img tag with an onerror handler, anonymously, and got script
                   execution in the PLATFORM ADMIN's session on this page - the very page operators
                   are now emailed to. Note backticks are illegal here: this sits inside a template
                   literal. -->
              <td style="padding:8px"><div style="font-weight:500">${esc(u.name || u.email)}</div><div style="font-size:11px;color:var(--text-muted)">${esc(u.email)}</div></td>
              <td style="padding:8px"><span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${esc(u.auth_provider)}</span></td>
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : t('common.never')}</td>
              <td style="padding:8px">
                <select class="input" style="max-width:120px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${esc(u.id)}">
                  ${PLATFORM_ROLE_OPTIONS.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${t('admin.role.' + r)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px">
                <select class="input" style="max-width:130px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-plan-user="${u.id}">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
                </select>
              </td>
              ${workspaceCell(u)}
              <td style="padding:8px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm" data-reset-pw-user="${esc(u.id)}" data-user-email="${esc(u.email)}" style="margin-right:4px">${t('admin.reset_password')}</button>` : ''}
                ${!isPlatformAdmin(u) ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">${t('admin.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('admin.owner')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${t('admin.total_users', { n: users.length })}</p>
    `;

    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast(t('admin.toast.role_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    el.querySelectorAll('[data-plan-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API('/subscription/assign', { method: 'POST', body: JSON.stringify({ user_id: select.dataset.planUser, plan_id: select.value }) });
          showToast(t('admin.toast.plan_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Manage workspaces: open the per-user membership modal (add/remove
    // workspaces, set per-workspace role). Refresh the table on close only if
    // something changed (the modal calls onClose then).
    el.querySelectorAll('[data-ws-manage]').forEach(btn => {
      btn.onclick = () => {
        const u = users.find(x => x.id === btn.dataset.wsManage);
        if (!u) return;
        openManageWorkspacesModal(u, { onClose: () => loadUsers() });
      };
    });

    // Reset password handlers
    el.querySelectorAll('[data-reset-pw-user]').forEach(btn => {
      btn.onclick = async () => {
        const email = btn.dataset.userEmail;
        const pw = prompt(t('admin.prompt_reset_password', { email }));
        if (pw === null) return;
        if (pw.length < 8) { showToast(t('admin.toast.password_min_8'), 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.resetPwUser, pw);
          showToast(t('admin.toast.password_reset'), 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast(t('admin.toast.user_removed'), 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = t('admin.confirm'); btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = t('admin.remove'); btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

// #146: toggle /api/status debug-metrics exposure. Mirrors loadBranding's
// load-then-save pattern; takes effect on the next status poll (no restart).
async function loadStatusDebug() {
  const el = document.getElementById('statusDebugForm');
  if (!el) return;
  let enabled = false;
  try { enabled = (await api.adminGetStatusDebug()).enabled; }
  catch (e) { el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load')}</p>`; return; }
  el.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="statusDebugChk" ${enabled ? 'checked' : ''}> ${t('admin.status_debug.label')}
    </label>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0 24px">${t('admin.status_debug.hint')}</p>
  `;
  document.getElementById('statusDebugChk').onchange = async (e) => {
    const chk = e.target;
    chk.disabled = true;
    try {
      await api.adminSetStatusDebug(chk.checked);
      showToast(t(chk.checked ? 'admin.status_debug.on' : 'admin.status_debug.off'), 'success');
    }
    catch (err) { showToast(err.message, 'error'); chk.checked = !chk.checked; }
    finally { chk.disabled = false; }
  };
}

/*
 * What a plan costs, in the currency it is actually priced in.
 *
 * This column used to print '$' + price_monthly for every row. Two lies at once on the only screen
 * that shows all six plans side by side: the live bands are billed per screen in reais and carry
 * price_monthly = 0, so Premium and Corporativo were listed as "Free", while the retired upstream
 * tiers — the only rows with a monthly price, and priced in USD — set the dollar sign that then
 * appeared on the Brazilian ones too.
 *
 * Same money() shape as billing.js, so the operator's table and the customer's page cannot
 * disagree about what a plan costs.
 */
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function money(v, currency) {
  if (currency && currency !== 'BRL') return `${currency} ${Number(v).toFixed(2)}`;
  return BRL.format(Number(v) || 0);
}
function planPrice(p) {
  if (p.price_per_device > 0) {
    return `${money(p.price_per_device, p.currency)}<span style="color:var(--text-muted);font-size:11px">${t('billing.per_screen')}</span>`;
  }
  // Legacy flat-rate rows (retired, active = 0) still have a monthly price worth reading.
  if (p.price_monthly > 0) {
    return `${money(p.price_monthly, p.currency)}<span style="color:var(--text-muted);font-size:11px">${t('admin.per_month')}</span>`;
  }
  return t('admin.free');
}

async function loadPlans() {
  const el = document.getElementById('plansTable');
  try {
    // Admin endpoint, not /api/subscription/plans: that one filters `active = 1` because it feeds
    // the pricing page, so a deliberately hidden plan (a comped or beta tier) was invisible to the
    // operator too. Here we want every plan, plus who is actually on each one.
    const { plans, orphaned } = await api.adminListPlans();
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:500px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.devices')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.storage')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.price')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.accounts')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.screens')}</th>
        </tr></thead>
        <tbody>
          ${plans.map(p => `
            <tr style="border-bottom:1px solid var(--border)${p.active ? '' : ';opacity:.7'}">
              <td style="padding:8px;font-weight:500">${esc(p.display_name)}
                <span style="color:var(--text-muted);font-weight:400;font-size:11px">${esc(p.id)}</span>
                ${p.active ? '' : `<span style="margin-left:6px;font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:8px;color:var(--text-muted)">${t('admin.plan_hidden')}</span>`}
              </td>
              <td style="padding:8px;text-align:right">${p.max_devices === -1 ? t('admin.unlimited') : p.max_devices}</td>
              <td style="padding:8px;text-align:right">${p.max_storage_mb === -1 ? t('admin.unlimited') : p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024)+'GB' : p.max_storage_mb+'MB'}</td>
              <td style="padding:8px;text-align:right;white-space:nowrap">${planPrice(p)}</td>
              <td style="padding:8px;text-align:right${p.user_count ? ';font-weight:500' : ';color:var(--text-muted)'}">${p.user_count}</td>
              <td style="padding:8px;text-align:right;color:var(--text-muted)">${p.device_count}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      ${(orphaned && orphaned.length) ? `
        <p style="margin-top:10px;color:var(--danger);font-size:12px">
          ${t('admin.plan_orphaned')}: ${orphaned.map(o => `<strong>${esc(o.plan_id)}</strong> (${o.user_count})`).join(', ')}
        </p>` : ''}
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

async function loadSystem() {
  const el = document.getElementById('systemInfo');
  try {
    const version = await fetch('/api/version').then(r => r.json());
    const token = localStorage.getItem('token');

    const versionComparison = version.latest_version
      ? `<div class="info-card">
           <div class="info-card-label">${t('admin.latest_version')}</div>
           <div class="info-card-value small">${esc(version.latest_version)}</div>
         </div>
         <div class="info-card">
           <div class="info-card-label">${t('admin.status')}</div>
           <div class="info-card-value small" style="color:${version.update_available ? 'var(--warning)' : 'var(--success)'}">${version.update_available ? (t('admin.update_available')) : (t('admin.up_to_date'))}</div>
         </div>`
      : `<div class="info-card">
           <div class="info-card-label">${t('admin.latest_version')}</div>
           <div class="info-card-value small" style="color:var(--text-muted)">${t('admin.checking')}</div>
         </div>`;

    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">${t('admin.version')}</div><div class="info-card-value small">${esc(version.version)}</div></div>
        ${versionComparison}
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="checkUpdateBtn">${t('admin.check_now')}</button>
        <button class="btn btn-primary btn-sm" id="triggerUpdateBtn"${!version.update_available ? ' style="display:none"' : ''}>${t('admin.update_now')}</button>
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.download_db_backup')}</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.server_status')}</a>
      </div>
      <div id="updateResult" style="margin-top:12px"></div>
    `;

    // Check Now button
    document.getElementById('checkUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('checkUpdateBtn');
      btn.disabled = true;
      btn.textContent = t('admin.checking');
      try {
        const res = await fetch('/api/admin/check-update', { method: 'POST', headers: headers() });
        const data = await res.json();
        const updBtn = document.getElementById('triggerUpdateBtn');
        if (data.update_available && updBtn) {
          updBtn.style.display = '';
        }
        loadSystem(); // refresh the whole card
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = t('admin.check_now');
      }
    });

    // Update Now button
    document.getElementById('triggerUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('triggerUpdateBtn');
      const resultEl = document.getElementById('updateResult');
      btn.disabled = true;
      btn.textContent = t('admin.updating');
      try {
        const res = await fetch('/api/admin/trigger-update', { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.docker_enabled) {
          // Docker executed — show output with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-card)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">${data.success ? (t('admin.update_success')) : (t('admin.update_failed'))}</strong>
                <button class="btn btn-secondary btn-sm" id="copyOutputBtn">${t('admin.copy')}</button>
              </div>
              <pre style="max-height:300px;overflow:auto;font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.output || '')}</pre>
            </div>`;
          document.getElementById('copyOutputBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast(t('admin.copied'), 'success'));
            } else {
              // Fallback for older browsers
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showToast(t('admin.copied'), 'success');
            }
          });
        } else if (data.instructions) {
          // Docker disabled — show manual instructions with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-secondary)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">${t('admin.manual_update')}</strong>
                <button class="btn btn-secondary btn-sm" id="copyCmdBtn">${t('admin.copy_command')}</button>
              </div>
              <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${t('admin.manual_update_desc')}</p>
              <pre style="font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.instructions)}</pre>
            </div>`;
          document.getElementById('copyCmdBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast(t('admin.copied'), 'success'));
            } else {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showToast(t('admin.copied'), 'success');
            }
          });
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = t('admin.update_now');
      }
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

export function cleanup() {}
