import { connectSocket, on } from './socket.js';
import { livenessState } from './utils.js';
import * as dashboard from './views/dashboard.js';
import * as operations from './views/operations.js';
import * as deviceDetail from './views/device-detail.js';
import * as contentLibrary from './views/content-library.js';
import * as settings from './views/settings.js';
import * as login from './views/login.js';
import * as billing from './views/billing.js';
import * as layoutEditor from './views/layout-editor.js';
import * as schedule from './views/schedule.js';
import * as widgets from './views/widgets.js';
import * as videoWall from './views/video-wall.js';
import * as reports from './views/reports.js';
import * as kiosk from './views/kiosk.js';
import * as onboarding from './views/onboarding.js';
import * as help from './views/help.js';
import * as teams from './views/teams.js';
import * as admin from './views/admin.js';
import * as adminPlayerDebug from './views/admin-player-debug.js';
import * as designer from './views/designer.js';
import * as playlists from './views/playlists.js';
import * as workspaceMembers from './views/workspace-members.js';
import * as forcePasswordChange from './views/force-password-change.js';
import * as noWorkspace from './views/no-workspace.js';
import { isPlatformAdmin } from './utils.js';
import { showToast } from './components/toast.js';
import { api } from './api.js';

const app = document.getElementById('app');
const sidebar = document.querySelector('loop-sidebar');
let currentView = null;

// ==================== Slice 2C: accept-invite plumbing ====================
//
// Flow shape (covers all six auth entry points - login, register, support,
// Google, Microsoft, first-user-setup - because they all funnel through
// onAuthSuccess() in login.js which calls window.location.reload()):
//
//   1. Hash route #/accept-invite/{id}:
//      - unauthed: stash inviteId in localStorage, redirect to login
//      - authed:   call consumeAcceptInvite() directly (no stash)
//   2. App boot (every route() call once auth checks pass): if a valid
//      non-stale stash is present, fire consumeAcceptInvite. After login
//      reload lands here and picks it up automatically.
//   3. consumeAcceptInvite on success: stash toast text, switch workspace,
//      reload. Reload re-fires route() which picks up the toast stash and
//      shows it on dashboard. Reload is needed for the new JWT/socket/
//      sidebar /me to pick up the new workspace context.
//   4. consumeAcceptInvite on error: showToast directly + clear stash.
//      No reload (no state change to propagate).

const PENDING_INVITE_KEY = 'pending_invite';
const PENDING_INVITE_TOAST_KEY = 'pending_invite_toast';
// Mirrors the backend INVITE_EXPIRY_DAYS default (7). If an operator changes
// the backend default, this should be updated to match - tracked in handoff.
const INVITE_EXPIRY_DAYS_FRONTEND = 7;

// Non-reentrant guard: route() can fire multiple times (hashchange events).
// Once consume is in flight, additional calls no-op until reload completes.
let _acceptInFlight = false;

function stashPendingInvite(inviteId) {
  localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({
    inviteId,
    stashedAt: Math.floor(Date.now() / 1000),
  }));
}

function readPendingInvite() {
  const raw = localStorage.getItem(PENDING_INVITE_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { localStorage.removeItem(PENDING_INVITE_KEY); return null; }
  if (!parsed?.inviteId || !parsed?.stashedAt) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  const ageSecs = Math.floor(Date.now() / 1000) - parsed.stashedAt;
  if (ageSecs > INVITE_EXPIRY_DAYS_FRONTEND * 86400) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  return parsed.inviteId;
}

function clearPendingInvite() {
  localStorage.removeItem(PENDING_INVITE_KEY);
}

// Map backend error message text to a translated toast string. We match
// English text because api.js doesn't surface HTTP status codes today;
// refactor to err.status when that lands - tracked in handoff doc.
function mapAcceptError(err) {
  const msg = err?.message || '';
  if (/Invite not found/i.test(msg)) return 'O convite não é mais válido';
  if (/Invite has expired|Workspace no longer exists/i.test(msg)) return 'Este convite expirou — peça um novo ao administrador';
  if (/different email address/i.test(msg)) return 'Este convite é para outro e-mail. Saia e entre com a conta correta.';
  return 'Não foi possível aceitar o convite. Tente de novo ou fale com o administrador.';
}

async function consumeAcceptInvite(inviteId) {
  if (_acceptInFlight) return;
  _acceptInFlight = true;
  try {
    const result = await api.acceptInvite(inviteId);

    // Switch to the joined workspace. New JWT carries the workspace context;
    // reload picks it up for sidebar /me + socket rooms + data fetches. If
    // the switch fails, log and reload anyway - the membership was created
    // so the user can switch manually via the dropdown.
    try {
      const sw = await api.switchWorkspace(result.workspace_id);
      if (sw?.token) localStorage.setItem('token', sw.token);
    } catch (e) {
      console.warn('switchWorkspace after accept failed (non-fatal):', e.message);
    }

    // Stash the toast text in a scoped key (not a generic pending-toast
    // channel) so app boot below fires it after reload.
    const nome = result.workspace_name;
    localStorage.setItem(PENDING_INVITE_TOAST_KEY, JSON.stringify({
      message: result.already_member ? `Você já é membro de ${nome}` : `Você entrou em ${nome}`,
      kind: 'success',
    }));

    clearPendingInvite();
    // history.replaceState mutates the hash WITHOUT firing hashchange.
    // Important: a plain `location.hash = '#/'` would fire hashchange
    // synchronously, causing route() to fire a second time before the
    // reload runs - that second route() call would consume the toast key
    // and attach the toast to a DOM that's about to be destroyed by the
    // reload. Using replaceState bypasses that race so the post-reload
    // route() is the only one that picks up the toast.
    history.replaceState(null, '', window.location.pathname + '#/');
    window.location.reload();
  } catch (err) {
    showToast(mapAcceptError(err), 'error');
    clearPendingInvite();
    _acceptInFlight = false;
  }
}

// Fires once per page load (single-shot key in localStorage). If the
// previous routeApp cycle stashed a toast across reload, show it now.
function consumePendingInviteToast() {
  const raw = localStorage.getItem(PENDING_INVITE_TOAST_KEY);
  if (!raw) return;
  localStorage.removeItem(PENDING_INVITE_TOAST_KEY);
  try {
    const { message, kind } = JSON.parse(raw);
    if (message) showToast(message, kind || 'info');
  } catch {}
}

/*
 * NAV_LABEL_KEYS saiu daqui.
 *
 * Era o mapa de `data-view` para chave de traducao, usado pela versao antiga de
 * renderNavLabels que percorria os `.nav-link` do DOM claro. Nao ha mais `.nav-link`: a barra
 * e um componente, e os rotulos entram por propriedade.
 *
 * O que substitui e `rotulosTraduzidos()`, mais abaixo, chaveado pelo ID DO ITEM SERVIDO em
 * vez de por data-view -- que e a mesma chave que o servidor usa. Duas convencoes de nome para
 * a mesma coisa era um lugar a menos onde as duas barras podiam discordar.
 */

/*
 * How many screens need attention, said in words, from anywhere in the app.
 *
 * THE NUMBER COMES FROM THE SERVER, and this function no longer decides anything.
 *
 * It used to fetch the fleet and count whatever read offline or degraded — knowing nothing about
 * opening hours. A bakery that shuts at 19:00 lit this line every night, and the line is a LINK to
 * Operação, which correctly listed nothing. A link that leads to an empty page teaches the reader
 * it lies, which is the one property it cannot have on the night a screen really dies.
 *
 * It was wrong in the other direction too: a screen that is online, healthy and has no playlist
 * shows a black window and answers every ping. The server counts it; this never did. Over-counting
 * shut shops and under-counting dark ones, from the same eight lines.
 *
 * lib/fleet-attention.js is now the only thing that decides, and /devices/attention is the long
 * form of the same answer Operação shows. They cannot disagree because there is nothing left here
 * to disagree with.
 *
 * It is a line rather than a badge on purpose: a red circle reading "1" asks a question the reader
 * then has to go and answer, while "1 tela precisa de atenção" has answered it already — and it
 * sits directly under the workspace name, where the eye lands after establishing whose screens
 * these are.
 */
/*
 * A PILULA DE ATENCAO passou a vir no menu (`atencao_telas`), desenhada pelo componente.
 *
 * Esta funcao perguntava a contagem por conta propria (api.getAttentionCount) e escrevia o
 * texto num elemento do HTML. Eram DUAS respostas para "quantas telas precisam de atencao" --
 * esta e a do menu -- e duas respostas que concordam hoje discordam depois que alguem mexer
 * numa delas. Ja aconteceu neste produto com a pergunta "qual plano".
 *
 * Agora ela reencaminha para quem ja sabe. O custo e uma chamada a /api/menu em vez de uma a
 * /api/attention-count, nos mesmos eventos de sempre -- e a frota muda debaixo de quem esta
 * olhando outra pagina, que e o caso inteiro pelo qual isto existe.
 */
async function refreshFleetAlerts() {
  if (!isAuthenticated()) return;
  await alimentarBarra();
}

/*
 * The line is a link, so it needs no click handler of its own — but the fleet changes underneath
 * you, and a screen dropping while you are on Conteúdo is the whole case this exists for.
 */
function wireFleetAlerts() {
  if (!document.querySelector('loop-sidebar')) return;
  on('device-status', refreshFleetAlerts);
  on('device-added', refreshFleetAlerts);
  on('device-removed', refreshFleetAlerts);

  /*
   * Opening hours and playlists change the ANSWER without any screen changing state, and that was
   * the reported bug: an operator set a screen's hours, Operação stopped listing it, and this line
   * kept insisting. Three socket events about liveness cannot cover a rule that is not about
   * liveness.
   */
  window.addEventListener('device-config-changed', refreshFleetAlerts);

  /*
   * And a recount on navigation, as the backstop. Every event above can be missed — a socket that
   * dropped, a change made in another tab, a save from a screen that forgot to announce it — and
   * the failure mode of a missed event here is precisely the stale alarm this is fixing. Cheap:
   * one small query, only when the view actually changes.
   */
  window.addEventListener('hashchange', refreshFleetAlerts);

  refreshFleetAlerts();
}

/*
 * OS ROTULOS DA BARRA, quando o idioma muda.
 *
 * Esta funcao percorria os `.nav-link` do HTML trocando o texto de cada um. Nao ha mais
 * `.nav-link` no DOM claro: a barra e um componente, e os rotulos entram por propriedade.
 *
 * Ela continua existindo, com o mesmo nome e os mesmos dois chamadores (o arranque e o evento
 * `language-changed`), porque o QUE ela faz nao mudou -- so onde ela escreve.
 */
function renderNavLabels() {
  const barra = document.querySelector('loop-sidebar');
  if (barra) barra.rotulos = rotulosTraduzidos();
}


function isAuthenticated() {
  return !!localStorage.getItem('token');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch { return null; }
}

// #12: true when a signed-in user provably has zero accessible workspaces and
// no platform-level reach. Requires accessible_workspaces to be present (only
// /me populates it) - undefined means "not loaded yet", so we DON'T trigger and
// fall through to the normal (workspace-empty-safe) views until /me resolves.
function hasNoAccessibleWorkspace(u) {
  return !!u
    && Array.isArray(u.accessible_workspaces)
    && u.accessible_workspaces.length === 0
    && !u.current_workspace_id
    && !isPlatformAdmin(u);
}

// Refresh the cached user from the server. The server reads plan_id fresh
// from the DB on every request, but the frontend only wrote `user` into
// localStorage at login — so plan/role changes made by an admin weren't
// visible until the user logged out and back in.
async function refreshCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    alimentarBarra();
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const fresh = await res.json();
    localStorage.setItem('user', JSON.stringify(fresh));
    /*
     * O seletor de workspace saiu. Workspace deixou de ser um conceito do produto (um cliente
     * e uma operacao), entao nao ha o que selecionar -- e o nome do cliente passou a vir no
     * proprio menu, por montarLugar(), igual nos dois modulos.
     */
    window.dispatchEvent(new CustomEvent('user-refreshed', { detail: fresh }));
    // #12: /me is the first place accessible_workspaces is known. If it resolves
    // to zero (org-less user), send them to the empty state now - on a fresh
    // load route() may have already rendered the dashboard before /me returned.
    // Guard against the login / change-password / already-there screens to avoid
    // a redirect loop.
    const hash = window.location.hash || '#/';
    if (hasNoAccessibleWorkspace(fresh)
        && hash !== '#/no-workspace' && !hash.startsWith('#/login') && hash !== '#/change-password') {
      window.location.hash = '#/no-workspace';
    }
  } catch {}
}

/*
 * The long-press label, which is all that is left of what used to be enableTouchLabels().
 *
 * The page-title "?" markers are gone — thirteen of them, one per view. What went with them was
 * everything that existed to make a .help-tip reachable without a mouse: the tabindex pass, the
 * MutationObserver that caught tips rendered by a route nobody remembered to hook, and the
 * click/Escape toggling.
 *
 * THIS part is not about those tips and stays. A native title= is hover-only, so an icon-only
 * button (rename a wall, remove a device from one, manage members) explains itself on a desktop
 * and says nothing at all on a touchscreen. Long-press one and its label comes up as a toast —
 * the text already exists and is already translated, it simply had no way to reach a finger.
 */
let touchLabelsBound = false;
function enableTouchLabels() {
  if (touchLabelsBound) return;
  touchLabelsBound = true;
  let pressTimer = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[title]');
    if (!el) return;
    const label = el.getAttribute('title');
    if (!label) return;
    pressTimer = setTimeout(() => showToast(label, 'info'), 500);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    document.addEventListener(ev, cancelPress, { passive: true }));
}

function route() {
  refreshFleetAlerts();

  // Cleanup previous view
  if (currentView && currentView.cleanup) currentView.cleanup();

  const hash = window.location.hash || '#/';

  // Slice 2C - direct hits on #/accept-invite/{id}. Handle BEFORE the
  // auth-redirect-to-login because an unauthed visit needs to stash the
  // inviteId so it survives the redirect.
  if (hash.startsWith('#/accept-invite/')) {
    const inviteId = hash.split('#/accept-invite/')[1].split('/')[0];
    if (inviteId) {
      if (!isAuthenticated()) {
        stashPendingInvite(inviteId);
        window.location.hash = '#/login';
        return;
      }
      consumeAcceptInvite(inviteId); // helper handles routing (reload to '#/')
      return;
    }
  }

  // Password-reset links arrive from email on a browser that is by definition NOT logged
  // in, and carry a one-time token in the hash. This must be handled BEFORE the redirect
  // below: rewriting the hash would discard the token and the emailed link would silently
  // do nothing. The login view reads the token off the hash and shows the new-password form.
  const isResetRoute = hash.startsWith('#/reset-password');

  /*
   * ⚠️ The SAME rule the comment above states, for the login route.
   *
   * The server finishes every single sign-on by redirecting to `#/login?sso=1` (claim the session)
   * or `#/login?sso_error=<code>` (say what went wrong). Matching the hash EXACTLY meant neither
   * survived: an unauthenticated browser — the only kind that arrives here — had the hash rewritten
   * to a bare `#/login` and the query was gone before the login view ever ran. So a user who
   * authenticated perfectly at their identity provider landed back on a clean login page, still
   * signed out, with no message; and all sixteen error codes rendered SILENCE, which is worse than
   * a wrong message because there is nothing to report or search for.
   *
   * It took the pre-existing `?verified=1` email-verification toast with it.
   */
  const isLoginRoute = hash === '#/login' || hash.startsWith('#/login?');

  // Auth check - redirect to login if not authenticated
  if (!isAuthenticated() && !isLoginRoute && !isResetRoute) {
    window.location.hash = '#/login';
    return;
  }

  // If authenticated and on login page, redirect to dashboard or onboarding
  if (isAuthenticated() && (isLoginRoute || isResetRoute)) {
    window.location.hash = localStorage.getItem('rd_onboarded') ? '#/' : '#/onboarding';
    return;
  }

  // Slice 2C - past the auth gates. (a) Show any toast stashed across the
  // accept-invite reload boundary. (b) If a stash exists (from an unauthed
  // accept-invite visit + subsequent login/register), consume it now. The
  // helper's in-flight guard prevents double-fire on subsequent hashchanges.
  if (isAuthenticated()) {
    consumePendingInviteToast();
    const stashedInviteId = readPendingInvite();
    if (stashedInviteId) {
      consumeAcceptInvite(stashedInviteId);
      return;
    }
  }

  // #10: forced first-login password change. An admin-provisioned user carries
  // must_change_password until they set their own password. Block every other
  // authenticated view and force them to the change-password screen; the server
  // clears the flag on a successful PUT /api/auth/me. The screen itself is the
  // one exception (so they can actually change it).
  if (isAuthenticated()) {
    const u = getCurrentUser();
    if (u && u.must_change_password && hash !== '#/change-password') {
      window.location.hash = '#/change-password';
      return;
    }
    if (hash === '#/change-password') {
      if (!u || !u.must_change_password) {
        // Not (or no longer) required - don't strand the user on a dead screen.
        window.location.hash = '#/';
        return;
      }
      sidebar.style.display = 'none';
      app.style.marginLeft = '0';
      const mb = document.getElementById('mobileMenuBtn');
      if (mb) mb.style.display = 'none';
      currentView = forcePasswordChange;
      forcePasswordChange.render(app);
      return;
    }
  }

  // #12: a signed-in user with zero accessible workspaces (org-less self-signup
  // on an AUTO_CREATE_ORG_ON_SIGNUP=false deployment) lands on a "no workspaces
  // yet" empty state instead of being bounced into onboarding (whose pairing
  // step needs a workspace). Only fires once /me has populated
  // accessible_workspaces; until then the workspace-empty-safe dashboard shows.
  if (isAuthenticated()) {
    const u = getCurrentUser();
    if (hasNoAccessibleWorkspace(u) && hash !== '#/no-workspace') {
      window.location.hash = '#/no-workspace';
      return;
    }
    if (hash === '#/no-workspace') {
      if (!hasNoAccessibleWorkspace(u)) { window.location.hash = '#/'; return; }
      sidebar.style.display = 'none';
      app.style.marginLeft = '0';
      const mb = document.getElementById('mobileMenuBtn');
      if (mb) mb.style.display = 'none';
      currentView = noWorkspace;
      noWorkspace.render(app);
      return;
    }
  }

  // Onboarding for new users
  if (hash === '#/onboarding' && isAuthenticated()) {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    currentView = onboarding;
    onboarding.render(app);
    return;
  }

  // Login page (and password-reset links from email) - hide sidebar.
  // Matches `#/login?...` too: the single sign-on return carries `?sso=1` / `?sso_error=<code>`,
  // and an exact comparison meant the login view was never rendered for either.
  if (isLoginRoute || isResetRoute) {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    const mb = document.getElementById('mobileMenuBtn');
    if (mb) mb.style.display = 'none';
    currentView = login;
    login.render(app);
    return;
  }

  // Show sidebar for authenticated views
  sidebar.style.display = '';
  app.style.marginLeft = '';
  const mb = document.getElementById('mobileMenuBtn');
  if (mb) mb.style.display = '';

  // Update user info in sidebar
  updateSidebarUser();

  /*
   * QUAL ITEM FICA ACESO -- dito pelo hospedeiro, nao adivinhado pelo componente.
   *
   * O componente sabe casar o href do item com o endereco da janela, e isso resolve o caso
   * simples. Nao resolve os de verdade: #/device/123 tem de manter TELAS aceso (a pessoa
   * chegou la pela lista), e #/devices?f=atencao tambem. Uma barra que apaga quando voce entra
   * num item da lista faz parecer que voce saiu da secao.
   *
   * Quem conhece as rotas deste modulo e este modulo. Por isso o atributo `ativo` existe e
   * ganha do casamento por href -- ver _estaAtivo no componente.
   */
  const barraAtiva = document.querySelector('loop-sidebar');
  if (barraAtiva) {
    let ativo = '';
    if (hash === '#/devices' || hash.startsWith('#/devices?') || hash.startsWith('#/device/')) ativo = 'telas';
    else if (hash.startsWith('#/content')) ativo = 'arquivos';
    else if (hash === '#/playlists' || hash.startsWith('#/playlists/')) ativo = 'playlists';
    else if (hash === '#/reports') ativo = 'relatorios';
    else if (hash === '#/layouts' || hash.startsWith('#/layout')) ativo = 'layouts';
    else if (hash.startsWith('#/admin')) ativo = 'administracao';
    else if (hash === '#/help') ativo = 'ajuda';
    else if (hash.startsWith('#/settings')) ativo = 'configuracoes';
    /*
     * '#/' e a Operacao, que nao tem item na barra por decisao -- a marca e a unica porta dela.
     * E as rotas sem item (#/schedule, #/widgets, #/walls, #/designer, #/kiosk, #/billing)
     * deixam a barra sem nada aceso, que e a resposta honesta: elas sairam da barra, mas
     * continuam abrindo por endereco salvo.
     */
    if (ativo) barraAtiva.setAttribute('ativo', ativo);
    else barraAtiva.removeAttribute('ativo');
  }

  /*
   * The mobile bar's title, taken from whichever nav item just became active rather than from a
   * second table of route-to-name. A parallel list would be one more thing to update whenever a
   * route is added, and the failure mode is silent: the bar keeps saying the previous page.
   *
   * Operação has no nav entry by decision (the wordmark is its only way in), so it names itself.
   */
  const topbarTitle = document.getElementById('mobileTopbarTitle');
  if (topbarTitle) {
    /*
     * O nome da pagina sai do item que acabou de acender -- e nao de uma segunda tabela de
     * rota-para-nome, que seria mais uma coisa a atualizar a cada rota nova, falhando em
     * silencio (a barra continuaria dizendo o nome da pagina anterior).
     *
     * A busca atravessa para o Shadow DOM, que e onde o item vive agora.
     */
    const barraTopo = document.querySelector('loop-sidebar');
    const aceso = barraTopo && barraTopo.shadowRoot
      && barraTopo.shadowRoot.querySelector('a.item[aria-current="page"] .texto');
    const isOverview = hash === '#/' || hash === '#' || hash === '';
    topbarTitle.textContent = isOverview ? 'Operação' : (aceso ? aceso.textContent : '');
  }

  // Route to view
  /*
   * The app opens on Operação, not on the screen list.
   *
   * The list answers "what do I do to this screen"; the landing page answers "is anything wrong
   * and am I running out of room", which is the question you have BEFORE you have a task. The
   * three counters that used to sit above the list live there now rather than in both places.
   */
  if (hash === '#/' || hash === '#' || hash === '') {
    currentView = operations;
    operations.render(app);
  } else if (hash === '#/devices' || hash.startsWith('#/devices?')) {
    // Telas aceita um filtro na propria rota (#/devices?f=fora-do-ar, ?id=...), para que um
    // numero mostrado em outro lugar possa APONTAR para as telas que ele conta. A rota base
    // continua sendo a mesma view; quem le o filtro e a propria dashboard.
    currentView = dashboard;
    dashboard.render(app);
  } else if (hash.startsWith('#/device/')) {
    const deviceId = hash.split('#/device/')[1].split('/')[0];
    currentView = deviceDetail;
    deviceDetail.render(app, deviceId);
  } else if (hash === '#/content') {
    currentView = contentLibrary;
    contentLibrary.render(app);
  } else if (hash === '#/playlists' || hash.startsWith('#/playlists/')) {
    currentView = playlists;
    playlists.render(app);
  } else if (hash === '#/layouts' || hash.startsWith('#/layout/')) {
    currentView = layoutEditor;
    layoutEditor.render(app);
  } else if (hash === '#/schedule') {
    currentView = schedule;
    schedule.render(app);
  } else if (hash === '#/widgets') {
    currentView = widgets;
    widgets.render(app);
  } else if (hash === '#/walls' || hash.startsWith('#/wall/')) {
    currentView = videoWall;
    videoWall.render(app);
  } else if (hash === '#/reports' || hash.startsWith('#/reports?')) {
    /*
     * Deep-linked from a screen, a file or a list: #/reports?tab=screens&id=<uuid>. The link is
     * the only thing those pages keep now that the panels are gone, so it has to arrive filtered
     * — landing on an unfiltered report page would mean hunting for the subject in a list.
     */
    const qs = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    currentView = reports;
    reports.render(app, new URLSearchParams(qs));
  } else if (hash === '#/kiosk' || hash.startsWith('#/kiosk/')) {
    currentView = kiosk;
    kiosk.render(app);
  } else if (hash === '#/designer' || hash.startsWith('#/designer/')) {
    currentView = designer;
    // #/designer/<widgetId> reopens a designer-made widget for editing; #/designer starts fresh.
    const wid = hash.startsWith('#/designer/') ? hash.split('#/designer/')[1].split('/')[0] : null;
    designer.render(app, wid || undefined);
  } else if (hash === '#/teams' || hash.startsWith('#/team/')) {
    currentView = teams;
    teams.render(app);
  } else if (hash === '#/members') {
    // The static nav link cannot know the workspace id, so resolve it here from the signed-in
    // user. Falls back to the first accessible workspace, and to the dashboard when there is
    // none at all — better than rendering a members page for nothing.
    // /me is cached in localStorage by refreshCurrentUser(); there is no in-memory copy.
    let me = null;
    try { me = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { me = null; }
    const activeWs = me?.current_workspace_id
      || (Array.isArray(me?.accessible_workspaces) && me.accessible_workspaces[0]?.id);
    if (!activeWs) { window.location.hash = '#/'; return; }
    currentView = workspaceMembers;
    workspaceMembers.render(app, activeWs);
  } else if (hash.startsWith('#/workspace/') && hash.includes('/members')) {
    const wsId = hash.split('#/workspace/')[1].split('/')[0];
    currentView = workspaceMembers;
    workspaceMembers.render(app, wsId);
  } else if (hash === '#/help' || hash.startsWith('#/help')) {
    currentView = help;
    help.render(app);
  } else if (hash.startsWith('#/admin/player-debug')) {
    // Match prefix so query params (?page=2&ua=Tizen) route correctly.
    currentView = adminPlayerDebug;
    adminPlayerDebug.render(app);
  } else if (hash === '#/admin') {
    currentView = admin;
    admin.render(app);
  /*
   * `?aba=` FAZ PARTE DA ROTA, e a igualdade exata a recusava.
   *
   * A fileira de configuracoes passou a dizer QUAL aba abrir no proprio endereco (Etapa 5b).
   * Com `hash === '#/settings'`, `#/settings?aba=conta` nao casava com nada: a tela nunca
   * montava. E o sintoma enganava -- a linha 509 usa startsWith, entao a barra DESTACAVA
   * "Configuracoes" com a pagina vazia atras.
   *
   * Mesma forma que #/devices e #/reports ja usam neste arquivo.
   */
  } else if (hash === '#/settings' || hash.startsWith('#/settings?')) {
    currentView = settings;
    settings.render(app);
  } else if (hash === '#/billing') {
    // #116: when HIDE_BILLING is set, a direct #/billing navigation is bounced to the
    // dashboard. replaceState (not a hash assignment) so it doesn't add a history entry
    // — the back button skips over it instead of looping back into the guard.
    if (getCurrentUser()?.hide_billing) {
      history.replaceState(null, '', window.location.pathname + '#/');
      currentView = dashboard;
      dashboard.render(app);
    } else {
      currentView = billing;
      billing.render(app);
    }
  } else {
    currentView = dashboard;
    dashboard.render(app);
  }
}

function updateSidebarUser() {
  const user = getCurrentUser();
  if (!user) return;
  updateVerifyBanner(user);
  updateWidgetSandboxWarningBanner(user);

  /*
   * QUEM VÊ LAYOUTS E ADMINISTRAÇÃO — decidido no servidor, não mais aqui.
   *
   * Aqui havia duas linhas escondendo `#layoutsNavItem` e `#adminNavItem` para quem não é
   * administrador de plataforma. Os dois elementos não existem mais no HTML: os itens passaram
   * a vir do menu servido (server/routes/menu.js, `transversais`), que aplica o mesmo critério
   * — e o aplica antes de mandar, em vez de mandar e esconder.
   *
   * As linhas continuavam rodando, guardadas por `if (el)`, e não faziam nada. Ficaram só o
   * tempo de alguém as ler e concluir que a regra morava aqui.
   *
   * O critério em si está preservado no comentário do menu.js, junto de onde ele decide.
   */

  /*
   * QUEM E A PESSOA -- dois atributos, e o componente desenha.
   *
   * Aqui havia trinta linhas montando o avatar, o nome, o papel e o botao de sair direto no
   * rodape da barra, com estilo escrito em atributo `style`. A Gestao tinha o equivalente em
   * React. Era o bloco onde a divergencia mais aparecia: esta escrevia `user.role` cru
   * ("user") e a de la escrevia "TITULAR", para a mesma pessoa na mesma sessao.
   *
   * O PAPEL NAO VAI DAQUI. Vem no menu (usuario.papel_rotulo), pelo mesmo construtor que
   * responde as duas portas -- e e por isso que ele parou de ser duas palavras. Ver
   * montarLugar/montarMenu em server/routes/menu.js.
   *
   * O nome vai, porque a sessao e deste lado e o componente nao busca nada.
   */
  const barra = document.querySelector('loop-sidebar');
  if (!barra) return;
  barra.setAttribute('nome', user.name || user.email || '');
  if (user.avatar_url) barra.setAttribute('avatar', user.avatar_url);
  else barra.removeAttribute('avatar');
}

// Soft-nudge banner for a logged-in but unverified local user (self-host path — hosted never
// issues a session while unverified, so this only appears there). Sits above #app so it persists
// across view swaps. Only shown when email_verified is explicitly 0 (undefined on stale caches
// stays hidden). Cleared automatically once the account verifies.
function updateVerifyBanner(user) {
  const existing = document.getElementById('verifyBanner');
  const unverified = user && user.email_verified === 0 && user.auth_provider === 'local';
  if (!unverified) { if (existing) existing.remove(); return; }
  if (existing) return;
  const bannersEl = document.getElementById('banners');
  if (!bannersEl) return;
  const b = document.createElement('div');
  b.id = 'verifyBanner';
  b.className = 'banner banner-warning';
  b.innerHTML = `<span>✉️ Confirme seu endereço de e-mail.</span>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.classList.add('btn-secondary');
  btn.textContent = 'Reenviar';
  btn.addEventListener('click', async () => {
    try { await api.resendVerification(user.email); showToast('Se esse endereço precisar de confirmação, enviamos um novo link.', 'success'); }
    catch { showToast('Não foi possível reenviar agora — tente de novo em instantes.', 'error'); }
  });
  b.appendChild(btn);
  bannersEl.appendChild(b);
}

function updateWidgetSandboxWarningBanner(user) {
  const existing = document.getElementById('widgetSandboxWarningBanner');
  const disabled = !!user?.current_organization?.widget_sandbox_isolation_disabled;
  if (!disabled) { if (existing) existing.remove(); return; }
  if (existing) return;
  const bannersEl = document.getElementById('banners');
  if (!bannersEl) return;
  const b = document.createElement('div');
  b.id = 'widgetSandboxWarningBanner';
  b.className = 'banner banner-danger';
  const text = document.createElement('span');
  text.style.whiteSpace = 'pre-line';
  text.textContent = 'O isolamento do sandbox de widgets está DESATIVADO. O código dos widgets desta\norganização roda com acesso total às sessões dos usuários. Reative em Administração > Segurança.';
  const link = document.createElement('a');
  // The switch that turns isolation back on moved to Administration with the rest of the
  // installation's controls; a banner pointing at Settings would send the reader somewhere the
  // toggle no longer is.
  link.href = '#/admin';
  link.textContent = 'Abrir Administração';
  b.appendChild(text);
  b.appendChild(link);
  bannersEl.appendChild(b);
}

// Initialize
renderNavLabels();

window.addEventListener('language-changed', () => {
  renderNavLabels();

});

if (isAuthenticated()) {
  connectSocket();
  wireFleetAlerts();
  refreshCurrentUser().then(() => updateSidebarUser());
}

// Refresh the cached user on every route transition so plan/role changes
// made by an admin propagate without requiring a re-login.
window.addEventListener('hashchange', () => { if (isAuthenticated()) refreshCurrentUser(); });

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw-admin.js').catch(() => {});
}

/*
 * A GAVETA NO CELULAR -- abrir/fechar pelo hamburguer, pelo fundo, ao navegar e com Esc.
 *
 * Passou a mexer no ATRIBUTO `aberta` do componente em vez da classe `.open` do <nav>: a
 * regra que move a barra vive dentro do Shadow DOM agora, onde uma classe posta de fora nao
 * chega. O comportamento e o mesmo, e continua sendo escrito num lugar so.
 */
const sidebarEl = document.querySelector('loop-sidebar');
const backdropEl = document.getElementById('sidebarBackdrop');
const menuBtn = document.getElementById('mobileMenuBtn');

function setMobileNav(open) {
  if (!sidebarEl || !backdropEl) return;
  sidebarEl.toggleAttribute('aberta', open);
  backdropEl.classList.toggle('open', open);
  menuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

menuBtn?.addEventListener('click', () => {
  setMobileNav(!sidebarEl.hasAttribute('aberta'));
});
backdropEl?.addEventListener('click', () => setMobileNav(false));
window.addEventListener('hashchange', () => setMobileNav(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl?.hasAttribute('aberta')) setMobileNav(false);
});

// Auto-reload on frontend update (no more hard refresh needed)
let knownHash = null;
/*
 * Kept as a named no-op so the version poll below reads the same as it always did.
 *
 * It used to paint a label in the sidebar footer. That footer is gone: a build number is support
 * information, read by someone answering a ticket rather than by someone running screens, and it
 * sat permanently in the rail for the one conversation a quarter where it matters. Settings shows
 * it now — and fetches it itself, rather than importing out of the module that routes the app.
 */
export function updateVersionIndicator() { /* the rail no longer displays it */ }

async function checkVersion() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (knownHash === null) { knownHash = data.hash; }
    else if (data.hash !== knownHash) {
      knownHash = data.hash;
      const toast = document.getElementById('toastContainer');
      if (toast) {
        const notice = document.createElement('div');
        notice.className = 'toast info';
        const span = document.createElement('span');
        span.textContent = 'Dashboard updated. ';
        const link = document.createElement('a');
        link.textContent = 'Reload now';
        link.href = '#';
        link.style.cssText = 'color:var(--accent-ink);text-decoration:underline;font-weight:600';
        // The dashboard CSP is `script-src 'self'` (no 'unsafe-inline'), which blocks
        // `javascript:` URIs — so the old `href="javascript:location.reload()"` link was dead
        // (click did nothing, only a CSP console warning). Use a real click listener, which
        // runs as first-party script and is CSP-clean.
        link.addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
        span.appendChild(link);
        notice.appendChild(span);
        toast.appendChild(notice);
      }
    }
    updateVersionIndicator(data);
  } catch {}
}
checkVersion(); // Fire first poll immediately
setInterval(checkVersion, 15000);

// Session timeout warning - check JWT expiry every minute
if (isAuthenticated()) {
  setInterval(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expiresIn = (payload.exp * 1000) - Date.now();
      const minutesLeft = Math.floor(expiresIn / 60000);
      if (minutesLeft <= 0) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.hash = '#/login';
        window.location.reload();
      } else if (minutesLeft <= 30 && minutesLeft % 10 === 0) {
        // Warn at 30, 20, 10 minutes
        const toast = document.getElementById('toastContainer');
        if (toast && !toast.querySelector('.session-warn')) {
          const warn = document.createElement('div');
          warn.className = 'toast info session-warn';
          warn.innerHTML = `<span>Session expires in ${minutesLeft} minutes. <a href="#/login" style="color:var(--accent-ink);text-decoration:underline" onclick="localStorage.removeItem('token');localStorage.removeItem('user')">Re-login</a></span>`;
          toast.appendChild(warn);
          setTimeout(() => warn.remove(), 10000);
        }
      }
    } catch {}
  }, 60000);
}

window.addEventListener('hashchange', route);
enableTouchLabels();
route();

// Close-modal buttons (replaces inline onclick handlers — required for CSP).
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (!closer) return;
  const id = closer.dataset.closeModal;
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
});

/*
 * A BARRA LATERAL, desenhada a partir do menu que o servidor manda.
 *
 * Ela era escrita a mao no index.html, e a Gestao mantinha a propria em React. Duas listas
 * concordam hoje e divergem no dia em que alguem mexe numa delas -- e a que diverge em
 * silencio e a que oferece ao cliente um modulo que ele nao comprou. GET /api/menu e a
 * unica definicao; aqui so se desenha.
 *
 * data-view CONTINUA SENDO POSTO. Duas coisas ja existentes dependem dele: o destaque do
 * item ativo e a traducao do rotulo. Sem ele, a barra perderia o destaque e voltaria a
 * mostrar "Displays" em vez de "Telas". O rotulo do servidor e a reserva de quem nao tem
 * chave de traducao -- os itens da Gestao.
 *
 * ATRAVESSAR PARA A GESTAO NAO E UM LINK. Um href direto levaria o navegador ate la SEM
 * sessao, e o login proprio da Gestao esta fechado: a pessoa cairia numa tela que recusa.
 * Entao o clique pede o token de troca de 60 segundos e leva o destino junto.
 *
 * O token vai no FRAGMENTO da URL: fragmento nao e enviado ao servidor, nao entra em log
 * de acesso e nao viaja no cabecalho Referer. A pagina de destino le e apaga na mesma hora.
 */
/*
 * OS ROTULOS TRADUZIDOS, para a barra nao regredir de sete idiomas para um.
 *
 * A barra passou a ser desenhada por <loop-sidebar>, que usa o rotulo que o servidor manda --
 * e o servidor manda em portugues. Aqui a Operacao entrega as traducoes que ja tem, e o
 * componente as prefere onde existirem.
 *
 * Nao e uma segunda lista de itens: e um mapa de PALAVRA, e so para os itens que ja tinham
 * traducao. Em pt-BR os dois textos sao identicos ('Telas' em i18n/pt.js e 'Telas',
 * que e exatamente o que routes/menu.js manda) -- conferido antes de escolher este caminho.
 * Ver a nota em `set rotulos` no componente.
 *
 * Os itens da Gestao (clientes, contratos, financeiro, assinaturas, mensagens) nao aparecem
 * aqui porque nunca tiveram traducao: ficam com o rotulo servido, como sempre ficaram.
 */
function rotulosTraduzidos() {
  const chaves = {
    telas: 'Telas',
    arquivos: 'Arquivos',
    playlists: 'Playlists',
    relatorios: 'Relatórios',
    layouts: 'Layouts',
    administracao: 'Administração',
    ajuda: 'Ajuda',
    configuracoes: 'Configurações',
  };
  const out = {};
  for (const id of Object.keys(chaves)) out[id] = (chaves[id]);
  return out;
}

/*
 * ALIMENTAR A BARRA.
 *
 * Isto e o que sobrou de renderNavFromMenu, e a diferenca e o ponto inteiro desta etapa: antes
 * esta funcao DESENHAVA a barra -- icones, secoes, separador, rodape -- e a Gestao desenhava a
 * dela em React. Agora ela so entrega o payload a <loop-sidebar>, o mesmo componente que a
 * Gestao monta, desta mesma origem.
 *
 * Sairam com ela: liDoItem, svgDoItem e ICONE_POR_ITEM. O traco vem carimbado no menu servido
 * (routes/menu.js), e um segundo mapa de icones aqui era a segunda lista que este trabalho veio
 * encerrar -- a mesma que fazia Telas, Arquivos, Playlists e Relatorios cairem todas no icone
 * de contrato do lado da Gestao.
 *
 * Quem busca continua sendo este lado, porque e quem tem a sessao. O componente nao busca nada.
 */
async function alimentarBarra() {
  const barra = document.querySelector('loop-sidebar');
  if (!barra || !isAuthenticated()) return;

  try {
    const r = await fetch('/api/menu', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    if (!r.ok) return;
    const menu = await r.json();
    barra.rotulos = rotulosTraduzidos();
    barra.menu = menu;
  } catch (e) {
    /*
     * Sem menu, a barra fica como esta -- sem itens, e sem inventar nenhum. Uma lista de
     * reserva escrita aqui seria a que oferece ao cliente um modulo que ele nao comprou.
     */
  }
}

/*
 * RECOLHER A BARRA passou a ser do componente.
 *
 * Estavam aqui a chave do localStorage, o aplicarRecolhida e o ouvinte do botao -- e havia um
 * conjunto equivalente do lado da Gestao, em app-shell.tsx. Dois codigos guardando o mesmo
 * estado sob a mesma chave e a definicao do problema desta etapa.
 *
 * A chave continua sendo `loop_os_sidebar_collapsed`, agora escrita num lugar so
 * (components/loop-sidebar.js). Ela carrega "loop_os" porque foi a Gestao que a criou;
 * renomea-la para combinar com o produto desrecolheria a barra de todos que ja a tem
 * recolhida, para consertar um nome que ninguem le.
 */

/*
 * O clique num item da Gestao. Delegado no documento porque a lista e reconstruida.
 */
/*
 * ATRAVESSAR PARA A GESTAO NAO E UM LINK, e por isso o componente nao pode simplesmente
 * seguir o href: o login proprio da Gestao esta fechado, entao o navegador chegaria la SEM
 * sessao e a pessoa cairia numa tela que recusa. O clique pede um token de troca de 60
 * segundos e leva o destino junto.
 *
 * O token vai no FRAGMENTO da URL: fragmento nao e enviado ao servidor, nao entra em log de
 * acesso e nao viaja no cabecalho Referer. A pagina de destino le e apaga na mesma hora.
 *
 * Vem do evento `navegar` do componente, e nao de um clique delegado no documento: o item
 * mora dentro do Shadow DOM, onde `closest('a[data-gestao-destino]')` nao alcanca. Chamar
 * preventDefault no evento e como este lado diz "eu assumo" -- ver a nota no componente.
 */
/*
 * A TRAVESSIA PARA A GESTAO SAIU DAQUI, e nao foi substituida por nada: virou um link.
 *
 * O que existiu neste ponto merece registro, porque custou tres rodadas. A travessia foi
 * extraida para js/atravessar.js e importada no topo -- mas a funcao antiga NAO saiu junto: o
 * script que a removeria falhou numa ancora e nao gravou, e eu segui achando que tinha
 * gravado. Ficaram o import e a declaracao no mesmo modulo. Em ES modules isso e SyntaxError,
 * o modulo inteiro nao carrega, e a tela vem em branco com o servidor respondendo tudo certo.
 *
 * `node --check` nao viu: sem "type": "module" ele le o arquivo como CommonJS, onde declarar
 * duas vezes e legal. Um "sintaxe OK" que media outra linguagem. Quem achou foi
 * scripts/provas/abrir.js, que abre a pagina num navegador de verdade.
 *
 * O js/atravessar.js tambem ja nao existe: com uma sessao so e a mesma origem, o href do menu
 * basta.
 */

/*
 * OS TRES FIOS ENTRE ESTE MODULO E A BARRA.
 *
 * Sao tres, e e proposital que sejam poucos: tudo o que passar por aqui e uma decisao que os
 * dois modulos podem tomar diferente, e portanto uma divergencia futura. Navegacao, sair, e
 * quem e a pessoa. O resto o componente resolve igual nos dois.
 */
function ligarBarra() {
  const barra = document.querySelector('loop-sidebar');
  if (!barra) return;

  barra.addEventListener('navegar', (e) => {
    const { id, href, modulo } = e.detail;

    /*
     * ITEM DA GESTAO: NAO FAZEMOS NADA, e isso e a mudanca.
     *
     * Aqui havia um desvio que segurava o clique, pedia um token de troca de 60 segundos e
     * montava um endereco com ele no fragmento da URL. Existia porque a Gestao tinha sessao
     * propria e o login dela estava fechado: um href direto levaria a pessoa a uma tela que
     * recusa.
     *
     * A sessao agora e uma so, e os dois modulos estao na mesma origem. O href do menu ja e o
     * endereco certo, e deixar o navegador segui-lo e tudo o que precisa acontecer -- com
     * clique do meio, nova aba e teclado funcionando de graca, o que a travessia nao dava.
     *
     * O componente foi construido esperando por isto: ele so segura o clique se alguem chamar
     * preventDefault. Ninguem chama mais.
     */

    /*
     * CLICAR NO LOGO JA ESTANDO NO INICIO RECARREGA OS NUMEROS.
     *
     * Sem isto o clique nao faz nada: escrever no hash o mesmo hash que ja esta la nao
     * dispara `hashchange`, entao a rota nao roda de novo. Correto e inutil ao mesmo tempo --
     * quem clica no logo na propria pagina do logo quer os numeros atualizados.
     *
     * ── ISTO MOROU FORA DAQUI, E QUASE SE PERDEU ──────────────────────────────────────────
     * Era um `getElementById("logoHome")?.addEventListener` no fim do arquivo. O `?.` fazia
     * dele um no-op silencioso desde que a barra virou componente: o logo passou a morar no
     * Shadow DOM, e `getElementById` nao alcanca la dentro.
     *
     * Quem acusou foi um teste que confere se todo id que o app.js procura existe na casca --
     * ele estava vermelho havia duas etapas, no meio de outros 24 vermelhos, e ninguem olhou.
     */
    if (id === 'inicio') {
      const naHome = location.hash === '#/' || location.hash === '#' || location.hash === '';
      if (naHome) {
        e.preventDefault();
        route();
        return;
      }
    }

    /*
     * Dentro da Operacao so o fragmento importa: escrever no hash mantem a navegacao do
     * proprio app, sem recarregar a pagina. Deixar o navegador seguir o href absoluto
     * recarregaria tudo a cada item da barra.
     */
    if (href && href.includes('#')) {
      e.preventDefault();
      window.location.hash = '#' + href.split('#')[1];
    }
  });

  barra.addEventListener('sair', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
  });
}

ligarBarra();

