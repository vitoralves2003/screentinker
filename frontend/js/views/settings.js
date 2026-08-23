import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { getLanguage, setLanguage, getAvailableLanguages, t } from '../i18n.js';
import { esc } from '../utils.js';
// Tabs delegate to the views that already own these screens — see the note on TABS below.
import * as billing from './billing.js';
import * as workspaceMembers from './workspace-members.js';
// The activity log lives here now rather than on a nav item of its own; the view owns the
// rendering and this page owns where it sits and who is shown it.
import { mountActivityLog } from './activity.js';

/*
 * Settings is a TAB SHELL.
 *
 * Subscription and Members used to be their own sidebar entries. Loop Player sells three things a
 * subscriber operates daily — Displays, Content, Playlists — and everything account-shaped now
 * lives behind one door instead of scattering more items down the nav.
 *
 * Each tab delegates to the view that already owns it (billing.js, workspace-members.js) rather
 * than reimplementing it here: they keep their own routes (#/billing and #/members still resolve,
 * so old links work), and there is one implementation of each screen, not two.
 *
 * WHO THIS PAGE BELONGS TO: the subscriber. The shopkeeper who pays for Loop Player and invites
 * their own staff — hence Account, Subscription, Members and Language, and nothing else. Running
 * the installation (users across every tenant, plans, branding, tokens, SSO, the server itself)
 * is a different job with a different owner, and it has its own page at #/admin. It was a tab
 * here, and a tab is how it leaked: with the page already open, the next control always looked
 * like it belonged one section further down.
 */
const TABS = [
  { id: 'account', labelKey: 'settings.tab_account' },
  { id: 'billing', labelKey: 'settings.tab_billing' },
  { id: 'members', labelKey: 'settings.tab_members' },
  /*
   * Last, and only for the owner. The tab is rendered and then REMOVED if the server says this
   * caller may not read the log. Asking first would make every visit to Settings wait on a
   * request that is irrelevant to whichever tab it actually opens on.
   */
  { id: 'activity', labelKey: 'activity.title', ownerOnly: true },
];

let activeTab = 'account';
let activeChild = null;   // the delegated view, so its cleanup() runs on switch

function childCleanup() {
  try { activeChild?.cleanup?.(); } catch { /* a failing cleanup must not block the switch */ }
  activeChild = null;
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('settings.title')}</h1>
        <div class="subtitle">${t('settings.subtitle')}</div>
      </div>
    </div>
    <div class="settings-tabs" id="settingsTabs">
      ${TABS.map(tb => `
        <button class="settings-tab${tb.id === activeTab ? ' active' : ''}" data-tab="${tb.id}">${t(tb.labelKey)}</button>
      `).join('')}
    </div>
    <div id="settingsTabBody"></div>
  `;

  /*
   * The owner-only tabs, removed rather than disabled. A tab that is visible and refuses is an
   * invitation to ask why; one that was never there asks nothing. The server enforces it either
   * way — this is only about what a member is shown.
   */
  for (const tb of TABS.filter((x) => x.ownerOnly)) {
    const el = container.querySelector(`.settings-tab[data-tab="${tb.id}"]`);
    if (!el) continue;
    el.hidden = true;
    isActivityAvailable().then((ok) => { if (ok) el.hidden = false; });
  }

  const body = container.querySelector('#settingsTabBody');
  container.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      container.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
      childCleanup();
      renderTab(body);
    });
  });

  await renderTab(body);
}

async function renderTab(body) {
  body.innerHTML = `<div class="empty-state"><h3>${t('common.loading')}</h3></div>`;
  if (activeTab === 'billing') {
    activeChild = billing;
    return billing.render(body);
  }
  if (activeTab === 'members') {
    // The workspace id is not in the tab; resolve it the same way the #/members route does.
    const me = getCachedUser();
    const ws = me?.current_workspace_id
      || (Array.isArray(me?.accessible_workspaces) && me.accessible_workspaces[0]?.id);
    if (!ws) { body.innerHTML = `<div class="empty-state"><h3>${t('noworkspace.title')}</h3></div>`; return; }
    activeChild = workspaceMembers;
    return workspaceMembers.render(body, ws);
  }
  if (activeTab === 'activity') {
    body.innerHTML = `<div class="settings-section">
      <h3>${t('activity.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('settings.activity_desc')}</p>
      <div id="activityHost"></div>
    </div>`;
    return mountActivityLog(document.getElementById('activityHost'));
  }
  return renderAccountTab(body);
}

/* Cached for the life of the page: the answer cannot change without a reload. */
let activityAvailable = null;
async function isActivityAvailable() {
  if (activityAvailable !== null) return activityAvailable;
  try {
    const res = await fetch('/api/activity/available', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    activityAvailable = res.ok ? !!(await res.json()).available : false;
  } catch {
    activityAvailable = false;
  }
  return activityAvailable;
}

function getCachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
}

async function renderAccountTab(container) {
  // Fetch fresh user from the server — plan_id and role may have been changed
  // by an admin since login. Fall back to localStorage if the request fails.
  let user;
  try { user = await api.getMe(); localStorage.setItem('user', JSON.stringify(user)); }
  catch { user = JSON.parse(localStorage.getItem('user') || '{}'); }

  // No page-header here: the shell above already rendered the title and the tab bar, and this
  // function now paints only the tab body.
  container.innerHTML = `
    <div class="settings-section">
      <h3>${t('settings.account')}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        <div class="form-group"><label>${t('auth.email')}</label><input type="email" class="input" value="${esc(user.email || '')}" disabled></div>
        <div class="form-group"><label>${t('auth.name')}</label><input type="text" id="acctName" class="input" value="${esc(user.name || '')}"></div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="acctEmailAlerts" ${user.email_alerts ? 'checked' : ''}>
          <span>${t('settings.email_alerts')}</span>
        </label>
      </div>
      <button class="btn btn-secondary btn-sm" id="saveAcctBtn">${t('settings.save_profile')}</button>

      ${user.auth_provider === 'local' ? `
      <div style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.change_password')}</h4>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('settings.password_min_8')}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
          <div class="form-group"><label>${t('settings.current_password')}</label><input type="password" id="acctCurrentPw" class="input" autocomplete="current-password"></div>
          <div class="form-group"><label>${t('settings.new_password')}</label><input type="password" id="acctNewPw" class="input" autocomplete="new-password"></div>
          <div class="form-group"><label>${t('settings.confirm_new_password')}</label><input type="password" id="acctConfirmPw" class="input" autocomplete="new-password"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="changePwBtn">${t('settings.change_password')}</button>
      </div>
      ` : `
      <p style="color:var(--text-muted);font-size:12px;margin-top:16px">${t('settings.sso_note', { provider: esc(user.auth_provider || 'SSO') })}</p>
      `}

      <!--
        Sign-in method (#258). An account has exactly ONE credential: a password, or one
        instance-wide provider. Linking deletes the password; unlinking requires a new one in the
        same step, so the account is never briefly left with no way in. Populated by loadSsoLink().
      -->
      <div id="ssoLinkBlock" style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.signin_method')}</h4>
        <p style="color:var(--text-muted);font-size:12px">…</p>
      </div>

      <!-- Two-factor authentication (#100). Populated by load2FA() from /auth/totp/status. -->
      <div id="twoFactorBlock" style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.2fa_title')}</h4>
        <p style="color:var(--text-muted);font-size:12px">…</p>
      </div>
    </div>

    <!-- Export, and only export. Taking your own data out is the difference between a
         subscription and a hostage situation, so every subscriber gets it. Import is the opposite
         direction — it bulk-creates devices, content and playlists from an arbitrary dump — and
         is a migration tool for whoever runs the installation, so it lives in Administration. -->
    <div class="settings-section">
      <h3>${t('settings.your_data')}</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${t('settings.your_data_desc')}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="exportDataBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          ${t('settings.export_my_data')}
        </button>
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="exportIncludeFiles"> ${t('settings.include_media_zip')}
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.language')}</h3>
      <select id="langSelect" class="input" style="width:200px;background:var(--bg-input)">
        ${getAvailableLanguages().map(l => `<option value="${l.code}" ${l.code === getLanguage() ? 'selected' : ''}>${l.name}</option>`).join('')}
      </select>
    </div>

    <!-- "About" is the legal pages, kept for everyone: a subscriber is entitled to the terms they
         agreed to. The build version is not their concern and is reported under Administration,
         next to the update button that changes it. -->
    <div class="settings-section">
      <h3>${t('settings.about')}</h3>
      <div style="color:var(--text-secondary);font-size:13px">
        <p style="margin-top:12px">
          <a href="/legal/terms.html" target="_blank" style="color:var(--accent);font-size:12px">${t('auth.terms')}</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--accent);font-size:12px">${t('auth.privacy')}</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/third-party.html" target="_blank" style="color:var(--accent);font-size:12px">${t('settings.third_party_licenses')}</a>
        </p>
      </div>
    </div>
  `;

  // Export data handler
  document.getElementById('exportDataBtn')?.addEventListener('click', () => {
    const includeFiles = document.getElementById('exportIncludeFiles')?.checked;
    const token = localStorage.getItem('token');
    const url = `/api/status/export?token=${token}${includeFiles ? '&include_files=true' : ''}`;
    window.location.href = url;
  });

  document.getElementById('langSelect')?.addEventListener('change', (e) => {
    // setLanguage dispatches hashchange so the router re-renders the current
    // view (including this settings page) with new strings — no refresh needed.
    setLanguage(e.target.value);
  });

  // ==================== Two-factor authentication (#100) ====================
  // Drives the merged TOTP backend (/api/auth/totp/*). Re-renders #twoFactorBlock
  // for each state: SSO note / disabled+enroll / recovery-codes / enabled+manage.
  /*
   * Sign-in method: password OR one instance-wide provider, never both.
   *
   * The warning on the link button is the whole UX: the local password is DELETED, not kept as a
   * fallback, and someone who does not read that will think they gained a second way in. Unlink
   * asks for the new password up front for the same reason — the account must never sit between
   * credentials.
   *
   * Only instance-wide providers appear. An organization's provider is chosen by a customer and
   * must not be attachable to a platform account; the server refuses it too.
   */
  async function loadSsoLink() {
    const block = document.getElementById('ssoLinkBlock');
    if (!block) return;
    const head = `<h4 style="font-size:14px;margin-bottom:8px">${t('settings.signin_method')}</h4>`;
    const muted = 'color:var(--text-muted);font-size:12px';
    const paint = (inner) => { block.innerHTML = head + inner; };

    let me;
    try { me = await api.getMe(); }
    catch (e) { paint(`<p style="${muted}">${esc(e.message)}</p>`); return; }

    let providers = [];
    try {
      const res = await fetch('/api/auth/providers');
      if (res.ok) providers = (await res.json()).providers || [];
    } catch { /* offline: fall through to the no-providers copy */ }

    if (me.auth_provider && me.auth_provider !== 'local') {
      const name = providers.find((p) => p.slug === me.auth_provider)?.name || me.auth_provider;
      paint(`
        <p style="${muted};margin-bottom:12px">${t('settings.signin_linked', { provider: esc(name) })}</p>
        <div id="unlinkForm" style="display:none;margin-bottom:12px">
          <p style="${muted};margin-bottom:8px">${t('settings.signin_unlink_desc')}</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <div class="form-group"><label>${t('settings.new_password')}</label><input type="password" id="unlinkPw" class="input" autocomplete="new-password"></div>
            <div class="form-group"><label>${t('settings.confirm_new_password')}</label><input type="password" id="unlinkPw2" class="input" autocomplete="new-password"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="unlinkConfirmBtn">${t('settings.signin_unlink_confirm')}</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="unlinkBtn">${t('settings.signin_unlink', { provider: esc(name) })}</button>
      `);
      document.getElementById('unlinkBtn').onclick = () => {
        document.getElementById('unlinkForm').style.display = '';
        document.getElementById('unlinkBtn').style.display = 'none';
        document.getElementById('unlinkPw').focus();
      };
      document.getElementById('unlinkConfirmBtn').onclick = async () => {
        const pw = document.getElementById('unlinkPw').value;
        const pw2 = document.getElementById('unlinkPw2').value;
        if (pw !== pw2) return showToast(t('settings.passwords_dont_match'), 'error');
        try {
          await api.ssoUnlink(pw);
          showToast(t('settings.signin_unlinked_toast'), 'success');
          loadSsoLink();
        } catch (e) { showToast(e.message, 'error'); }
      };
      return;
    }

    if (!providers.length) {
      paint(`<p style="${muted}">${t('settings.signin_password_only')}</p>`);
      return;
    }
    paint(`
      <p style="${muted};margin-bottom:12px">${t('settings.signin_password_now')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${providers.map((p) => `<button class="btn btn-secondary btn-sm" data-link-slug="${esc(p.slug)}">${t('settings.signin_link', { provider: esc(p.name) })}</button>`).join('')}
      </div>
    `);
    block.querySelectorAll('[data-link-slug]').forEach((btn) => {
      btn.onclick = async () => {
        const slug = btn.dataset.linkSlug;
        const name = providers.find((p) => p.slug === slug)?.name || slug;
        // Deliberately blunt: the password is destroyed, and that is the part people miss.
        if (!window.confirm(t('settings.signin_link_warning', { provider: name }))) return;
        /*
         * Fetch the authorize URL, then navigate to it. NOT location.href straight at the start
         * route: the session is a bearer token in localStorage, so a top-level navigation arrives
         * with no Authorization header and is refused as anonymous.
         */
        try {
          const { url } = await api.ssoLinkStart(slug);
          window.location.href = url;
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
  }

  async function load2FA() {
    const block = document.getElementById('twoFactorBlock');
    if (!block) return;
    const head = `<h4 style="font-size:14px;margin-bottom:8px">${t('settings.2fa_title')}</h4>`;
    const muted = 'color:var(--text-muted);font-size:12px';
    const paint = (inner) => { block.innerHTML = head + inner; };

    let status;
    try { status = await api.totpStatus(); }
    catch (e) { paint(`<p style="${muted}">${esc(e.message)}</p>`); return; }

    if (!status.eligible) {
      const provider = (JSON.parse(localStorage.getItem('user') || '{}').auth_provider) || 'SSO';
      paint(`<p style="${muted}">${t('settings.2fa_sso_note', { provider: esc(provider) })}</p>`);
      return;
    }
    if (status.enabled) return showEnabled(status.recovery_codes_remaining);
    return showDisabled();

    function showDisabled() {
      paint(`
        <p style="${muted};margin-bottom:12px">${t('settings.2fa_desc')}
          <span style="color:var(--text-secondary);margin-left:6px">${t('settings.2fa_status_off')}</span></p>
        <button class="btn btn-primary btn-sm" id="enable2faBtn">${t('settings.2fa_enable')}</button>`);
      document.getElementById('enable2faBtn').addEventListener('click', startEnroll);
    }

    async function startEnroll() {
      let data;
      try { data = await api.totpSetup(); } catch (e) { showToast(e.message, 'error'); return; }
      const qr = data.qr_data_url
        ? `<img src="${data.qr_data_url}" alt="TOTP QR" width="200" height="200" style="border-radius:8px;background:#fff;padding:6px">`
        : `<p style="${muted}">${t('settings.2fa_setup_manual')}</p>`;
      paint(`
        <p style="${muted};margin-bottom:10px">${t('settings.2fa_setup_scan')}</p>
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <div>${qr}</div>
          <div style="flex:1;min-width:220px">
            <p style="${muted}">${t('settings.2fa_setup_manual')}</p>
            <code style="display:block;word-break:break-all;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px;margin:6px 0 14px;font-family:monospace;font-size:13px">${esc(data.secret)}</code>
            <label style="${muted}">${t('settings.2fa_setup_confirm')}</label>
            <input type="text" id="enroll2faCode" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="${t('settings.2fa_code_placeholder')}" maxlength="6" style="letter-spacing:4px;text-align:center;font-family:monospace;margin:6px 0">
            <div style="display:flex;gap:8px;margin-top:6px">
              <button class="btn btn-primary btn-sm" id="enroll2faVerify">${t('settings.2fa_verify_enable')}</button>
              <button class="btn btn-secondary btn-sm" id="enroll2faCancel">${t('settings.2fa_cancel')}</button>
            </div>
          </div>
        </div>`);
      const codeEl = document.getElementById('enroll2faCode');
      codeEl.focus();
      const doEnable = async () => {
        const code = codeEl.value.trim();
        if (!code) { showToast(t('settings.2fa_code_required'), 'error'); return; }
        try {
          const r = await api.totpEnable(code);
          showToast(t('settings.2fa_enabled_toast'), 'success');
          showRecoveryCodes(r.recovery_codes);
        } catch (e) { showToast(e.message, 'error'); codeEl.select(); }
      };
      document.getElementById('enroll2faVerify').addEventListener('click', doEnable);
      codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnable(); });
      document.getElementById('enroll2faCancel').addEventListener('click', load2FA);
    }

    function showRecoveryCodes(codes) {
      const list = codes.map((c) => `<div>${esc(c)}</div>`).join('');
      const text = codes.join('\n');
      paint(`
        <p style="font-weight:600;margin-bottom:4px">${t('settings.2fa_recovery_title')}</p>
        <p style="${muted};margin-bottom:12px">${t('settings.2fa_recovery_warning')}</p>
        <div style="font-family:monospace;font-size:14px;letter-spacing:1px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:14px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 24px">${list}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="copyRecovery">${t('settings.2fa_recovery_copy')}</button>
          <button class="btn btn-secondary btn-sm" id="dlRecovery">${t('settings.2fa_recovery_download')}</button>
          <button class="btn btn-primary btn-sm" id="doneRecovery">${t('settings.2fa_recovery_done')}</button>
        </div>`);
      document.getElementById('copyRecovery').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); showToast(t('settings.2fa_recovery_copy'), 'success'); } catch { /* field is selectable */ }
      });
      document.getElementById('dlRecovery').addEventListener('click', () => {
        const blob = new Blob([text + '\n'], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'loop-player-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      document.getElementById('doneRecovery').addEventListener('click', load2FA);
    }

    function showEnabled(remaining) {
      paint(`
        <p style="margin-bottom:12px">
          <span style="color:var(--success);font-weight:600">✓ ${t('settings.2fa_status_on')}</span>
          <span style="${muted};margin-left:10px">${t('settings.2fa_recovery_remaining', { n: remaining })}</span></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="regen2faBtn">${t('settings.2fa_recovery_regenerate')}</button>
          <button class="btn btn-danger btn-sm" id="disable2faBtn">${t('settings.2fa_disable')}</button>
        </div>
        <div id="twoFactorAction" style="margin-top:12px"></div>`);
      document.getElementById('disable2faBtn').addEventListener('click', () => promptCode({
        prompt: t('settings.2fa_disable_prompt'), confirm: t('settings.2fa_disable_confirm'), danger: true,
        run: async (code) => { await api.totpDisable(code); showToast(t('settings.2fa_disabled_toast'), 'success'); load2FA(); },
      }));
      document.getElementById('regen2faBtn').addEventListener('click', () => promptCode({
        prompt: t('settings.2fa_regen_prompt'), confirm: t('settings.2fa_regen_confirm'),
        run: async (code) => { const r = await api.totpRegenRecovery(code); showRecoveryCodes(r.recovery_codes); },
      }));
    }

    function promptCode({ prompt, confirm, danger, run }) {
      const box = document.getElementById('twoFactorAction');
      box.innerHTML = `
        <p style="${muted};margin-bottom:6px">${prompt}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="twoFactorActionCode" class="input" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="${t('settings.2fa_code_placeholder')}" maxlength="12" style="max-width:170px;letter-spacing:3px;text-align:center;font-family:monospace">
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" id="twoFactorActionConfirm">${confirm}</button>
          <button class="btn btn-secondary btn-sm" id="twoFactorActionCancel">${t('settings.2fa_cancel')}</button>
        </div>`;
      const codeEl = document.getElementById('twoFactorActionCode');
      codeEl.focus();
      const go = async () => {
        const code = codeEl.value.trim();
        if (!code) { showToast(t('settings.2fa_code_required'), 'error'); return; }
        try { await run(code); } catch (e) { showToast(e.message, 'error'); codeEl.select(); }
      };
      document.getElementById('twoFactorActionConfirm').addEventListener('click', go);
      codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      document.getElementById('twoFactorActionCancel').addEventListener('click', () => { box.innerHTML = ''; });
    }
  }

  load2FA();
  loadSsoLink();

  /*
   * Report the outcome of a link round trip.
   *
   * The callback returns to #/settings rather than the login page — an authenticated user bounced
   * to a login screen to be told "that did not work" reads as having been signed out. Params are
   * stripped afterwards so a refresh or a copied URL does not replay the message.
   */
  (function reportLinkOutcome() {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    const linked = q.get('sso_linked');
    const err = q.get('sso_error');
    if (!linked && !err) return;
    if (linked) {
      showToast(t('settings.signin_linked_toast', { provider: linked }), 'success');
    } else {
      const known = ['link_email_mismatch', 'link_already_used', 'not_linkable', 'no_email',
        'email_unverified', 'verification_failed', 'provider_unavailable', 'provider_refused',
        'unknown_provider', 'expired', 'bad_state', 'no_code', 'server_error'];
      const key = known.includes(err) ? `settings.signin_err_${err}` : 'auth.sso_failed';
      showToast(t(key), 'error');
    }
    history.replaceState(null, '', location.pathname + location.search + '#/settings');
    loadSsoLink();
  }());

  document.getElementById('saveAcctBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('acctName').value.trim();
    if (!name) return showToast(t('settings.toast.name_required'), 'error');
    const email_alerts = !!document.getElementById('acctEmailAlerts')?.checked;
    const btn = document.getElementById('saveAcctBtn');
    btn.disabled = true;
    try {
      const updated = await api.updateMe({ name, email_alerts });
      const stored = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...stored, ...updated }));
      showToast(t('settings.toast.profile_saved'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('changePwBtn')?.addEventListener('click', async () => {
    const current = document.getElementById('acctCurrentPw').value;
    const next = document.getElementById('acctNewPw').value;
    const confirm = document.getElementById('acctConfirmPw').value;
    if (!current) return showToast(t('settings.toast.current_password_required'), 'error');
    if (next.length < 8) return showToast(t('settings.toast.new_password_min_8'), 'error');
    if (next !== confirm) return showToast(t('settings.toast.passwords_dont_match'), 'error');
    const btn = document.getElementById('changePwBtn');
    btn.disabled = true;
    try {
      await api.updateMe({ current_password: current, password: next });
      document.getElementById('acctCurrentPw').value = '';
      document.getElementById('acctNewPw').value = '';
      document.getElementById('acctConfirmPw').value = '';
      showToast(t('settings.toast.password_changed'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

export function cleanup() {
  // Tear down whichever tab is mounted. billing.js polls nothing but the members view may, and a
  // delegated view never sees the router's cleanup — the router only knows about Settings.
  childCleanup();
  // Next visit opens on Account rather than resuming a tab the user has navigated away from.
  activeTab = 'account';
}
