const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(url, options = {}) {
  const res = await fetch(API_BASE + url, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    // Token expired or invalid - redirect to login
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Devices
  getDevices: () => request('/devices'),
  reorderDevices: (order) => request('/devices/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
  getDevice: (id) => request(`/devices/${id}`),
  // What this screen put on air, grouped into the screen's OWN days — see lib/exhibition.js.
  getDeviceTimeline: (id, qs) => request(`/reports/device/${encodeURIComponent(id)}/timeline?${qs}`),
  // Where a file reaches now, and what it has played — see lib/file-report.js.
  getFileReport: (id, qs) => request(`/reports/file/${encodeURIComponent(id)}?${qs}`),
  getDeviceOwnerQR: () => request('/provision/device-owner-qr'),   // #161: device-owner provisioning
  // When a file may play. Blocks are OR; the server bakes them into each snapshot at publish time,
  // which is why saving marks the holding playlists draft rather than pushing silently.
  getContentSchedules: (id) => request(`/content/${id}/schedules`),
  setContentSchedules: (id, blocks) => request(`/content/${id}/schedules`, { method: 'PUT', body: JSON.stringify({ blocks }) }),
  // Typed rules — what the file dialog writes now. The blocks above are the older, flatter shape.
  getScheduleRules: (id) => request(`/content/${id}/schedule-rules`),
  setScheduleRules: (id, rules) => request(`/content/${id}/schedule-rules`, { method: 'PUT', body: JSON.stringify({ rules }) }),
  // One playlist per zone, for a multi-zone layout. GET returns every zone of the layout - the
  // empty ones too - so the page can draw a field for each.
  // When the place is open. Used to decide whether an offline screen is a fault or a closed shop.
  getDeviceHours: (id) => request(`/devices/${id}/hours`),
  setDeviceHours: (id, blocks) => request(`/devices/${id}/hours`, { method: 'PUT', body: JSON.stringify({ blocks }) }),
  // The landing page, in one request. Assembled server-side so opening the app does not fan
  // out into five calls, and so counting the files does not mean fetching them.
  getOverview: () => request('/devices/overview'),
  // A layout WITH its zones. Asked for the layout the operator just picked, which the device does
  // not know about yet — that is what lets the zone fields appear before anything is saved.
  getLayout: (id) => request(`/layouts/${id}`),
  getDeviceZones: (id) => request(`/layouts/device/${id}/zones`),
  setDeviceZones: (id, zones) => request(`/layouts/device/${id}/zones`, { method: 'PUT', body: JSON.stringify({ zones }) }),
  // Substituir tela: the screen keeps its identity, the hardware behind it changes.
  replaceDevice: (id, pairing_code) => request(`/devices/${id}/replace`, { method: 'POST', body: JSON.stringify({ pairing_code }) }),
  updateDevice: (id, data) => request(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDevice: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
  // #146 Item D: operator block/unblock — refuses the device at its next register with
  // no restart. Server enforces via the SNAT-safe identity chain (deviceSocket).
  blockDevice: (id) => request(`/devices/${id}/block`, { method: 'POST' }),
  unblockDevice: (id) => request(`/devices/${id}/unblock`, { method: 'POST' }),
  // #150: fingerprint-keyed settings snapshots of previously-removed devices (this workspace),
  // and the re-adopt action that applies a snapshot onto a newly-paired device.
  getRemovedDevices: () => request('/devices/removed'),
  reAdoptDevice: (id, fingerprint) => request(`/devices/${id}/re-adopt`, { method: 'POST', body: JSON.stringify({ fingerprint }) }),
  setDevicePin: (id, body) => request(`/devices/${id}/settings-pin`, { method: 'POST', body: JSON.stringify(body) }),

  // #109 PiP overlay: push/clear a floating overlay on a device or group. `id` may be a
  // device id OR a group id (the server resolves + expands). Needs full scope (no-op for JWT).
  sendPip: (id, opts) => request('/pip', { method: 'POST', body: JSON.stringify({ device_id: id, ...opts }) }),
  clearPip: (id, pipId) => request('/pip/clear', { method: 'POST', body: JSON.stringify({ device_id: id, pip_id: pipId || undefined }) }),

  // Provisioning
  pairDevice: (pairing_code, name) => request('/provision/pair', {
    method: 'POST',
    body: JSON.stringify({ pairing_code, name })
  }),

  // Content
  getContent: (folderId, includeExpired = false, opts = {}) => {
    const p = new URLSearchParams();
    // #214: a text search spans the whole workspace, so folder_id is only sent when
    // NOT searching (the server also ignores folder_id when q is present, but keeping
    // the client in sync avoids a misleading URL).
    const searching = opts.q && opts.q.trim();
    if (!searching && folderId !== undefined) p.set('folder_id', folderId === null ? 'root' : folderId);
    if (includeExpired) p.set('include_expired', '1');
    if (searching) p.set('q', opts.q.trim());
    if (opts.type && opts.type !== 'all') p.set('type', opts.type);
    if (opts.sort) p.set('sort', opts.sort);
    /*
     * The reader's own timezone, for the scheduling clock the server stamps on each row. A file
     * can be on air in Manaus and not in Recife; the clock on the wall of whoever is reading the
     * list is the honest answer for a list they are reading. Without it the server falls back to
     * its own zone, which is nobody's.
     */
    try { p.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { /* older engine */ }
    const qs = p.toString();
    return request(`/content${qs ? '?' + qs : ''}`);
  },
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
  updateContent: (id, data) => request(`/content/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveContent: (id, folderId) => request(`/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId })
  }),
  // #213: batch operations — the whole batch succeeds or fails atomically server-side.
  batchDeleteContent: (ids) => request('/content/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ ids })
  }),
  /*
   * Add the library's selected files to a playlist in one request. A loop of single adds fails
   * halfway and leaves the operator working out which half landed; this is one transaction and
   * reports how many were already there.
   */
  batchAddPlaylistItems: (playlistIds, contentIds) => request('/playlists/batch/add-items', {
    method: 'POST',
    body: JSON.stringify({ playlist_ids: playlistIds, content_ids: contentIds })
  }),

  // Folders
  getFolders: () => request('/folders'),
  createFolder: (name, parentId) => request('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId || null })
  }),
  renameFolder: (id, name) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  }),
  moveFolder: (id, parentId) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ parent_id: parentId || null })
  }),
  deleteFolder: (id) => request(`/folders/${id}`, { method: 'DELETE' }),
  // #212: accepts a single File or an array/FileList of Files. All go up in one request
  // under the `files` field (the server also still accepts the legacy `file` field).
  // onProgress reports aggregate percent across the whole batch. Resolves to the content
  // object for a single file, or an array of them for a batch.
  uploadContent: async (file, onProgress, folderId) => {
    const files = (file instanceof FileList || Array.isArray(file)) ? Array.from(file) : [file];
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    if (folderId) formData.append('folder_id', folderId);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/content`);
      const token = localStorage.getItem('token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error('Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(formData);
    });
  },

  addRemoteContent: (url, name, mime_type) => request('/content/remote', {
    method: 'POST',
    body: JSON.stringify({ url, name, mime_type })
  }),

  addYoutubeContent: (url, name) => request('/content/youtube', {
    method: 'POST',
    body: JSON.stringify({ url, name })
  }),

  // Assignments
  getAssignments: (deviceId) => request(`/assignments/device/${deviceId}`),
  addAssignment: (deviceId, data) => request(`/assignments/device/${deviceId}`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateAssignment: (id, data) => request(`/assignments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAssignment: (id) => request(`/assignments/${id}`, { method: 'DELETE' }),
  reorderAssignments: (deviceId, order) => request(`/assignments/device/${deviceId}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ order })
  }),

  // Widgets
  getWidgets: () => request('/widgets'),
  getWidget: (id) => request('/widgets/' + id),
  // Loop OS: the fixed widget catalogue in the playlist editor creates a widget and drops it
  // straight into the playlist, so the operator never visits a separate widget manager.
  createWidget: (data) => request('/widgets', { method: 'POST', body: JSON.stringify(data) }),
  // ...and the same catalogue reopens on an existing one, so changing a lottery widget from
  // Mega-Sena to Lotofácil does not mean deleting it and adding it back. The server pushes the
  // change to any display already showing it.
  updateWidget: (id, data) => request('/widgets/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  // Curated cities for the weather widget picker (server-owned, carries the coordinates).
  getWeatherCities: () => request('/widgets/weather/cities'),

  // Current workspace's plan + usage + the month in progress. The playlist editor reads
  // widgets_enabled / sublists_enabled from here to decide which tabs to offer.
  getSubscription: () => request('/subscription/me'),
  getPlans: () => request('/subscription/plans'),
  getInvoices: () => request('/subscription/invoices'),
  // Choose a plan. Paid plans require tax_id (CPF/CNPJ) the first time — Asaas cannot open a
  // customer without one, and finding that out at month close means an unbillable debt.
  setPlan: (data) => request('/subscription/plan', { method: 'POST', body: JSON.stringify(data) }),

  // Device Groups
  getGroups: () => request('/groups'),
  createGroup: (name, color) => request('/groups', { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateGroup: (id, data) => request(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resyncGroup: (id) => request(`/groups/${id}/resync`, { method: 'POST' }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: 'DELETE' }),
  getGroupDevices: (id) => request(`/groups/${id}/devices`),
  addDeviceToGroup: (groupId, device_id) => request(`/groups/${groupId}/devices`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  removeDeviceFromGroup: (groupId, deviceId) => request(`/groups/${groupId}/devices/${deviceId}`, { method: 'DELETE' }),
  sendGroupCommand: (groupId, type, payload) => request(`/groups/${groupId}/command`, { method: 'POST', body: JSON.stringify({ type, payload }) }),

  // Video walls
  getWalls: () => request('/walls'),
  createWall: (data) => request('/walls', { method: 'POST', body: JSON.stringify(data) }),
  setWallDevices: (id, devices) => request(`/walls/${id}/devices`, { method: 'PUT', body: JSON.stringify({ devices }) }),
  updateWall: (id, data) => request(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWall: (id) => request(`/walls/${id}`, { method: 'DELETE' }),

  // Playlists
  getPlaylists: () => request('/playlists'),
  createPlaylist: (name, description) => request('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getPlaylist: (id) => request(`/playlists/${id}`),
  updatePlaylist: (id, data) => request(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylist: (id) => request(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistItems: (id) => request(`/playlists/${id}/items`),
  addPlaylistItem: (id, data) => request(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlaylistItem: (id, itemId, data) => request(`/playlists/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  // Copies the list and its items; the copy is always a draft and is on no screen.
  duplicatePlaylist: (id) => request(`/playlists/${id}/duplicate`, { method: 'POST' }),
  duplicatePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}/duplicate`, { method: 'POST' }),
  reorderPlaylistItems: (id, order) => request(`/playlists/${id}/items/reorder`, { method: 'POST', body: JSON.stringify({ order }) }),
  // #74/#75 per-item schedule blocks
  getItemSchedules: (id, itemId) => request(`/playlists/${id}/items/${itemId}/schedules`),
  setItemSchedules: (id, itemId, blocks) => request(`/playlists/${id}/items/${itemId}/schedules`, { method: 'PUT', body: JSON.stringify({ blocks }) }),
  assignPlaylistToDevice: (playlistId, device_id) => request(`/playlists/${playlistId}/assign`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  clearDevicePlaylist: (device_id) => request(`/devices/${device_id}/playlist`, { method: 'DELETE' }),
  publishPlaylist: (id) => request(`/playlists/${id}/publish`, { method: 'POST' }),
  discardPlaylistDraft: (id) => request(`/playlists/${id}/discard`, { method: 'POST' }),

  // Device Groups - Playlist
  groupAssignPlaylist: (groupId, playlist_id) => request(`/groups/${groupId}/assign-playlist`, { method: 'POST', body: JSON.stringify({ playlist_id }) }),

  // API Tokens (personal access tokens, workspace-scoped)
  getTokens: () => request('/tokens'),
  createToken: (data) => request('/tokens', { method: 'POST', body: JSON.stringify(data) }),
  revokeToken: (id) => request('/tokens/' + id, { method: 'DELETE' }),
  setTokenTargets: (id, target_playlist_ids) => request('/tokens/' + id + '/targets', { method: 'PUT', body: JSON.stringify({ target_playlist_ids }) }), // #73: re-designate agency token playlists
  setTokenUploadFolder: (id, upload_folder_id) => request('/tokens/' + id + '/upload-folder', { method: 'PUT', body: JSON.stringify({ upload_folder_id }) }), // #158: rebind agency token upload folder (null = root)

  // TOTP 2FA (#100) — opt-in per-user, local accounts only. See routes/auth.js.
  totpStatus: () => request('/auth/totp/status'),
  // Unlink an instance-wide SSO provider. The new password is required in the same call:
  // the account must never sit between credentials.
  ssoUnlink: (password) => request('/auth/oidc/unlink', { method: 'POST', body: JSON.stringify({ password }) }),
  // Returns { url } to navigate to. Fetched rather than navigated to, because the session is
  // a bearer token and a top-level navigation cannot carry one.
  ssoLinkStart: (slug) => request(`/auth/oidc/${encodeURIComponent(slug)}/link/start`),
  totpSetup: () => request('/auth/totp/setup', { method: 'POST' }),
  totpEnable: (code) => request('/auth/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  totpDisable: (code) => request('/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  totpRegenRecovery: (code) => request('/auth/totp/recovery-codes/regenerate', { method: 'POST', body: JSON.stringify({ code }) }),

  // Email verification (signup). Resend is generic (never reveals whether the address exists).
  resendVerification: (email) => request('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }),

  // Current user
  getMe: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
  switchWorkspace: (workspaceId) => request('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  renameWorkspace: (id, data) => request(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  updateWorkspaceSecuritySettings: (workspaceId, data) => request(`/workspaces/${workspaceId}/security-settings`, { method: 'PUT', body: JSON.stringify(data) }),

  // Workspace members + invites (slice 2A read-only)
  getWorkspaceMembers: (id) => request(`/workspaces/${id}/members`),
  getWorkspaceInvites: (id) => request(`/workspaces/${id}/invites`),

  // Workspace member/invite mutations (slice 2B). All admin-only server-side
  // (canAdminWorkspace gate). Server returns translated English error messages
  // mapped to i18n keys via mapMutationError() in workspace-members.js.
  inviteWorkspaceMember: (workspaceId, data) => request(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: JSON.stringify(data) }),
  cancelWorkspaceInvite: (workspaceId, inviteId) => request(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' }),
  updateWorkspaceMemberRole: (workspaceId, userId, role) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (workspaceId, userId) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),

  // Slice 2C - accept a workspace invite by id (post-auth flow)
  acceptInvite: (inviteId) => request(`/auth/accept-invite/${inviteId}`, { method: 'POST' }),

  // Admin-provisioned user creation (#10). data: { email, name, password,
  // workspaceId, role, mustChangePassword }
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminCreateOrg: (name) => request('/admin/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  adminListOrgs: () => request('/admin/orgs'),
  // Platform-admin view: EVERY plan incl. hidden ones, with subscriber counts.
  adminListPlans: () => request('/admin/plans'),
  adminDeleteOrg: (id) => request(`/admin/orgs/${id}`, { method: 'DELETE' }),
  adminDeleteWorkspace: (id) => request(`/admin/workspaces/${id}`, { method: 'DELETE' }),
  aiGetSettings: () => request('/ai/settings'),
  aiSaveSettings: (data) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(data) }),
  aiGenerateDesign: (prompt) => request('/ai/generate-design', { method: 'POST', body: JSON.stringify({ prompt }) }),
  aiListModels: (base_url, api_key) => request('/ai/models', { method: 'POST', body: JSON.stringify({ base_url, api_key }) }),

  // The tenant's own company details — what a nota fiscal is made out to.
  getBillingProfile: () => request('/subscription/billing-profile'),
  saveBillingProfile: (data) => request('/subscription/billing-profile', { method: 'PUT', body: JSON.stringify(data) }),
  // Integrations: the Asaas key and the mail server, editable without a deploy.
  adminGetIntegrations: () => request('/admin/integrations'),
  adminSaveAsaas: (data) => request('/admin/integrations/asaas', { method: 'PUT', body: JSON.stringify(data) }),
  adminClearAsaasKey: () => request('/admin/integrations/asaas/key', { method: 'DELETE' }),
  adminTestAsaas: () => request('/admin/integrations/asaas/test', { method: 'POST', body: '{}' }),
  adminSaveSmtp: (data) => request('/admin/integrations/smtp', { method: 'PUT', body: JSON.stringify(data) }),
  adminTestSmtp: (to) => request('/admin/integrations/smtp/test', { method: 'POST', body: JSON.stringify({ to }) }),
  // #146: toggle the /api/status debug block exposure (platform-admin only).
  adminGetStatusDebug: () => request('/admin/status-debug'),
  adminSetStatusDebug: (enabled) => request('/admin/status-debug', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // Opt-in install statistics. GET returns { state, payload, last_report } — payload is the exact
  // body that would be sent, so the UI can show it rather than describe it.

  // Per-user workspace membership management (platform Users page modal).
  adminGetUserWorkspaces: (id) => request(`/admin/users/${id}/workspaces`),
  adminAddUserWorkspace: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces`, { method: 'POST', body: JSON.stringify({ workspaceId, role }) }),
  adminSetUserWorkspaceRole: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  adminRemoveUserWorkspace: (id, workspaceId) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'DELETE' }),

  // Admin - Users
  getUsers: () => request('/auth/users'),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id, password) => request(`/auth/users/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }),
  assignPlan: (user_id, plan_id) => request('/subscription/assign', {
    method: 'POST',
    body: JSON.stringify({ user_id, plan_id })
  }),
};
