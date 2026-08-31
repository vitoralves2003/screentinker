// Workspace members view. Slice 2A established the read-only listing;
// slice 2B adds the mutation surface (invite modal + per-row role change /
// remove / cancel-invite) gated by can_admin from /me.
//
// Affordance rules (locked from 2A's CSS design, refined during 2B):
//   - direct-member rows: role select + remove button
//   - via_org rows: no actions (server would 403; access lives in org_members)
//   - invited rows: cancel-invite button only (server returns 200)
// Server enforces all three boundaries; UI must match.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { openInviteMemberModal } from '../components/workspace-members-invite-modal.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';

const PAPEL_MEMBRO = {
  'org_admin': 'Admin da organização',
  'org_owner': 'Dono da organização',
  'workspace_admin': 'Administrador',
  'workspace_editor': 'Editor',
  'workspace_viewer': 'Leitor',
};

export async function render(container, workspaceId) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Membros do workspace</h1>
      <div id="membersHeaderActions"></div>
    </div>
    <div id="workspaceMembersContent" style="color:var(--text-muted)">Carregando...</div>
  `;
  const content = document.getElementById('workspaceMembersContent');
  const headerActions = document.getElementById('membersHeaderActions');

  // Fetch members, invites, and /me (for can_admin) in parallel. /me is the
  // source of truth for can_admin in THIS workspace - the same field the
  // switcher uses to gate the members icon.
  let members, meWorkspace;
  try {
    const [m, me] = await Promise.all([
      api.getWorkspaceMembers(workspaceId),
      api.getMe().catch(() => null),
    ]);
    members = m;
    meWorkspace = (me?.accessible_workspaces || []).find(w => w.id === workspaceId) || null;
  } catch (err) {
    const msg = err.message || '';
    if (/Workspace access required|Workspace not found/.test(msg)) {
      content.innerHTML = renderError('Workspace não encontrado ou sem acesso.');
    } else {
      content.innerHTML = renderError(`Falha ao carregar os membros: ${esc(msg)}`);
    }
    return;
  }

  const canAdmin = !!(meWorkspace && meWorkspace.can_admin);
  const workspaceName = meWorkspace?.name || '';

  // /invites is admin-only. Non-admins get 403; suppress silently. We could
  // skip the call entirely when !canAdmin to save a request, but defending
  // in depth: if /me drift ever leaves can_admin stale, the server still
  // returns the right answer.
  let invites = null;
  if (canAdmin) {
    try {
      invites = await api.getWorkspaceInvites(workspaceId);
    } catch (err) {
      console.warn('getWorkspaceInvites failed:', err.message);
      invites = null;
    }
  }

  // Invite + Add User buttons - admin only. Invite is self-service (emails a
  // link); Add User (#10) provisions an account directly with an admin-set
  // password (for instances with no outbound email). They coexist.
  if (canAdmin) {
    headerActions.innerHTML = `
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="addUserBtn">Adicionar usuário</button>
        <button class="btn btn-primary" id="inviteMemberBtn">Convidar membro</button>
      </div>
    `;
    document.getElementById('inviteMemberBtn').addEventListener('click', () => {
      openInviteMemberModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(`Convite enviado para ${result.email}`, 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
    document.getElementById('addUserBtn').addEventListener('click', () => {
      openAddUserModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(`Usuário ${result.email} criado`, 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
  }

  const direct = members.filter(m => !m.via_org);
  const viaOrg = members.filter(m => m.via_org);

  content.innerHTML = `
    ${renderSection({
      titleKey: 'Membros',
      count: direct.length,
      emptyKey: 'Ainda não há membros diretos.',
      rows: direct.map(m => renderMemberRow(m, { showJoined: true, canAdmin })).join(''),
    })}
    ${viaOrg.length > 0 ? renderSection({
      titleKey: 'Acesso pela organização',
      count: viaOrg.length,
      emptyKey: null,
      rows: viaOrg.map(m => renderMemberRow(m, { showJoined: false, viaOrg: true, canAdmin })).join(''),
    }) : ''}
    ${invites !== null ? renderSection({
      titleKey: 'Convites pendentes',
      count: invites.length,
      emptyKey: 'Nenhum convite pendente.',
      rows: invites.map(inv => renderInviteRow(inv, { canAdmin })).join(''),
    }) : ''}
  `;

  if (canAdmin) attachMutationHandlers(container, workspaceId);
}

function renderSection({ titleKey, count, emptyKey, rows }) {
  const countLabel = count > 0
    ? `<span style="color:var(--text-muted);font-weight:400;font-size:13px"> (${count})</span>`
    : '';
  const body = (count === 0 && emptyKey)
    ? `<p style="color:var(--text-muted);font-size:13px">${(emptyKey)}</p>`
    : `<div class="members-list">${rows}</div>`;
  return `
    <div class="settings-section" style="margin-bottom:24px">
      <h3 style="font-size:15px;margin-bottom:12px">${(titleKey)}${countLabel}</h3>
      ${body}
    </div>
  `;
}

function renderMemberRow(m, opts = {}) {
  const { showJoined = false, viaOrg = false, canAdmin = false } = opts;
  const initial = ((m.name || m.email || '?')[0] || '?').toUpperCase();
  const rightCell = viaOrg
    ? `<span class="member-via-org">pela organização</span>`
    : (showJoined ? esc(formatDate(m.joined_at)) : '');

  // Role cell: select for direct-member rows when canAdmin, plain text otherwise.
  const roleCell = (canAdmin && !viaOrg)
    ? `<select class="member-role-select" data-member-id="${esc(m.user_id)}" aria-label="${esc('Função')}">
         ${WORKSPACE_ROLES.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${esc(PAPEL_MEMBRO[r])}</option>`).join('')}
       </select>`
    : `<div class="member-role">${esc(PAPEL_MEMBRO[m.role])}</div>`;

  // Actions cell: remove on direct-member rows only when canAdmin.
  const actionsCell = (canAdmin && !viaOrg)
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-remove-member="${esc(m.user_id)}"
                 data-member-name="${esc(m.name || m.email)}"
                 aria-label="${esc('Remover membro')}"
                 title="${esc('Remover membro')}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row${viaOrg ? ' member-row--via-org' : ''}">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">${esc(m.name || m.email)}</div>
        <div class="member-email">${esc(m.email)}</div>
      </div>
      ${roleCell}
      <div class="member-detail">${rightCell}</div>
      ${actionsCell}
    </div>
  `;
}

function renderInviteRow(inv, opts = {}) {
  const { canAdmin = false } = opts;
  const initial = ((inv.email || '?')[0] || '?').toUpperCase();
  const invitedBy = inv.invited_by_email
    ? `Convidado por ${inv.invited_by_email}`
    : '';
  const expires = `Expira ${formatDate(inv.expires_at)}`;

  // Refined affordance rule: invited rows DO get one action - cancel.
  const actionsCell = canAdmin
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-cancel-invite="${esc(inv.id)}"
                 data-invite-email="${esc(inv.email)}"
                 aria-label="${esc('Cancelar convite')}"
                 title="${esc('Cancelar convite')}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row member-row--invited">
      <div class="member-avatar member-avatar--muted">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">
          ${esc(inv.email)}
          <span class="member-badge">Convidado</span>
        </div>
        <div class="member-email">${esc(invitedBy)}</div>
      </div>
      <div class="member-role">${esc(PAPEL_MEMBRO[inv.role])}</div>
      <div class="member-detail">${esc(expires)}</div>
      ${actionsCell}
    </div>
  `;
}

// Wire all mutation handlers after innerHTML write. Each handler: confirm
// (if destructive), call API, on success toast + re-render, on error toast
// + re-render (to revert UI state in case the failed mutation was an
// optimistic display - belt and suspenders).
function attachMutationHandlers(container, workspaceId) {
  // Role change - fires on <select> change.
  container.querySelectorAll('select[data-member-id]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const userId = sel.dataset.memberId;
      const newRole = sel.value;
      try {
        await api.updateWorkspaceMemberRole(workspaceId, userId, newRole);
        showToast('Função atualizada', 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
        render(container, workspaceId);
      }
    });
  });

  // Remove member - confirm then DELETE.
  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.removeMember;
      const name = btn.dataset.memberName;
      if (!confirm(`Remover ${name} deste workspace?`)) return;
      try {
        await api.removeWorkspaceMember(workspaceId, userId);
        showToast(`${name} removido`, 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });

  // Cancel pending invite - confirm then DELETE.
  container.querySelectorAll('[data-cancel-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inviteId = btn.dataset.cancelInvite;
      const email = btn.dataset.inviteEmail;
      if (!confirm(`Cancelar o convite de ${email}?`)) return;
      try {
        await api.cancelWorkspaceInvite(workspaceId, inviteId);
        showToast('Convite cancelado', 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });
}

// Map a backend mutation-error message to a translated user-facing string.
// Exported so the invite modal can reuse the same mapper (single source of
// truth - the "third regex mapper" per the slice 2A follow-up note;
// cumulative-debt cleanup tracked there).
//
// Order matters - most specific patterns first. Server message stability is
// the implicit contract; if the regex chain ever produces wrong matches,
// it's because server wording changed without updating this mapper.
export function mapMutationError(err) {
  const msg = err?.message || '';
  if (/rate limit/i.test(msg)) return 'Limite de convites atingido. Tente mais tarde.';
  if (/already pending/i.test(msg)) return 'Já existe um convite pendente para esse e-mail.';
  if (/Cannot demote the last admin/i.test(msg)) return 'Não é possível mudar a função — este é o único administrador.';
  if (/Cannot remove the last admin/i.test(msg)) return 'Não é possível remover o último administrador.';
  if (/already a member/i.test(msg)) return 'Esse usuário já é membro deste workspace.';
  // #10 Add User: duplicate email + weak password.
  if (/user with that email already exists/i.test(msg)) return 'Já existe um usuário com esse e-mail.';
  if (/at least 8 characters/i.test(msg)) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (/Valid email required/i.test(msg)) return 'Informe um e-mail válido.';
  if (/Cannot remove the organization owner/i.test(msg)) return 'Não é possível remover o dono da organização.';
  if (/Email send failed/i.test(msg)) return 'Falha ao enviar o e-mail. Tente de novo.';
  return `A ação falhou: ${msg}`;
}

function renderError(message) {
  return `<div style="color:var(--danger);font-size:14px;padding:16px;background:var(--bg-input);border-radius:6px">${esc(message)}</div>`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
const REMOVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
