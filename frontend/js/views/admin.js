import { api } from '../api.js';
import { showPrompt } from '../components/prompt-modal.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { openManageWorkspacesModal } from '../components/admin-user-workspaces-modal.js';
import { openCreateOrgModal } from '../components/admin-create-org-modal.js';
import { openTypeToConfirmModal } from '../components/type-to-confirm-modal.js';
// Reuse the members view's server-error -> friendly-string mapper (handles the
// 409 duplicate-email / weak-password / invalid-email cases) so we don't fork a
// second mapper.
import { mapMutationError } from './workspace-members.js';

const PAPEL_PLATAFORMA = {
  'admin': 'Admin',
  'platform_admin': 'Administrador da plataforma',
  'platform_operator': 'Operador da plataforma',
  'superadmin': 'Superadmin',
  'user': 'Usuário',
};

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
  if (isPlatformStaffRole(u.role)) return 'Plataforma (todos)';
  const count = u.workspace_count || 0;
  if (count === 0) return 'Sem workspace';
  if (count === 1) return esc(u.workspace_name || '');
  return `${count} workspaces`;
}

// Workspace cell: a summary + a "Manage" button that opens the full membership
// modal (add/remove workspaces, set per-workspace role). Manage is offered for
// everyone, including staff (you can grant them explicit memberships too).
function workspaceCell(u) {
  return `<td style="padding:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="color:var(--text-muted);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${workspaceSummary(u)}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-ws-manage="${esc(u.id)}">Gerenciar</button>
    </div>
  </td>`;
}

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>Acesso negado</h3><p>Acesso de admin da plataforma necessário.</p></div>`;
    return;
  }

  const serverUrl = `${window.location.protocol}//${window.location.host}`;
  const widgetIsolationDisabled = !!user.current_organization?.widget_sandbox_isolation_disabled;
  // Typed-phrase confirmation. Translated with the modal it appears in: a warning in Portuguese
  // that demands an English sentence back reads like a bug, and the friction is the point — the
  // phrase has to be one the person can actually read before typing it.
  const WIDGET_ISOLATION_CONFIRM_PHRASE = 'Entendo que estou abrindo uma falha de segurança';

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Administração da plataforma</h1><div class="subtitle">Controles de superadmin - apenas você pode ver isso</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="adminAddUserBtn">Adicionar usuário</button>
      </div>
    </div>

    <div class="settings-tabs" id="adminTabs">
      <button class="settings-tab active" data-tab="clientes">Clientes</button>
      <button class="settings-tab" data-tab="planos">Planos</button>
      <button class="settings-tab" data-tab="faturamento">Faturamento</button>
      <button class="settings-tab" data-tab="integracoes">Integrações</button>
      <button class="settings-tab" data-tab="acesso">Acesso</button>
      <button class="settings-tab" data-tab="servidor">Servidor</button>
    </div>

    <div class="admin-pane" data-pane="clientes">
    <div class="settings-section" id="ssoOnlySection" style="display:none">
      <h3>Pedidos de remoção do login único</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Uma organização pediu para deixar de exigir o provedor de identidade dela. Enquanto você não aprovar, nada muda para eles.</p>
      <div id="ssoOnlyRequests"><p style="color:var(--text-muted)">Carregando...</p></div>
    </div>

    <div class="settings-section">
      <h3>Clientes</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Cada cliente, o que ele contrata e o que está em aberto. Clique para abrir.</p>
      <input type="search" id="tenantSearch" class="input" placeholder="Buscar por nome, razão social, CNPJ ou e-mail"
             style="max-width:340px;margin-bottom:12px">
      <div id="tenantsTable"><p style="color:var(--text-muted)">Carregando...</p></div>
    </div>

    <div class="settings-section" id="dormantSection" hidden>
      <h3>Cadastros sem tela</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Entraram, nunca adicionaram tela e nunca tiveram fatura. Ainda não são clientes.</p>
      <div id="dormantTable"></div>
    </div>

    <!--
      THE TWO TABLES THIS REPLACED, kept as MOUNT POINTS and nothing else.

      Every user flat and forever-growing, and every organisation with its workspaces nested
      underneath. Between them they could not answer the question the page exists for — who are my
      customers and do they owe me anything — without reading both and joining them in your head.

      The containers stay because loadUsers() writes into #allUsersTable and would throw on a null
      the moment it was deleted, taking the whole render with it and blanking the page. That has
      happened here before, from removing markup that looked unused because nothing in the
      stylesheet or the shell mentioned it: the mount point existed only in JavaScript.

      ORGANISATIONS specifically: every one in production had exactly one workspace and exactly one
      member, so the layer named nothing — clicking one to see who was in it showed the same person
      already named in its title. The database column stays, because per-customer SSO is configured
      against it and a chain with several branches would need it. Only the word is gone.
    -->
    <!--
      The flat user table MOVED to Acesso rather than being hidden here.

      Hiding something that still works is the worst of both: the request still fires, the code
      still runs, and the only thing lost is anybody's ability to reach it. And what it edits is
      not a customer matter at all — the "Função" selector sets users.role, which is whether a
      person is platform staff. That belongs beside the other access controls, not in a list of
      customers.
    -->

    <div class="settings-section" hidden>
      <h3>Organizações</h3>
      <div id="orgsTable"></div>
    </div>

    </div>

    <div class="admin-pane" data-pane="planos" hidden>
    <div class="settings-section">
      <h3>Planos de assinatura</h3>
      <div id="plansTable"><p style="color:var(--text-muted)">Carregando...</p></div>
    </div>

    </div>

    <div class="admin-pane" data-pane="faturamento" hidden>
      <div id="cashBody" style="color:var(--text-muted);font-size:13px">Carregando...</div>
    </div>

    <div class="admin-pane" data-pane="integracoes" hidden>
      <div class="settings-section">
        <h3>Asaas</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">A chave de API que emite as cobranças. Guardada cifrada; nunca é exibida de volta.</p>
        <div id="asaasForm"><p style="color:var(--text-muted)">Carregando...</p></div>
      </div>

      <div class="settings-section">
        <h3>Nota fiscal (NFS-e)</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Emitida automaticamente quando uma fatura é paga. Os números abaixo vêm do seu contador e da sua prefeitura — o certificado digital e a inscrição municipal ficam na sua conta Asaas.</p>
        <div id="nfseForm"><p style="color:var(--text-muted)">Carregando...</p></div>
      </div>

      <div class="settings-section">
        <h3>E-mail</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">O servidor que envia faturas, convites e recuperação de senha.</p>
        <div id="smtpForm"><p style="color:var(--text-muted)">Carregando...</p></div>
      </div>
    </div>

    <div class="admin-pane" data-pane="acesso" hidden>
      <!--
        PEOPLE, not customers. The Clientes tab lists tenants and shows who is inside each one, so
        this reading as a second customer list was the complaint — and the column that made it look
        like one, a plan selector per user, wrote a legacy field that priced nothing.

        What is left is the half Clientes genuinely cannot do: reset a password, remove somebody,
        make somebody platform staff, and reach a user who belongs to NO tenant — an account
        orphaned by a deleted workspace appears here and nowhere else at all.
      -->
      <div class="settings-section">
        <h3>Pessoas e acesso</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Quem entra no sistema. Os clientes e quem está dentro de cada um ficam na aba Clientes — aqui é senha, permissão de plataforma e contas sem cliente.</p>
        <div id="allUsersTable"><p style="color:var(--text-muted)">Carregando...</p></div>
      </div>

    <div class="settings-section" id="ssoCard" style="display:none">
      <h3>Login único</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Permita que sua equipe entre pelo provedor de identidade da sua empresa. Quem usar um e-mail de um dos seus domínios será enviado para lá em vez de digitar senha.</p>
      <div id="ssoList"></div>
      <details id="ssoAddDetails" style="margin-top:12px">
        <summary style="cursor:pointer;font-size:13px">Adicionar um provedor</summary>
        <div style="margin-top:12px;display:grid;gap:10px;max-width:560px">
          <div class="form-group"><label>Nome de exibição</label>
            <input type="text" id="ssoName" class="input" placeholder="Acme SSO"></div>
          <div class="form-group"><label>URL do issuer</label>
            <input type="url" id="ssoIssuer" class="input" placeholder="https://login.example.com">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">A URL base cujo /.well-known/openid-configuration descreve seu provedor. Nós conferimos antes de salvar.</div></div>
          <div class="form-group"><label>Client ID</label>
            <input type="text" id="ssoClientId" class="input"></div>
          <div class="form-group"><label>Client secret (opcional)</label>
            <input type="password" id="ssoClientSecret" class="input" autocomplete="new-password">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Deixe em branco para um cliente público — usamos PKCE, então o secret não é obrigatório. É guardado criptografado e nunca mais exibido.</div></div>
          <div class="form-group"><label>Domínios de e-mail</label>
            <input type="text" id="ssoDomains" class="input" placeholder="acme.com, acme.co.uk">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Separados por vírgula. Quem tiver endereço nesses domínios é enviado para este provedor.</div></div>
          <div><button class="btn btn-primary btn-sm" id="ssoCreateBtn">Adicionar provedor</button></div>
        </div>
      </details>
    </div>

    <div class="settings-section">
      <h3>Tokens de API</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Tokens de acesso pessoal para a API pública, restritos a este espaço de trabalho. Trate-os como senhas — qualquer pessoa com o token pode agir como você aqui.</p>
      <p style="font-size:13px;margin-bottom:16px"><a href="/docs" target="_blank" rel="noopener" style="color:var(--accent-ink)">Novo na API? Veja a documentação completa →</a></p>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:180px">
          <label>Nome</label>
          <input type="text" id="tokName" class="input" placeholder="${esc('ex.: Integração da agência')}">
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:200px">
          <label>Escopo</label>
          <select id="tokScope" class="input" style="background:var(--bg-input)">
            <option value="read">${esc('Somente leitura')}</option>
            <option value="write">${esc('Leitura e escrita')}</option>
            <option value="full">${esc('Completo (incl. comandos de dispositivo)')}</option>
            <option value="agency">${esc('Agência (enviar apenas para listas escolhidas)')}</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" id="createTokenBtn">Criar token</button>
      </div>
      <div id="agencyPlaylistPicker" style="display:none;margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)">
        <label style="display:block;font-weight:500;margin-bottom:4px">Listas às quais este token de agência pode publicar</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">O token só pode enviar e adicionar itens com datas a estas listas. As adições ficam como rascunho para você publicar.</p>
        <div id="agencyPlaylistList" style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto"></div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-weight:500">
          <input type="checkbox" id="tokAutoPublish"> Publicação automática (ignorar minha aprovação)
        </label>
        <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0">Desativado (padrão): as adições aguardam como rascunho para você publicar. Ativado: vão ao ar imediatamente, apenas para agências de total confiança.</p>
        <label style="display:block;font-weight:500;margin-top:12px;margin-bottom:4px">Pasta de upload</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Onde os uploads desta agência ficam. Deixe em automático para criar uma pasta com o nome do token; a agência pode usar subpastas dela, mas nada além disso.</p>
        <select id="tokUploadFolder" class="input" style="width:100%"><option value="">Criar uma automaticamente (Agency — <nome>)</option></select>
      </div>
      <div id="tokenSecretBox" style="display:none"></div>
      <div id="tokenList"><p style="color:var(--text-muted);font-size:13px">Carregando usuários...</p></div>
      <div id="tokenEditPanel" style="display:none"></div>
    </div>

    <div class="settings-section">
      <h3>Segurança</h3>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="min-width:260px;flex:1">
          <div style="font-weight:600">Isolamento do sandbox de widgets</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
            Mantém o código dos widgets em um sandbox de origem nula. Desligar isto permite que o código do widget rode com acesso de mesma origem.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="widgetSandboxIsolationToggle" ${widgetIsolationDisabled ? '' : 'checked'}>
          <span>${widgetIsolationDisabled ? 'Isolamento desativado' : 'Isolamento ativado'}</span>
        </label>
      </div>
    </div>

    </div>

    <div class="admin-pane" data-pane="servidor" hidden>
    <div class="settings-section">
      <h3>Sistema</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">Carregando...</p></div>
    </div>

    <div class="settings-section">
      <h3>Endpoint de status</h3>
      <div id="statusDebugForm"><p style="color:var(--text-muted)">Carregando...</p></div>
    </div>

    <div class="settings-section">
      <h3>Informações do servidor</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">URL do servidor</div>
          <div class="info-card-value small">${serverUrl}</div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Use esta URL ao configurar o app Android</p>
        </div>
        <div class="info-card">
          <div class="info-card-label">Endpoint da API</div>
          <div class="info-card-value small">${serverUrl}/api</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Guia de instalação</h3>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.8">
        <ol style="padding-left:20px;list-style:decimal">
          <li>Instale o APK do Loop Player na sua TV via sideloading</li>
          <li>Abra o app e digite esta URL do servidor: <code style="background:var(--bg-input);padding:2px 6px;border-radius:4px">${serverUrl}</code></li>
          <li>O app exibirá um código de pareamento de 6 dígitos</li>
          <li>${'Clique em "Adicionar tela" no painel e digite o código'}</li>
          <li>Envie conteúdo na Biblioteca de conteúdo</li>
          <li>Atribua conteúdo à playlist da tela</li>
        </ol>
      </div>
    </div>

    <div class="settings-section">
      <h3>Importar dados</h3>
      <button class="btn btn-secondary btn-sm" id="importDataBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Importar dados
      </button>
      <input type="file" id="importFileInput" accept=".json,.zip" style="display:none">
      <div id="importStatus" style="display:none;margin-top:12px;padding:12px;border-radius:var(--radius);font-size:13px"></div>
    </div>

    </div>

  `;

  /*
   * Panes are shown and hidden, never mounted and unmounted. Every loader below still runs once
   * on render: a card that quietly stopped refreshing because its tab happened to be closed is a
   * far worse bug than a page that loads four things nobody is looking at yet.
   */
  container.querySelectorAll('#adminTabs .settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const want = btn.dataset.tab;
      container.querySelectorAll('#adminTabs .settings-tab')
        .forEach((b) => b.classList.toggle('active', b.dataset.tab === want));
      container.querySelectorAll('.admin-pane')
        .forEach((pane) => { pane.hidden = pane.dataset.pane !== want; });
    });
  });

  // Add User (#10): platform admin provisions a user into ANY workspace. The
  // page is platform_admin-gated; the modal opens in picker mode (no fixed
  // workspace) so the admin chooses the target org/workspace. The endpoint
  // additionally enforces canAdminWorkspace (platform_admin passes everywhere).
  document.getElementById('adminAddUserBtn')?.addEventListener('click', () => {
    openAddUserModal(null, {
      onSuccess: (result) => {
        showToast(`Usuário ${result.email} criado`, 'success');
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
      onSuccess: (result) => showToast(`Organização "${result.name}" criada`, 'success'),
    });
  });

  // ==================== API tokens ====================
  const fmtTokenDate = (ts) => {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return String(ts); }
  };
  const scopeLabel = (s) => ({
    read: 'Somente leitura',
    write: 'Leitura e escrita',
    full: 'Completo (incl. comandos de dispositivo)',
    agency: 'Agência (enviar apenas para listas escolhidas)',
  }[s] || s);

  async function loadTokens() {
    const el = document.getElementById('tokenList');
    if (!el) return;
    const tokens = await api.getTokens().catch(() => []);
    if (!tokens.length) {
      el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">Ainda não há tokens.</p>`;
      return;
    }
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Token</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Nome</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Escopo</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Criado</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Último uso</th>
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
                  ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Designadas: ${tok.targets.length ? tok.targets.map(p => esc(p.name)).join(', ') : '—'}${tok.auto_publish ? ' · ' + esc('publicação automática ativada') : ''}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">Pasta: ${tok.upload_folder ? esc(tok.upload_folder) : esc('Raiz da biblioteca')}</div>`
                  : ''}</td>
              <td style="padding:10px 12px">${esc(fmtTokenDate(tok.created_at))}</td>
              <td style="padding:10px 12px">${tok.last_used_at ? esc(fmtTokenDate(tok.last_used_at)) : 'Nunca'}</td>
              <td style="padding:10px 12px;white-space:nowrap;text-align:right">
                ${tok.revoked_at
                  ? `<span style="color:var(--text-muted);font-size:12px">Revogado</span>`
                  : `${tok.scope === 'agency' ? `<button class="btn btn-secondary btn-sm edit-targets-btn" data-id="${esc(String(tok.id))}" data-targets="${esc((tok.targets || []).map(p => p.id).join(','))}">Editar listas</button> <button class="btn btn-secondary btn-sm edit-folder-btn" data-id="${esc(String(tok.id))}" data-folder="${esc(String(tok.upload_folder_id || ''))}">Pasta</button> ` : ''}<button class="btn btn-secondary btn-sm revoke-token-btn" data-id="${esc(String(tok.id))}">Revogar</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;

    el.querySelectorAll('.revoke-token-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revogar este token? Qualquer integração que o utilize para de funcionar imediatamente.')) return;
        try {
          await api.revokeToken(btn.dataset.id);
          showToast('Token revogado', 'success');
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
        <div style="border:1px solid var(--accent-ink);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">Editar listas</h4>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;margin-bottom:12px">
            ${pls.length
              ? pls.map(p => p.zoned
                  ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc('Atribuída a uma zona — agências precisam de uma lista de tela cheia')}</span></label>`
                  : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="edit-pl" value="${esc(String(p.id))}"${current.has(String(p.id)) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')
              : `<p style="color:var(--text-muted);font-size:12px">Crie uma lista primeiro: um token de agência deve apontar para uma.</p>`}
          </div>
          <button class="btn btn-primary btn-sm" id="saveTargetsBtn">Salvar</button>
          <button class="btn btn-secondary btn-sm" id="cancelTargetsBtn">Cancelar</button>
        </div>`;
      document.getElementById('saveTargetsBtn').onclick = async () => {
        const ids = [...panel.querySelectorAll('.edit-pl:checked')].map(c => c.value);
        if (!ids.length) return showToast('Selecione pelo menos uma lista para um token de agência.', 'error');
        try {
          await api.setTokenTargets(id, ids);
          showToast('Designações atualizadas', 'success');
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
        <div style="border:1px solid var(--accent-ink);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">Pasta</h4>
          <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Onde os uploads desta agência ficam. Deixe em automático para criar uma pasta com o nome do token; a agência pode usar subpastas dela, mas nada além disso.</p>
          <select id="rebindFolder" class="input" style="width:100%;margin-bottom:12px">
            <option value="">Raiz da biblioteca</option>
            ${folders.map(f => `<option value="${esc(String(f.id))}"${String(f.id) === current ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="saveFolderBtn">Salvar</button>
          <button class="btn btn-secondary btn-sm" id="cancelFolderBtn">Cancelar</button>
        </div>`;
      document.getElementById('saveFolderBtn').onclick = async () => {
        try {
          await api.setTokenUploadFolder(id, document.getElementById('rebindFolder').value || null);
          showToast('Pasta de upload atualizada', 'success');
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
            ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc('Atribuída a uma zona — agências precisam de uma lista de tela cheia')}</span></label>`
            : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="agency-pl" value="${esc(String(p.id))}"> ${esc(p.name)}</label>`).join('')
        : `<p style="color:var(--text-muted);font-size:12px">Crie uma lista primeiro: um token de agência deve apontar para uma.</p>`;
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
      if (!ids.length) return showToast('Selecione pelo menos uma lista para um token de agência.', 'error');
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
      const inviteText = `Acesse ${portalUrl} e cole esta chave de acesso: ${r.token}`;
      box.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--accent-ink);border-radius:var(--radius);padding:16px;margin-bottom:16px">
          <h4 style="font-size:14px;margin-bottom:8px">Copie seu token agora</h4>
          <p style="color:var(--danger);font-size:12px;margin-bottom:12px"><strong>Esta é a única vez que o token completo é exibido. Guarde-o em um lugar seguro — você não poderá vê-lo novamente.</strong></p>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="input" readonly value="${esc(r.token)}" style="font-family:monospace;flex:1" onclick="this.select()">
            <button class="btn btn-secondary btn-sm" id="copyTokenBtn">Copiar</button>
          </div>
          ${scope === 'agency' ? `
          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
            <label style="font-size:12px;color:var(--text-muted)">URL do portal da agência</label>
            <input type="text" class="input" readonly value="${esc(portalUrl)}" style="width:100%;margin-top:4px" onclick="this.select()">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-top:10px">Convite para copiar — envie para a agência:</label>
            <textarea class="input" readonly rows="2" style="width:100%;margin-top:4px;font-size:13px;font-family:inherit" onclick="this.select()">${esc(inviteText)}</textarea>
            <button class="btn btn-secondary btn-sm" id="copyInviteBtn" style="margin-top:8px">Copiar convite</button>
          </div>` : ''}
        </div>
      `;
      document.getElementById('copyTokenBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          showToast('Copiado para a área de transferência', 'success');
        } catch { /* clipboard may be unavailable; the field is selectable */ }
      });
      document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteText); // full "go here + paste key" text
          showToast('Copiado para a área de transferência', 'success');
        } catch { /* field is selectable as a fallback */ }
      });
      document.getElementById('tokName').value = '';
      showToast('Token criado', 'success');
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
    statusEl.textContent = 'Lendo arquivo...';
    try {
      let data;
      if (isZip) {
        // For ZIP, show basic info and skip preview parsing
        data = { format: 'loop-player-export-v1', _isZip: true };
        statusEl.innerHTML = `${`Exportação ZIP detectada: <strong>${esc(file.name)}</strong> (${(file.size / 1048576).toFixed(1)} MB)<br>Contém dados + arquivos de mídia.`}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">Confirmar importação</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">Cancelar</button>`;
      } else {
        const text = await file.text();
        data = JSON.parse(text);
        /*
         * Matched on the SHAPE, not on the product name.
         *
         * A backup a customer downloaded before the rename carries the old prefix, and refusing
         * it would strand their own data behind a cosmetic change. Naming the old product here to
         * accept it would put that name back into a file this domain serves — so the check asks
         * the question that actually matters: is this one of our export files at all.
         */
        if (!data.format || !/-export-v\d+$/.test(data.format)) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = 'Arquivo inválido. Deve ser JSON ou ZIP de exportação do Loop Player.';
          return;
        }
        const summary = [
          data.devices?.length ? `${data.devices.length} dispositivos` : null,
          data.content?.length ? `${data.content.length} itens de conteúdo` : null,
          data.widgets?.length ? `${data.widgets.length} widgets` : null,
          data.layouts?.length ? `${data.layouts.length} layouts` : null,
          data.schedules?.length ? `${data.schedules.length} agendas` : null,
          data.video_walls?.length ? `${data.video_walls.length} paredes de vídeo` : null,
          data.kiosk_pages?.length ? `${data.kiosk_pages.length} páginas de quiosque` : null,
        ].filter(Boolean).join(', ');
        statusEl.innerHTML = `${`Encontrado: ${esc(summary) || 'exportação vazia'}.<br>De: ${esc(data.user?.email) || 'Desconhecido'} (exportado ${esc(data.exported_at?.split('T')[0]) || 'Desconhecido'})`}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">Confirmar importação</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">Cancelar</button>`;
      }
      document.getElementById('cancelImportBtn').onclick = () => { statusEl.style.display = 'none'; e.target.value = ''; };
      document.getElementById('confirmImportBtn').onclick = async () => {
        statusEl.innerHTML = isZip ? 'Enviando e importando... Pode demorar para arquivos grandes.' : 'Importando...';
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
            let html = `Importação concluída: ${imported}.`;
            if (result.device_pairings?.length) {
              html += `<br><br><strong>Códigos de pareamento:</strong><br><table style="margin-top:8px;font-size:12px;border-collapse:collapse">` +
                result.device_pairings.map(d => `<tr><td style="padding:4px 12px 4px 0">${esc(d.name)}</td><td style="font-family:monospace;font-weight:700;font-size:14px;letter-spacing:2px">${d.pairing_code}</td></tr>`).join('') +
                `</table><br>Digite estes códigos em cada dispositivo para revinculá-los. Atribuições e agendas serão preservadas.`;
            }
            html += `<br><br>${(result.notes || []).map(n => '&bull; ' + n).join('<br>')}`;
            statusEl.innerHTML = html;
            showToast('Dados importados com sucesso', 'success');
          } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = result.error || 'Falha na importação';
          }
        } catch (err) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = `Falha na importação: ${err.message}`;
        }
        e.target.value = '';
      };
    } catch (err) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = `Falha ao ler o arquivo: ${err.message}`;
    }
  });

  /*
   * Install statistics. Shows the ACTUAL payload rather than a description of it — the whole
   * proposition is "you can check instead of trusting us", and the code is public, so a sentence
   * that didn't match the bytes would be found. Also shows what was last really sent.
   */
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
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc('Não foi possível carregar as configurações de login único.')}</p>`;
      return;
    }

    if (!providers.length) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc('Nenhum provedor configurado ainda.')}</p>`;
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
            ${p.enabled ? '' : `<span style="font-size:11px;color:var(--text-muted)"> — ${esc('desativado')}</span>`}
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(p.issuer)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${esc('Domínios de e-mail')}: ${esc(p.email_domains || '—')}</div>
            ${((p.domains || []).some((d) => !d.verified) || (p.domains || []).length === 0)
              ? `<div style="font-size:12px;color:var(--warning);margin-top:2px">⚠️ ${esc('Alguns domínios ainda não foram verificados, então ninguém é direcionado a este provedor pelo e-mail.')}</div>`
              : ''}
          </div>
          <!-- wrap, do not shrink-to-clip: at 375px this row ran to x=417 on a 375px viewport and
               the page does not scroll horizontally, so "Remove" was simply unreachable. -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-secondary btn-sm" data-sso-test="${esc(p.id)}">${esc('Testar')}</button>
            <button class="btn btn-secondary btn-sm" data-sso-edit="${esc(p.id)}">${esc('Editar')}</button>
            <button class="btn btn-secondary btn-sm" data-sso-toggle="${esc(p.id)}" data-enabled="${p.enabled ? '1' : '0'}">
              ${esc(p.enabled ? 'Desativar' : 'Ativar')}
            </button>
            <button class="btn btn-danger btn-sm" data-sso-delete="${esc(p.id)}">${esc('Remover')}</button>
          </div>
        </div>
        <!-- The admin has to paste this into their identity provider, and it must match character
             for character, so it is shown rather than described. -->
        <div style="margin-top:8px;font-size:12px">
          <div style="color:var(--text-muted)">${esc('Redirect URI — cadastre isto no seu provedor')}</div>
          <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px">${esc(origin + p.callback_url)}</code>
        </div>

        <!-- Editing is per provider, because an organization may have several (one per domain, or
             one per identity provider after a merger) and they are configured independently. -->
        <!-- Domain proof. A claimed domain routes NOBODY until DNS confirms the organization
             controls it, so the state of each one is shown plainly rather than left to be inferred
             from a login that silently does not work. -->
        ${(p.domains || []).length ? `
        <div style="margin-top:10px;font-size:12px">
          <div style="color:var(--text-muted);margin-bottom:4px">${esc('Domínios de entrada')}</div>
          ${p.domains.map((d, di) => `
            <div style="border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div><strong>${esc(d.domain)}</strong>
                  ${d.verified
                    ? `<span style="color:var(--success)"> — ${esc('verificado')}</span>`
                    : `<span style="color:var(--warning)"> — ${esc('não verificado — ainda não direciona ninguém')}</span>`}
                </div>
                ${d.verified ? '' : `<button class="btn btn-secondary btn-sm" data-sso-verify="${esc(p.id)}" data-domain="${esc(d.domain)}" data-di="${di}">${esc('Verificar')}</button>`}
              </div>
              ${d.verified ? '' : `
                <div style="margin-top:6px;color:var(--text-muted)">${esc('Publique este registro TXT no DNS deste domínio e clique em Verificar. As solicitações expiram em 8 horas.')}</div>
                <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px;margin-top:4px">${esc(d.record_name)}  TXT  ${esc(d.txt_value)}</code>
`}
              <!-- ONE place for the outcome. The last failure is persisted server-side and was
                   rendered here, while the click handler wrote the live result into a second
                   element below it — so retrying showed the identical sentence twice, in two
                   different colours. The handler replaces this element's text instead. -->
              <div id="ssoVerify-${esc(p.id)}-${di}" style="margin-top:4px;color:var(--danger)">${d.verified ? '' : esc(d.last_error || '')}</div>
            </div>`).join('')}
        </div>` : ''}

        <div id="ssoTest-${esc(p.id)}" style="display:none;margin-top:8px;font-size:12px"></div>
        <div id="ssoEdit-${esc(p.id)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:none">
          <div style="display:grid;gap:10px;max-width:560px">
            <div class="form-group"><label>${esc('Nome de exibição')}</label>
              <input type="text" class="input" data-f="name" value="${esc(p.name)}"></div>
            <div class="form-group"><label>${esc('URL do issuer')}</label>
              <input type="url" class="input" data-f="issuer" value="${esc(p.issuer)}"></div>
            <div class="form-group"><label>${esc('Client ID')}</label>
              <input type="text" class="input" data-f="client_id" value="${esc(p.client_id)}"></div>
            <div class="form-group"><label>${esc('Client secret (opcional)')}</label>
              <input type="password" class="input" data-f="client_secret" autocomplete="new-password"
                     placeholder="${esc(p.has_client_secret ? 'Há um secret definido — deixe em branco para mantê-lo' : 'Nenhum secret definido (cliente público)')}">
              <!-- A secret can never be shown back: the API does not return it. Blank therefore means
                   "leave it alone" rather than "clear it", which is what stops a save from silently
                   wiping a working configuration. Clearing is a separate, explicit choice. -->
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc('Deixe em branco para manter o secret atual. Digite um novo para substituir.')}</div>
              ${p.has_client_secret ? `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px">
                <input type="checkbox" data-f="clear_secret"> ${esc('Remover o secret guardado (usar cliente público)')}
              </label>` : ''}
            </div>
            <div class="form-group"><label>${esc('Domínios de e-mail')}</label>
              <input type="text" class="input" data-f="email_domains" value="${esc(p.email_domains)}"></div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" data-sso-save="${esc(p.id)}">${esc('Salvar alterações')}</button>
              <button class="btn btn-secondary btn-sm" data-sso-cancel="${esc(p.id)}">${esc('Cancelar')}</button>
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
        <div style="font-weight:600;margin-bottom:4px">${esc('Exigir login único')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc('Quando obrigatório, quem está nos seus domínios verificados só consegue entrar pelo seu provedor de identidade — senha não funciona. Seu provedor passa a controlar o segundo fator e a remoção de acesso.')}</div>
        ${onlyState.sso_only ? `
          <div style="font-size:13px;margin-bottom:8px">✅ ${esc('O login único é obrigatório para os seus domínios verificados.')}</div>
          ${pend
            ? `<div style="font-size:12px;color:var(--warning)">⏳ ${esc('Há uma solicitação para deixar de exigir login único aguardando aprovação. Nada muda até lá.')}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyCancel" data-req="${esc(pend.id)}" style="margin-top:6px">${esc('Retirar solicitação')}</button>`
            : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${esc('Desligar isto reabre a entrada por senha, por isso exige aprovação de quem administra este servidor.')}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyRequest">${esc('Solicitar para deixar de exigir login único')}</button>`}
        ` : `
          <div style="font-size:13px;margin-bottom:8px">${esc('A entrada por senha continua permitida junto com o login único.')}</div>
          ${onlyState.verified_domains
            ? `<button class="btn btn-secondary btn-sm" id="ssoOnlyEnable">${esc('Exigir login único')}</button>`
            : `<div style="font-size:12px;color:var(--warning)">⚠️ ${esc('Verifique um domínio de entrada primeiro — senão ninguém conseguiria entrar.')}</div>`}
        `}`;
      listEl.appendChild(box);

      const post = async (url, body, method = 'POST') => {
        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || 'Não funcionou.', 'error'); return null; }
        return j;
      };

      const enableBtn = box.querySelector('#ssoOnlyEnable');
      if (enableBtn) enableBtn.addEventListener('click', async () => {
        // Confirmed, because it removes the only way in for everyone at these domains, and the way
        // back needs the operator rather than this button.
        if (!window.confirm('Exigir login único para todos nos seus domínios verificados?\n\nAs senhas deixam de funcionar para eles no próximo acesso; sessões já abertas continuam até expirar. Desligar isso depois exige aprovação de quem administra este servidor, então confirme antes que seu provedor de identidade está funcionando.')) return;
        const r = await post(`/api/organizations/${orgId}/sso-only`);
        if (r) {
          showToast('O login único é obrigatório para os seus domínios verificados.', 'success');
          /*
           * Name the people who just lost their only way in. The server reports them precisely so
           * the admin finds out HERE rather than from a support ticket — and it was being thrown
           * away, which made the whole warning pointless.
           */
          const stranded = r.stranded_members || [];
          if (stranded.length) {
            window.alert(`O login único passou a ser obrigatório.

Estes membros não estão em um domínio verificado, então não conseguem mais entrar de jeito nenhum:

${stranded.join('\\n')}

Verifique o domínio deles ou remova-os desta organização.`);
          }
          await loadSso();
        }
      });

      const reqBtn = box.querySelector('#ssoOnlyRequest');
      if (reqBtn) reqBtn.addEventListener('click', async () => {
        const reason = (await showPrompt({
          title: 'Por que você precisa reabrir a entrada por senha? (opcional, mas ajuda quem vai avaliar)',
          label: 'Por que você precisa reabrir a entrada por senha? (opcional, mas ajuda quem vai avaliar)',
        })) || '';
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request`, { reason });
        if (r) { showToast('Solicitação enviada. O login único continua obrigatório até ser aprovada.', 'success'); await loadSso(); }
      });

      const cancelBtn = box.querySelector('#ssoOnlyCancel');
      if (cancelBtn) cancelBtn.addEventListener('click', async () => {
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request/${cancelBtn.dataset.req}`, null, 'DELETE');
        if (r) { showToast('Solicitação retirada.', 'success'); await loadSso(); }
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
        if (out) { out.style.color = 'var(--text-muted)'; out.textContent = 'Consultando o DNS…'; }
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/domains/${encodeURIComponent(domain)}/verify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const body = await res.json().catch(() => ({}));
          if (body.ok) {
            showToast(`${domain} verificado.`, 'success');
            await loadSso();       // re-render: the domain now routes, and the card must say so
            return;
          }
          // An expired claim has already been reissued server-side, so the records on screen are
          // stale — reload rather than leaving the admin publishing a value that no longer matches.
          if (body.expired) {
            showToast(body.error || 'Não foi possível verificar esse domínio.', 'error');
            await loadSso();
            return;
          }
          if (out) { out.style.color = 'var(--danger)'; out.textContent = body.error || 'Não foi possível verificar esse domínio.'; }
        } catch {
          if (out) { out.style.color = 'var(--danger)'; out.textContent = 'Não foi possível verificar esse domínio.'; }
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
        out.textContent = 'Consultando o provedor…';
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/test`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const data = await res.json();
          if (!res.ok) { out.textContent = data.error || 'Não foi possível acessar esse provedor.'; return; }
          /*
           * Literal keys, never a key built by concatenating a check name. Doing that defeats the
           * check in server/test/i18n-keys-exist.js that every key an operator can see is
           * translated — and a check name the UI does not know would render as raw key text. The
           * fallback keeps an unknown one readable instead.
           */
          const CHECK_LABELS = {
            discovery: 'Configuração OpenID',
            endpoints: 'Endpoints de autorização e token',
            signing_keys: 'Chaves de assinatura',
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
            ? `<div style="margin-top:6px;color:var(--text-muted)">${esc('Isto confirma que o provedor está acessível e que os tokens dele podem ser verificados. Não dá para checar o client ID, o secret nem se o redirect URI está cadastrado — só uma entrada real confirma isso.')}</div>`
            : '');
        } catch {
          out.textContent = 'Não foi possível acessar esse provedor.';
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
          showToast('Nome, issuer e client ID são obrigatórios.', 'error');
          return;
        }
        await ssoRequest('PUT', `/${btn.dataset.ssoSave}`, body);
      });
    });
    listEl.querySelectorAll('[data-sso-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remover este provedor? Quem entra por ele perde esse caminho.')) return;
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
      if (!res.ok) { showToast(data.error || 'Não foi possível salvar esse provedor.', 'error'); return false; }
      // "Saved" for a DELETE read as though nothing had been destroyed.
      showToast((method === 'DELETE' ? 'Removido.' : 'Salvo'), 'success');
      await loadSso();
      return true;
    } catch {
      showToast('Não foi possível salvar esse provedor.', 'error');
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
      showToast('Nome, issuer e client ID são obrigatórios.', 'error');
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
  loadPlans();
  loadSso();
  loadTokens();
  loadSystem();
  loadTenants();
  loadStatusDebug();
  loadIntegrations();
  loadCash();
  loadNfse();

}

function openWidgetSandboxDisableConfirmModal(confirmationPhrase) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="width:min(760px,96vw)">
        <div class="modal-header"><h3>Desativar o isolamento do sandbox de widgets nesta organização</h3></div>
        <div class="modal-body" style="white-space:pre-wrap;line-height:1.45">${'Hoje o HTML dos widgets roda em um sandbox de origem nula. Isso significa que o\ncódigo do widget não consegue ler sua sessão, seus cookies, nem qualquer outra\ncoisa que este aplicativo guarde neste navegador.\n\nDesligar isto reativa o allow-same-origin. O HTML dos widgets passa a rodar com\nos mesmos privilégios do próprio aplicativo. Qualquer script, em qualquer widget\ndesta organização, vai conseguir:\n\n  - Ler o token de dispositivo de toda tela que exibir o widget, e agir como\n    aquela tela contra a API\n  - Ler o token de sessão de qualquer usuário logado que abrir uma tela no\n    próprio navegador\n  - Chamar a API como aquele usuário, inclusive em ações de administração\n  - Ler e alterar o conteúdo de todas as outras telas desta organização\n  - Enviar tudo isso silenciosamente para qualquer servidor\n\nA Pré-visualização do editor de widgets NÃO é afetada: ela é renderizada dentro\ndo painel, onde sua sessão vive, e continua isolada independentemente desta\nconfiguração. Por isso um widget pode se comportar de forma diferente na\nPré-visualização e na tela.\n\nComo o allow-scripts também é necessário para os widgets funcionarem, um widget\nconsegue remover o próprio sandbox por completo assim que recebe mesma origem.\nDepois deste ponto não sobra proteção parcial nenhuma.\n\nSó ative isto se todo widget desta organização for código que você escreveu, ou\ncódigo de alguém em quem você confiaria sua senha de administrador. Um único\nembed de terceiro, CDN ou tag de anúncio comprometido já é suficiente.\n\nEsta configuração vale para TODOS os widgets desta organização e não pode ser\naplicada por tela.'}
          <div class="form-group" style="margin-top:16px">
            <label for="widgetSandboxConfirmInput">Digite a frase abaixo para confirmar:</label>
            <div style="margin:6px 0 8px;font-weight:600">${esc(confirmationPhrase)}</div>
            <input id="widgetSandboxConfirmInput" type="text" class="input" autocomplete="off">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="widgetSandboxConfirmCancel">Cancelar</button>
          <button class="btn btn-danger" id="widgetSandboxConfirmSubmit" disabled>Desativar isolamento</button>
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
        ${esc(`Solicitado por ${r.requested_by_email || 'unknown'}`)}
      </div>
      ${r.reason ? `<div style="font-size:12px;margin-top:6px">${esc(r.reason)}</div>` : ''}
      <div style="font-size:12px;color:var(--warning);margin-top:8px">${esc('Aprovar reabre a entrada por senha para todos nos domínios verificados desta organização.')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-danger btn-sm" data-sso-approve="${esc(r.id)}">${esc('Aprovar remoção')}</button>
        <button class="btn btn-secondary btn-sm" data-sso-reject="${esc(r.id)}">${esc('Recusar')}</button>
      </div>
    </div>`).join('');

  const decide = async (id, decision) => {
    try {
      const res = await authed(`/organizations/sso-only/removal-requests/${id}/${decision}`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || String(res.status));
      showToast((decision === 'approve' ? 'Aprovado. A entrada por senha foi reaberta para essa organização.' : 'Recusado. O login único continua obrigatório.'), 'success');
      await loadSsoOnlyRequests();
    } catch (e) {
      showToast((e && e.message) || 'Não funcionou.', 'error');
    }
  };
  // Approving RE-OPENS password sign-in for a whole organization, so it is confirmed; rejecting
  // only leaves the safe state in place and is not.
  host.querySelectorAll('[data-sso-approve]').forEach((b) => b.addEventListener('click', () => {
    if (window.confirm('Reabrir a entrada por senha para esta organização?\n\nO provedor de identidade deixará de ser a única forma de entrar. Aprove somente se tiver certeza de que o pedido é legítimo.')) decide(b.dataset.ssoApprove, 'approve');
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
    el.innerHTML = `<p style="color:var(--text-muted)">Nenhuma organização ainda.</p>`;
    return;
  }
  el.innerHTML = orgs.map(o => {
    const wsRows = (o.workspaces || []).map(w => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-top:1px solid var(--border)">
        <div style="font-size:13px">${esc(w.name)}
          <span style="color:var(--text-muted);font-size:11px">· ${w.device_count} telas · ${w.member_count} membros</span>
        </div>
        <button class="btn btn-danger btn-sm" data-del-ws="${esc(w.id)}" data-ws-name="${esc(w.name)}">Excluir</button>
      </div>`).join('');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary)">
          <div>
            <div style="font-weight:600">${esc(o.name)}</div>
            <div style="color:var(--text-muted);font-size:11px">
              Dono: ${esc(o.owner_email || '—')} ·
              ${o.workspace_count} workspaces · ${o.device_count} telas · ${o.member_count} membros
            </div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-org="${esc(o.id)}" data-org-name="${esc(o.name)}">Excluir organização</button>
        </div>
        ${wsRows}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-del-org]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delOrg, name = btn.dataset.orgName;
    openTypeToConfirmModal({
      title: 'Excluir organização',
      body: `Isto exclui permanentemente <b>${esc(name)}</b> e todos os workspaces, telas, conteúdos, playlists e vínculos dela. Não é possível desfazer.`,
      expected: name,
      confirmLabel: 'Excluir organização',
      onConfirm: async () => {
        await api.adminDeleteOrg(id);
        showToast(`Organização "${name}" excluída`, 'success');
        loadOrgs(); loadUsers();
      },
    });
  }));
  el.querySelectorAll('[data-del-ws]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delWs, name = btn.dataset.wsName;
    openTypeToConfirmModal({
      title: 'Excluir workspace',
      body: `Isto exclui permanentemente o workspace <b>${esc(name)}</b> e todas as telas, conteúdos e playlists dele. A organização é mantida. Não é possível desfazer.`,
      expected: name,
      confirmLabel: 'Excluir',
      onConfirm: async () => {
        await api.adminDeleteWorkspace(id);
        showToast(`Workspace "${name}" excluído`, 'success');
        loadOrgs();
      },
    });
  }));
}

/*
 * ONE CUSTOMER, OPENED.
 *
 * Everything about them in one place, which is the half the old page never had at all: the tables
 * showed rows and offered no way in. Answering "who is at this customer, what do they pay, do they
 * owe anything" meant three screens and a guess about which workspace was which.
 *
 * Built from the row already in memory rather than a second request. The list fetched all of it a
 * moment ago, and a spinner between a click and information the browser is already holding is a
 * spinner that exists to look busy.
 */
function openTenant(id) {
  const tn = tenantRows.find((x) => x.id === id);
  if (!tn) return;

  const when = (unix) => (unix
    ? new Date(unix * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : '—');

  const line = (label, value) => `
    <div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <div style="min-width:170px;color:var(--text-muted)">${esc(label)}</div>
      <div style="flex:1">${value}</div>
    </div>`;

  const st = tenantState(tn);

  /*
   * The people. This is the answer to "who do I call", so it carries how they sign in and when
   * they last did: an account that has never logged in and one that logs in daily are the same
   * row otherwise, and they are not the same customer.
   */
  const members = tn.members.length
    ? tn.members.map((m) => `
        <div style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1">
            <div style="font-size:13px">${esc(m.name || '—')}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(m.email)}</div>
          </div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(m.auth_provider || 'local')}</div>
          <div style="font-size:11px;color:var(--text-muted);min-width:120px;text-align:right">${esc(when(m.last_login))}</div>
        </div>`).join('')
    : `<p style="font-size:12px;color:var(--text-muted)">Ninguém com acesso.</p>`;

  /*
   * The money, split the same three ways as everywhere else — and rendered only where there is
   * something to say. A row of zeroes is three lines the reader has to check before learning
   * nothing.
   */
  const owed = [
    tn.overdue_cents ? line('Vencido', `<span style="color:var(--danger);font-weight:600">${esc(cents(tn.overdue_cents))}</span>`) : '',
    tn.not_invoiced_cents ? line('Sem cobrança emitida', `<span style="color:var(--warning);font-weight:600">${esc(cents(tn.not_invoiced_cents))}</span>`) : '',
    tn.due_cents ? line('A vencer', esc(cents(tn.due_cents))) : '',
  ].join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
         padding:24px;max-width:640px;width:100%;max-height:86vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px">
        <div>
          <h3 style="margin:0">${esc(tn.name)}</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(tn.legal_name || 'Dados da empresa não preenchidos')}</div>
        </div>
        <button class="btn btn-secondary btn-sm" id="tenantClose">Fechar</button>
      </div>

      ${line('Plano', `
        <select id="tenantPlan" class="input" style="max-width:220px;padding:4px 8px;font-size:13px">
          ${adminPlans.map((pl) => `<option value="${esc(pl.id)}" ${pl.id === tn.plan_id ? 'selected' : ''}>${esc(pl.display_name)}</option>`).join('')}
        </select>`)}
      ${line('Telas', `${tn.device_count}${tn.max_devices > 0 ? ` / ${tn.max_devices}` : ''}`)}
      ${line('Situação', `<span style="color:${st.tone}">${esc(st.text)}</span>`)}
      ${tn.tax_id ? line('CPF ou CNPJ', esc(tn.tax_id)) : ''}
      ${tn.billing_email ? line('E-mail de cobrança (opcional)', esc(tn.billing_email)) : ''}
      ${line('Cliente desde', esc(when(tn.created_at)))}
      ${line('Cadastro no Asaas', tn.has_asaas_customer ? 'Criado' : 'Ainda não criado')}
      ${owed}

      <div style="font-size:12px;color:var(--text-secondary);margin:18px 0 6px;font-weight:600">
        ${esc(`Quem tem acesso (${tn.members.length})`)}
      </div>
      ${members}

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <button class="btn btn-danger btn-sm" id="tenantDelete">Excluir cliente</button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Apaga telas, arquivos, playlists e histórico de cobrança. Não tem volta.</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#tenantClose').addEventListener('click', close);
  // Clicking the backdrop closes; clicking INSIDE must not — a stray click while reading should
  // not throw away the panel somebody just opened.
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  /*
   * Changing the plan writes to the WORKSPACE, which is the column that prices the invoice. The
   * table this replaced offered the same control per user, writing users.plan_id — a legacy column
   * that decides nothing, and the reason a customer once read as Premium on one screen while being
   * charged Corporativo on another.
   */
  overlay.querySelector('#tenantPlan')?.addEventListener('change', async (ev) => {
    const sel = ev.target;
    sel.disabled = true;
    try {
      const r = await api.adminSetTenantPlan(tn.id, sel.value);
      tn.plan_id = r.plan_id;
      tn.plan_name = r.plan_name;
      showToast(`${tn.name} agora está no plano ${r.plan_name}.`, 'success');
      paintTenants(document.getElementById('tenantSearch')?.value || '');
    } catch (e) {
      showToast(e.message, 'error');
      sel.value = tn.plan_id;
    } finally { sel.disabled = false; }
  });

  overlay.querySelector('#tenantDelete').addEventListener('click', () => {
    close();
    /*
     * The SAME typed-confirmation the old workspace delete used, deliberately. This is the same
     * irreversible cascade — screens, files, playlists and billing history — and giving it a
     * second, gentler path to fire would mean the safest way to trigger it is the one nobody uses.
     *
     * Typing the name is the guard: the customer whose data this is has a name, and somebody about
     * to erase them should have to write it.
     */
    openTypeToConfirmModal({
      title: 'Excluir cliente',
      body: `Isso apaga <b>${esc(tn.name)}</b> por completo: telas, arquivos, playlists e histórico de cobrança. Digite o nome do cliente para confirmar.`,
      expected: tn.name,
      confirmLabel: 'Excluir cliente',
      onConfirm: async () => {
        await api.adminDeleteWorkspace(tn.id);
        showToast(`${tn.name} foi excluído.`, 'success');
        loadTenants();
      },
    });
  });
}

/*
 * THE CUSTOMER LIST.
 *
 * One row per tenant, with what you look a customer up for: what they are on, how many screens,
 * and whether they owe anything. The two tables it replaces — every user flat, and every
 * organisation with its workspaces nested — required reading both and joining them in your head to
 * answer the only question the page is for.
 *
 * SIGNUPS THAT NEVER BECAME CUSTOMERS are moved out, not deleted. Someone who registered and never
 * added a screen is a lead or an abandoned attempt, and mixed into the same list they are
 * indistinguishable from the people who pay — which was most of the noise.
 */
let tenantRows = [];
/* The plan list, fetched once alongside the tenants so the panel can offer a selector without a
 * request of its own the moment somebody clicks a row. */
let adminPlans = [];

async function loadTenants() {
  const host = document.getElementById('tenantsTable');
  if (!host) return;

  try { tenantRows = await api.adminTenants(); }
  catch (e) { host.textContent = e.message; return; }

  // Best-effort: a panel without a plan selector is far better than a customer list that failed
  // to render because the plan list was unavailable.
  try { adminPlans = await api.getPlans(); } catch { adminPlans = []; }

  document.getElementById('tenantSearch')?.addEventListener('input', (ev) => paintTenants(ev.target.value));
  paintTenants('');
}

const BRLc = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const cents = (c) => BRLc.format((Number(c) || 0) / 100);

/*
 * Search covers the name, the legal name, the tax id and every member's e-mail.
 *
 * All four because support is handed whichever one the caller happens to have: a CNPJ off an
 * invoice, the e-mail they sign in with, or the name over the shop. A search that only matched the
 * tenant name would fail on exactly the customer whose name nobody in the room remembers.
 */
function tenantMatches(tn, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const hay = [tn.name, tn.legal_name, tn.trade_name, tn.billing_email,
    ...tn.members.map((m) => m.email), ...tn.members.map((m) => m.name)]
    .filter(Boolean).join(' ').toLowerCase();
  if (hay.includes(needle)) return true;
  return !!(digits && tn.tax_id && String(tn.tax_id).includes(digits));
}

/* The money state, said in words rather than as a colour alone — a colour is unreadable to a
 * reader who cannot distinguish it, and this is the column decisions get made from. */
function tenantState(tn) {
  if (tn.subscription_status === 'cut') return { text: 'Acesso cortado', tone: 'var(--danger)' };
  if (tn.subscription_status === 'suspended') return { text: 'Painel bloqueado', tone: 'var(--danger)' };
  if (tn.overdue_cents > 0) return { text: 'Vencido', tone: 'var(--warning)' };
  if (tn.not_invoiced_cents > 0) return { text: 'Sem cobrança emitida', tone: 'var(--warning)' };
  if (tn.due_cents > 0) return { text: 'A vencer', tone: 'var(--info)' };
  return { text: 'Em dia', tone: 'var(--text-muted)' };
}

function tenantRow(tn) {
  const st = tenantState(tn);
  const who = tn.members.length === 1
    ? (tn.members[0].name || tn.members[0].email)
    : `${tn.members.length} pessoas`;

  return `
    <tr class="tenant-row" data-id="${esc(tn.id)}" style="border-top:1px solid var(--border);cursor:pointer">
      <td style="padding:10px 12px 10px 0">
        <div style="font-weight:600">${esc(tn.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(tn.legal_name || who)}</div>
      </td>
      <td style="padding:10px 12px 10px 0;color:var(--text-secondary)">${esc(tn.plan_name || '—')}</td>
      <td style="padding:10px 12px 10px 0;color:var(--text-secondary)">
        ${tn.device_count}${tn.max_devices > 0 ? ` / ${tn.max_devices}` : ''}
      </td>
      <td style="padding:10px 12px 10px 0;color:${st.tone}">${esc(st.text)}</td>
      <td style="padding:10px 0;text-align:right;font-weight:${tn.outstanding_cents ? '600' : '400'}">
        ${tn.outstanding_cents ? esc(cents(tn.outstanding_cents)) : '—'}
      </td>
    </tr>`;
}

function paintTenants(q) {
  const host = document.getElementById('tenantsTable');
  const dormHost = document.getElementById('dormantTable');
  const dormSection = document.getElementById('dormantSection');
  if (!host) return;

  const matching = tenantRows.filter((tn) => tenantMatches(tn, q));
  const live = matching.filter((tn) => !tn.dormant);
  const dormant = matching.filter((tn) => tn.dormant);

  const table = (rows) => `
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase">
        <th style="padding:8px 12px 8px 0">Cliente</th>
        <th style="padding:8px 12px 8px 0">Plano</th>
        <th style="padding:8px 12px 8px 0">Telas</th>
        <th style="padding:8px 12px 8px 0">Situação</th>
        <th style="padding:8px 0;text-align:right">Em aberto</th>
      </tr></thead>
      <tbody>${rows.map(tenantRow).join('')}</tbody>
    </table></div>`;

  host.innerHTML = live.length
    ? table(live)
    : `<p style="color:var(--text-muted);font-size:13px">Nenhum cliente encontrado.</p>`;

  if (dormSection) dormSection.hidden = dormant.length === 0;
  if (dormHost) dormHost.innerHTML = dormant.length ? table(dormant) : '';

  document.querySelectorAll('.tenant-row').forEach((row) => {
    row.addEventListener('click', () => openTenant(row.dataset.id));
  });
}

/*
 * THE CASH POSITION.
 *
 * WHY THE UNCOLLECTED MONEY IS SPLIT IN THREE. A single "inadimplência" figure shows the same
 * number whether a customer refused to pay or was never asked, and those are opposite problems:
 * one is chased, the other is fixed here. Six invoices once sat unissued long enough to suspend
 * two tenants, and any combined total would have displayed that as delinquency — sending the
 * operator after customers who had done nothing wrong.
 *
 * "A vencer" is separated for the opposite reason: counting money that is not late as if it were
 * makes the screen cry wolf every month, and a screen that cries wolf is unread in the month it
 * is right.
 */
async function loadCash() {
  const host = document.getElementById('cashBody');
  if (!host) return;

  let d;
  try { d = await api.adminBillingSummary(); }
  catch (e) { host.textContent = e.message; return; }

  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = (cents) => BRL.format((Number(cents) || 0) / 100);

  const card = (label, value, sub, tone) => `
    <div class="info-card" style="flex:1;min-width:170px${tone ? `;border-left:3px solid ${tone}` : ''}">
      <div class="info-card-label">${esc(label)}</div>
      <div class="info-card-value" style="${tone ? `color:${tone}` : ''}">${esc(value)}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(sub)}</div>` : ''}
    </div>`;

  const o = d.outstanding;

  host.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${card('Clientes pagantes', String(d.tenants.paying),
        d.tenants.internal
          ? `de ${d.tenants.total} contas · ${d.tenants.internal} da casa`
          : `de ${d.tenants.total} no total`)}
      ${card('Recebido no mês', money(d.received_this_month.cents),
        `${d.month} — ${d.received_this_month.count} fatura(s)`, 'var(--success)')}
      ${card('Acumulando agora', money(d.accruing.cents), 'Projeção do mês corrente, por dias-licença.')}
      ${card('Faturado no mês anterior', money(d.billed_previous_month.cents),
        `${d.previous_month} — ${d.billed_previous_month.count} fatura(s)`)}
    </div>

    <div style="font-size:12px;color:var(--text-secondary);margin:20px 0 8px;font-weight:600">
      ${esc(`Em aberto — ${money(o.total_cents)}`)}
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${card('Vencido', money(o.overdue.cents),
        `${o.overdue.count} fatura(s)`, o.overdue.cents ? 'var(--danger)' : '')}
      ${card('Sem cobrança emitida', money(o.not_invoiced.cents),
        `${o.not_invoiced.count} fatura(s) — o cliente nunca foi cobrado`, o.not_invoiced.cents ? 'var(--warning)' : '')}
      ${card('A vencer', money(o.due.cents), `${o.due.count} fatura(s)`)}
    </div>

    ${d.tenants.suspended || d.tenants.cut ? `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:20px">
      ${card('Painel bloqueado', String(d.tenants.suspended), 'As telas seguem tocando.', 'var(--warning)')}
      ${card('Acesso cortado', String(d.tenants.cut), 'Telas desconectadas.', 'var(--danger)')}
    </div>` : ''}

    ${d.missing_nfse.count ? `
    <div style="margin-top:20px;padding:12px 14px;border:1px solid var(--border);
         border-left:3px solid var(--warning);border-radius:8px">
      <div style="font-size:13px;font-weight:600">${esc(`${d.missing_nfse.count} mês(es) pagos sem nota fiscal — ${money(d.missing_nfse.cents)}`)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc('Dinheiro recebido sem documento emitido. Veja em Integrações → Nota fiscal.')}</div>
    </div>` : ''}`;
}

/*
 * THE FISCAL SETUP — the operator's own, not a tenant's.
 *
 * The service code their city assigns to what they sell, and the rates their accountant gives
 * them. On a screen rather than in code because no two municipalities agree and no two accountants
 * answer the same, and the person who has these numbers is not the person who deploys.
 *
 * NOTHING HERE IS SECRET, so unlike the API keys above it reads back exactly as entered — somebody
 * has to be able to check these against the e-mail their accountant sent.
 *
 * The list of months still missing a document sits underneath, because a configuration screen that
 * cannot show you what it has failed to do is a screen you have to trust.
 */
async function loadNfse() {
  const host = document.getElementById('nfseForm');
  if (!host) return;

  let cfg;
  try { cfg = await api.adminGetNfse(); }
  catch { host.innerHTML = `<p style="color:var(--text-muted)">Indisponível.</p>`; return; }

  const rate = (id, label, value) => `
    <div class="form-group">
      <label>${esc(label)}</label>
      <input type="text" id="${id}" class="input" value="${esc(String(value ?? 0))}" inputmode="decimal" style="max-width:110px">
    </div>`;

  host.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:14px">
      <input type="checkbox" id="nfseEnabled" ${cfg.enabled ? 'checked' : ''}> Emitir nota fiscal automaticamente após o pagamento
    </label>

    <div class="form-grid">
      <div class="form-group">
        <label>Código de serviço municipal</label>
        <input type="text" id="nfseCode" class="input" value="${esc(cfg.serviceCode || '')}" placeholder="1.05">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">O item da lista da sua prefeitura correspondente ao que você vende.</div>
      </div>
      <div class="form-group">
        <label>Descrição do serviço (prefeitura)</label>
        <input type="text" id="nfseName" class="input" value="${esc(cfg.serviceName || '')}">
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>Descrição que sai na nota</label>
        <input type="text" id="nfseDesc" class="input" value="${esc(cfg.description || '')}"
               placeholder="Licenciamento de software para sinalização digital — {month}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">{month} é substituído pela competência; {screens} pela média de telas.</div>
      </div>
    </div>

    <div style="font-size:12px;color:var(--text-secondary);margin:16px 0 8px;font-weight:600">Alíquotas</div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Em porcentagem. Zero é uma resposta válida — no Simples Nacional a maioria fica em zero.</div>
    <div class="form-grid">
      ${rate('nfseIss', 'ISS %', cfg.taxes?.iss)}
      ${rate('nfsePis', 'PIS %', cfg.taxes?.pis)}
      ${rate('nfseCofins', 'COFINS %', cfg.taxes?.cofins)}
      ${rate('nfseCsll', 'CSLL %', cfg.taxes?.csll)}
      ${rate('nfseInss', 'INSS %', cfg.taxes?.inss)}
      ${rate('nfseIr', 'IR %', cfg.taxes?.ir)}
      ${rate('nfseDeduct', 'Deduções', cfg.deductions)}
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px">
      <input type="checkbox" id="nfseRetain" ${cfg.retainIss ? 'checked' : ''}> ISS retido pelo tomador
    </label>

    <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" id="nfseSave">Salvar</button>
      <span id="nfseResult" style="font-size:12px"></span>
    </div>
    ${cfg.missing?.length ? `<p style="color:var(--warning);font-size:12px;margin-top:10px">
       ${esc(`Ainda não emite: falta ${cfg.missing.join(', ')}.`)}</p>` : ''}

    <div id="nfsePending" style="margin-top:18px"></div>`;

  document.getElementById('nfseSave')?.addEventListener('click', async () => {
    const val = (id) => document.getElementById(id)?.value ?? '';
    const out = document.getElementById('nfseResult');
    try {
      await api.adminSaveNfse({
        enabled: document.getElementById('nfseEnabled').checked,
        retain_iss: document.getElementById('nfseRetain').checked,
        service_code: val('nfseCode'), service_name: val('nfseName'), description: val('nfseDesc'),
        iss: val('nfseIss'), pis: val('nfsePis'), cofins: val('nfseCofins'),
        csll: val('nfseCsll'), inss: val('nfseInss'), ir: val('nfseIr'), deductions: val('nfseDeduct'),
      });
      showToast('Salvo', 'success');
      loadNfse();
    } catch (e) { if (out) { out.textContent = e.message; out.style.color = 'var(--danger)'; } }
  });

  loadNfsePending();
}

/* Months that were paid and produced no document. Nothing else in the product counts these, and
 * money received with no nota behind it is invisible until somebody does. */
async function loadNfsePending() {
  const host = document.getElementById('nfsePending');
  if (!host) return;

  let rows;
  try { rows = await api.adminNfsePending(); } catch { return; }
  if (!rows.length) { host.innerHTML = `<p style="font-size:12px;color:var(--text-muted)">Todo mês pago tem nota emitida.</p>`; return; }

  host.innerHTML = `
    <div style="font-size:12px;font-weight:600;margin-bottom:8px">${esc(`${rows.length} mês(es) pagos sem nota emitida`)}</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
      ${rows.map((r) => `
        <tr style="border-top:1px solid var(--border)">
          <td style="padding:8px 12px 8px 0">${esc(r.month)}</td>
          <td style="padding:8px 12px 8px 0">${esc(r.workspace_name)}</td>
          <td style="padding:8px 12px 8px 0;font-weight:600">${((r.amount_cents || 0) / 100).toFixed(2)}</td>
          <td style="padding:8px 12px 8px 0;color:var(--danger)">${esc(r.nfse_error || '')}</td>
          <td style="padding:8px 0;text-align:right">
            <button class="btn btn-secondary btn-sm nfse-issue" data-id="${esc(r.id)}">Emitir</button>
          </td>
        </tr>`).join('')}
    </table></div>`;

  host.querySelectorAll('.nfse-issue').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.adminIssueNfse(btn.dataset.id);
        showToast(r.issued ? 'Nota solicitada.' : r.reason, r.issued ? 'success' : 'error');
        loadNfsePending();
      } catch (e) { showToast(e.message, 'error'); btn.disabled = false; }
    });
  });
}

/*
 * THE ASAAS KEY AND THE MAIL SERVER, on a screen.
 *
 * Both were environment variables: changing the Asaas account meant editing a file on the server
 * and restarting the container. And nothing in the product said whether a key was set at all — it
 * was not, for months, which is the whole reason no invoice was ever charged.
 *
 * A SECRET IS NEVER RENDERED BACK. The field is empty and the state beside it says whether one is
 * stored and its last four characters — enough to tell two keys apart, not enough to use one. An
 * empty field on save therefore means "leave it alone"; erasing is a separate button, which is
 * what deleting a credential should be.
 */
async function loadIntegrations() {
  const asaasEl = document.getElementById('asaasForm');
  const smtpEl = document.getElementById('smtpForm');
  if (!asaasEl || !smtpEl) return;

  let cfg;
  try { cfg = await api.adminGetIntegrations(); }
  catch { asaasEl.innerHTML = `<p style="color:var(--text-muted)">Indisponível.</p>`; return; }

  const secretState = (d) => {
    if (!d.configured) return `<span class="row-state offline">não configurada</span>`;
    if (!d.readable) return `<span class="row-state degraded">ilegível — digite de novo</span>`;
    return `<span class="row-state online">${`guardada ${esc(d.hint)}`}</span>`;
  };

  asaasEl.innerHTML = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:1/-1">
        <label>Chave de API — ${secretState(cfg.asaas.key)}</label>
        <input type="password" id="asaasKey" class="input" placeholder="deixe em branco para manter a atual" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Ambiente</label>
        <select id="asaasMode" class="input">
          <option value="sandbox" ${cfg.asaas.mode === 'sandbox' ? 'selected' : ''}>Sandbox (teste)</option>
          <option value="production" ${cfg.asaas.mode === 'production' ? 'selected' : ''}>Produção (cobra de verdade)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Token do webhook — ${secretState(cfg.asaas.webhook_token)}</label>
        <input type="password" id="asaasWebhook" class="input" placeholder="deixe em branco para manter a atual" autocomplete="off">
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>URL do webhook (cole no painel do Asaas)</label>
        <input type="text" class="input" readonly value="${esc(cfg.asaas.webhook_url)}" onclick="this.select()">
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary btn-sm" id="asaasSave">Salvar</button>
      <button class="btn btn-secondary btn-sm" id="asaasTest">Testar</button>
      ${cfg.asaas.key.configured ? `<button class="btn btn-quiet btn-sm" id="asaasClear">Apagar chave</button>` : ''}
      <span id="asaasResult" style="font-size:12px"></span>
    </div>
    ${cfg.secrets_keyed_to_jwt_secret ? `<p style="color:var(--text-muted);font-size:11px;margin-top:10px">Estes segredos são cifrados com uma chave derivada do JWT_SECRET do servidor. Se ele for trocado, todos precisam ser digitados de novo — aqui, no 2FA e no SSO.</p>` : ''}`;

  smtpEl.innerHTML = `
    <div class="form-grid">
      <div class="form-group"><label>Servidor</label>
        <input type="text" id="smtpHost" class="input" value="${esc(cfg.smtp.host)}" placeholder="smtp.hostinger.com"></div>
      <div class="form-group"><label>Porta</label>
        <input type="text" id="smtpPort" class="input" value="${esc(String(cfg.smtp.port || ''))}" placeholder="465"></div>
      <div class="form-group"><label>Usuário</label>
        <input type="text" id="smtpUser" class="input" value="${esc(cfg.smtp.user)}" autocomplete="off"></div>
      <div class="form-group">
        <label>Senha — ${secretState(cfg.smtp.password)}</label>
        <input type="password" id="smtpPass" class="input" placeholder="deixe em branco para manter a atual" autocomplete="new-password"></div>
      <div class="form-group" style="grid-column:1/-1"><label>Remetente</label>
        <input type="text" id="smtpFrom" class="input" value="${esc(cfg.smtp.from)}" placeholder="Loop Player &lt;nao-responda@loopplayer.com.br&gt;"></div>
      <div class="form-group" style="grid-column:1/-1">
        <label style="display:flex;align-items:center;gap:8px;font-weight:400">
          <input type="checkbox" id="smtpSecure" ${cfg.smtp.secure ? 'checked' : ''}> Conexão TLS direta (porta 465). Desmarcado usa STARTTLS (587).
        </label>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary btn-sm" id="smtpSave">Salvar</button>
      <button class="btn btn-secondary btn-sm" id="smtpTest">Enviar teste</button>
      <span id="smtpResult" style="font-size:12px"></span>
    </div>
    <p style="color:var(--text-muted);font-size:11px;margin-top:10px">Configurar o servidor é a parte fácil. Quem decide se a fatura chega é o SPF, o DKIM e o DMARC do domínio: sem eles, cobrança enviada de servidor próprio cai em spam com frequência.</p>`;

  const say = (id, text, ok) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.style.color = ok ? 'var(--success)' : 'var(--danger)'; }
  };

  document.getElementById('asaasSave')?.addEventListener('click', async () => {
    try {
      await api.adminSaveAsaas({
        api_key: document.getElementById('asaasKey').value,
        webhook_token: document.getElementById('asaasWebhook').value,
        mode: document.getElementById('asaasMode').value,
      });
      showToast('Salvo', 'success');
      loadIntegrations();
    } catch (e) { showToast(e.message, 'error'); }
  });

  document.getElementById('asaasTest')?.addEventListener('click', async () => {
    say('asaasResult', 'consultando…', true);
    try {
      const r = await api.adminTestAsaas();
      // The ACCOUNT NAME, not a tick: a key that works against the wrong account is the failure
      // worth catching, and only a human reading the name can catch it.
      say('asaasResult', `conta: ${r.account?.name || '—'} · ${r.account?.cpfCnpj || '—'} · ${r.mode}`, true);
    } catch (e) { say('asaasResult', e.message, false); }
  });

  document.getElementById('asaasClear')?.addEventListener('click', async () => {
    if (!window.confirm('Apagar a chave do Asaas? Nenhuma cobrança será emitida até você colocar outra.')) return;
    try { await api.adminClearAsaasKey(); showToast('Chave apagada', 'success'); loadIntegrations(); }
    catch (e) { showToast(e.message, 'error'); }
  });

  document.getElementById('smtpSave')?.addEventListener('click', async () => {
    try {
      await api.adminSaveSmtp({
        host: document.getElementById('smtpHost').value,
        port: document.getElementById('smtpPort').value,
        secure: document.getElementById('smtpSecure').checked,
        user: document.getElementById('smtpUser').value,
        password: document.getElementById('smtpPass').value,
        from: document.getElementById('smtpFrom').value,
      });
      showToast('Salvo', 'success');
      loadIntegrations();
    } catch (e) { showToast(e.message, 'error'); }
  });

  document.getElementById('smtpTest')?.addEventListener('click', async () => {
    say('smtpResult', 'enviando…', true);
    try {
      const r = await api.adminTestSmtp();
      say('smtpResult', `enviado para ${r.to}`, true);
    } catch (e) { say('smtpResult', e.message, false); }
  });
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
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Usuário</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Auth</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Último login</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Função</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Workspace</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Ações</th>
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
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : 'Nunca'}</td>
              <td style="padding:8px">
                <select class="input" style="max-width:120px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${esc(u.id)}">
                  ${PLATFORM_ROLE_OPTIONS.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${PAPEL_PLATAFORMA[r]}</option>`).join('')}
                </select>
              </td>
              ${workspaceCell(u)}
              <td style="padding:8px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm" data-reset-pw-user="${esc(u.id)}" data-user-email="${esc(u.email)}" style="margin-right:4px">Redefinir senha</button>` : ''}
                ${!isPlatformAdmin(u) ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">Remover</button>` : `<span style="color:var(--text-muted);font-size:11px">Proprietário</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${`${users.length} usuários no total`}</p>
    `;

    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast('Função atualizada', 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    /*
     * THE PER-USER PLAN SELECTOR IS GONE, and its handler with it.
     *
     * It wrote users.plan_id through /subscription/assign. That column is legacy and prices
     * nothing — lib/tenant-plan.js resolves workspaces.plan_id — so setting it here changed a
     * number on this screen and not the invoice. It is the control behind a customer once reading
     * "Premium" on one page while being charged Corporativo on another: three answers to one
     * question, with no way to tell from any screen which was real.
     *
     * The plan now lives where it is decided: inside the customer, on the Clientes tab, writing
     * the column the bill is cut from.
     */

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
        /* type=password: a reset typed into a plain text box is readable by anyone
           standing behind the operator, and this one is being set for someone else. */
        const pw = await showPrompt({
          title: `Digite uma nova senha para ${email} (mínimo 8 caracteres):`,
          label: `Digite uma nova senha para ${email} (mínimo 8 caracteres):`,
          type: 'password',
        });
        if (pw === null) return;
        if (pw.length < 8) { showToast('A senha deve ter no mínimo 8 caracteres', 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.resetPwUser, pw);
          showToast('Senha redefinida', 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast('Usuário removido', 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = 'Confirmar?'; btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = 'Remover'; btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

// #146: toggle /api/status debug-metrics exposure. Load the current value, then save on
// change; takes effect on the next status poll (no restart).
async function loadStatusDebug() {
  const el = document.getElementById('statusDebugForm');
  if (!el) return;
  let enabled = false;
  try { enabled = (await api.adminGetStatusDebug()).enabled; }
  catch (e) { el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load')}</p>`; return; }
  el.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="statusDebugChk" ${enabled ? 'checked' : ''}> Expor métricas de depuração em /api/status
    </label>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0 24px">Acrescenta contadores internos de limitador, limpeza e OTA ao endpoint de status, que é público. Desligado por padrão.</p>
  `;
  document.getElementById('statusDebugChk').onchange = async (e) => {
    const chk = e.target;
    chk.disabled = true;
    try {
      await api.adminSetStatusDebug(chk.checked);
      showToast((chk.checked ? 'As métricas de depuração agora estão públicas em /api/status' : 'As métricas de depuração não estão mais expostas'), 'success');
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
    return `${money(p.price_per_device, p.currency)}<span style="color:var(--text-muted);font-size:11px">/tela/mês</span>`;
  }
  // Legacy flat-rate rows (retired, active = 0) still have a monthly price worth reading.
  if (p.price_monthly > 0) {
    return `${money(p.price_monthly, p.currency)}<span style="color:var(--text-muted);font-size:11px">/mês</span>`;
  }
  return 'Grátis';
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
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Plano</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Dispositivos</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Armazenamento</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Preço</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Contas</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Ecrãs</th>
        </tr></thead>
        <tbody>
          ${plans.map(p => `
            <tr style="border-bottom:1px solid var(--border)${p.active ? '' : ';opacity:.7'}">
              <td style="padding:8px;font-weight:500">${esc(p.display_name)}
                <span style="color:var(--text-muted);font-weight:400;font-size:11px">${esc(p.id)}</span>
                ${p.active ? '' : `<span style="margin-left:6px;font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:8px;color:var(--text-muted)">oculto</span>`}
              </td>
              <td style="padding:8px;text-align:right">${p.max_devices === -1 ? 'Ilimitado' : p.max_devices}</td>
              <td style="padding:8px;text-align:right">${p.max_storage_mb === -1 ? 'Ilimitado' : p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024)+'GB' : p.max_storage_mb+'MB'}</td>
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
          Contas num plano que já não existe: ${orphaned.map(o => `<strong>${esc(o.plan_id)}</strong> (${o.user_count})`).join(', ')}
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
           <div class="info-card-label">Última versão</div>
           <div class="info-card-value small">${esc(version.latest_version)}</div>
         </div>
         <div class="info-card">
           <div class="info-card-label">Situação</div>
           <div class="info-card-value small" style="color:${version.update_available ? 'var(--warning)' : 'var(--success)'}">${version.update_available ? ('Atualização disponível') : ('Atualizado')}</div>
         </div>`
      : `<div class="info-card">
           <div class="info-card-label">Última versão</div>
           <div class="info-card-value small" style="color:var(--text-muted)">Verificando...</div>
         </div>`;

    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">Versão</div><div class="info-card-value small">${esc(version.version)}</div></div>
        ${versionComparison}
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="checkUpdateBtn">Verificar agora</button>
        <button class="btn btn-primary btn-sm" id="triggerUpdateBtn"${!version.update_available ? ' style="display:none"' : ''}>Atualizar agora</button>
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">Baixar backup do BD</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">Status do servidor</a>
      </div>
      <div id="updateResult" style="margin-top:12px"></div>
    `;

    // Check Now button
    document.getElementById('checkUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('checkUpdateBtn');
      btn.disabled = true;
      btn.textContent = 'Verificando...';
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
        btn.textContent = 'Verificar agora';
      }
    });

    // Update Now button
    document.getElementById('triggerUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('triggerUpdateBtn');
      const resultEl = document.getElementById('updateResult');
      btn.disabled = true;
      btn.textContent = 'Atualizando...';
      try {
        const res = await fetch('/api/admin/trigger-update', { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.docker_enabled) {
          // Docker executed — show output with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-card)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">${data.success ? ('Atualização concluída') : ('Falha na atualização')}</strong>
                <button class="btn btn-secondary btn-sm" id="copyOutputBtn">Copiar</button>
              </div>
              <pre style="max-height:300px;overflow:auto;font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.output || '')}</pre>
            </div>`;
          document.getElementById('copyOutputBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast('Copiado!', 'success'));
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
              showToast('Copiado!', 'success');
            }
          });
        } else if (data.instructions) {
          // Docker disabled — show manual instructions with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-secondary)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">Atualização manual necessária</strong>
                <button class="btn btn-secondary btn-sm" id="copyCmdBtn">Copiar</button>
              </div>
              <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Execute este comando no servidor:</p>
              <pre style="font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.instructions)}</pre>
            </div>`;
          document.getElementById('copyCmdBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast('Copiado!', 'success'));
            } else {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showToast('Copiado!', 'success');
            }
          });
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Atualizar agora';
      }
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

export function cleanup() {}
