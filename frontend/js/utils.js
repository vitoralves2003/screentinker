
// HTML escape helper — prevents XSS when inserting user data into innerHTML
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// v4 liveness badge. The patch4 server derives a 3-state liveness — 'healthy' / 'degraded'
// (temporarily reconnecting) / 'offline' — and emits it as `data.liveness` on dashboard:device-status.
// It is present on SOME emits only (the plain reconnect + disconnect emits, and any device object read
// from the DB, carry just the binary `status`), so we DEGRADE to the binary status when liveness is
// absent — nothing ever renders blank. 'provisioning' is a lifecycle state (never-paired), kept
// distinct from liveness. livenessState() is pure (unit-testable); livenessBadge() adds the i18n label.
/*
 * Four states, three of them decided by the clock. See server/lib/liveness for the thresholds
 * and for what was traded to make them time-based.
 *
 *   healthy  green   heard from within 5 minutes
 *   idle     amber   silent for 5, or reconnecting in a loop
 *   offline  red     silent for 10
 *   awaiting blue    answering fine, nothing assigned to play
 *
 * 'degraded' is still accepted below. Older servers emit it, and the day this ships every
 * dashboard open in a browser is still running the previous bundle — a device-status event
 * naming a state the map does not know would render a blank badge on a live screen.
 */
const LIVENESS_LABEL_KEY = {
  healthy: 'Saudável',
  idle: 'Ocioso',
  degraded: 'Ocioso',   // legacy name for the same amber state
  awaiting: 'Aguardando conteúdo',
  offline: 'Offline',
  provisioning: 'Aguardando pareamento',
};
export function livenessState(data) {
  const lv = data && data.liveness;
  if (lv === 'degraded') return 'idle';                                    // legacy name -> amber
  if (lv === 'healthy' || lv === 'idle' || lv === 'awaiting' || lv === 'offline') return lv;
  const st = data && data.status;                     // backward-compat: derive from binary status
  if (st === 'provisioning') return 'provisioning';
  if (st === 'online') return 'healthy';
  if (st === 'offline') return 'offline';
  return 'offline';                                   // unknown / no data yet -> safe default, never blank
}
// Exit-signal contract §8/§10 — honest, reliability-aware manner-of-death sub-label for an Offline
// device. clean_exit is RELIABLE only on the browser /player (pagehide+sendBeacon); best-effort on
// APK/.wgt, so we qualify it there rather than overstate certainty. crashed/silent are labeled plainly.
// Returns null when no reason is known (old data / never went offline) -> plain "Offline".
// short=true -> concise LIST label (drops the parenthetical qualifiers, which the tooltip still carries);
// full (default) -> DETAIL label with the reliability qualifier. Honesty is preserved either way: the
// full meaning lives in the tooltip (both views) and in the detail label.
function offlineReasonLabel(reason, clientType, short) {
  if (reason === 'crashed') return 'o app travou';
  if (reason === 'clean_exit') {
    if (short) return 'o app foi fechado';                         // list: "clean exit" (tooltip carries best-effort)
    return clientType === 'player' ? 'o app foi fechado' : 'o app foi fechado (provável)';
  }
  if (reason === 'silent') return short ? 'sem sinal' : 'sem sinal';
  /*
   * Not a manner of death — the panel is answering. The WebSocket service is up and the player
   * Activity is not, which is what a boot without the overlay permission produces: green badge,
   * black wall. Named plainly because the fix is a permission, not a site visit.
   */
  if (reason === 'not_playing') return 'o app não está em execução';
  return null;
}
// Honest hover explanation of the manner of death — carries the contract's reliability (esp. 'silent'
// = external/violent, and best-effort clean_exit) so an operator isn't misled by a terse badge label.
function offlineReasonTip(reason, clientType) {
  if (reason === 'not_playing') return 'O aparelho está conectado, mas o player não está rodando — normalmente após reiniciar sem a permissão "Exibir sobre outros apps". A tela está preta.';
  if (reason === 'crashed') return 'O tratador de erros do próprio app disparou — ele travou antes de encerrar (culpa nossa).';
  if (reason === 'clean_exit') return clientType === 'player' ? 'Um sinal de desligamento ordenado disparou — algo fechou o app corretamente.' : 'Reportou desligamento ordenado, mas nesta plataforma o sinal é de melhor esforço — provável, não garantido.';
  if (reason === 'silent') return 'Nenhum sinal de saída chegou — encerramento externo ou abrupto: queda de energia, queda de rede, forçar parada ou MDM. É a explicação honesta para o resto.';
  return '';
}
export function livenessBadge(data, opts = {}) {
  const state = livenessState(data);
  let label = (LIVENESS_LABEL_KEY[state]);
  let title = '', reason = '';
  const base = label;                            // the state on its own, before the reason is appended
  let sub = '';
  if (state === 'offline') {                      // annotate Offline with the manner of death, if known
    const r = data && data.offline_reason, ct = data && data.client_type;
    sub = offlineReasonLabel(r, ct, opts.short) || '';
    if (sub) { label += ' · ' + sub; title = offlineReasonTip(r, ct); reason = r || ''; }
  }
  // base and sub are handed back separately so a caller can put something BETWEEN them — the fleet
  // list reads "Offline há 12h · sem sinal", which it cannot build by splitting the joined label.
  return { state, label, base, sub, title, reason };  // reason -> data-offline-reason (filter drill-in); '' unless offline+known
}

// Phase 2.1: the Phase 1 schema migration renamed the legacy 'superadmin'
// role to 'platform_admin'. Existing frontend checks still match the old
// string; this helper accepts both so we don't have to splatter the array
// at every call site. Use everywhere the UI gates on platform-level access.
export function isPlatformAdmin(user) {
  return !!(user && (user.role === 'superadmin' || user.role === 'platform_admin'));
}

// Lazy-load authenticated images. A plain <img> can't send the Bearer token,
// and thumbnail/file endpoints require auth — a just-uploaded item's thumbnail
// 403's without it. We fetch with the token and swap in an object URL, revoked
// after load.
let _authImgObserver = null;
export function loadAuthImage(img) {
  const url = img.dataset.authSrc;
  if (!url) return;
  delete img.dataset.authSrc;
  fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
    .then(blob => {
      const obj = URL.createObjectURL(blob);
      img.addEventListener('load', () => URL.revokeObjectURL(obj), { once: true });
      img.src = obj;
    })
    .catch(() => { img.style.opacity = '0.25'; });
}
// Hydrate <img data-auth-src> under `root`. Lazy by default: an
// IntersectionObserver loads each thumbnail only as it scrolls into view, so a
// large grid (content library, etc.) doesn't fire a fetch per thumbnail on
// render. Pass { eager: true } for small, transient surfaces (pickers/modals)
// where every item is on screen and immediate load reads better.
export function hydrateAuthImages(root, { eager = false } = {}) {
  const imgs = root.querySelectorAll('img[data-auth-src]');
  if (!imgs.length) return;

  // Eager path (opt-in) and the no-IntersectionObserver fallback both load now.
  if (eager || typeof IntersectionObserver === 'undefined') {
    imgs.forEach(loadAuthImage);
    return;
  }

  if (!_authImgObserver) {
    _authImgObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) if (e.isIntersecting) { obs.unobserve(e.target); loadAuthImage(e.target); }
    }, { rootMargin: '300px' });
  }
  imgs.forEach(img => _authImgObserver.observe(img));
}
