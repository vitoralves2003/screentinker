import { api } from '../api.js';
import { showPrompt } from '../components/prompt-modal.js';
import { showScheduleEditor } from '../components/schedule-editor.js';
import { showDeviceOwnerQRModal } from '../components/device-owner-qr-modal.js';
import { on, off, requestScreenshot, startRemote, stopRemote, sendTouch, sendSwipe, sendKey, sendCommand } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc, livenessBadge, hydrateAuthImages, isPlatformAdmin } from '../utils.js';
import { frameDeviceOutput, displayAspectRatio } from '../lib/device-frame.js';

// Os eventos que o player relata.
const EVENTO = {
  'app_error': 'Erro no app',
  'crash': 'App travou',
  'display_off': 'Tela desligada / suspensa',
  'display_on': 'Tela ligada',
  'heartbeat_timeout': 'Parou de reportar',
  'network': 'Problema de rede',
  'no_internet': 'Sem internet (roteador/provedor)',
  'offline': 'Ficou offline',
  'online': 'Voltou a ficar online',
  'ping_timeout': 'Sem resposta (rede travada)',
  'reboot': 'Aparelho reiniciado',
  'server_down': 'Nosso servidor inacessível',
  'silent': 'Causa desconhecida',
  'transport_close': 'Conexão perdida',
  'transport_error': 'Erro de conexão',
  'upgrade': 'Atualizado',
};

// The player distinguishes three cases for the Wi-Fi name, because "--" was hiding a real
// answer: Android 8.1+ refuses to reveal the SSID to an app without location permission, and a
// customer reasonably read the blank as a bug in the player. "permission" means we are not
// allowed to know; empty means there is genuinely no Wi-Fi (an Ethernet panel).
/*
 * The brand colour, read from the theme at draw time.
 *
 * A canvas cannot take a var(), so this was a literal — and the literal was the fork's blue. Read
 * rather than hardcoded because it then follows a tenant's own branding, and because a mark drawn
 * over a screenshot has to stay visible whatever the interface around it does.
 */
function brandInk() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#20DF91';
}

function ssidLabel(ssid) {
  if (ssid === 'permission') return esc('Requer permissão de localização');
  if (!ssid) return '--';
  return esc(ssid);
}

// #238: turn the Now Playing screenshot the way the wall mount turns the panel. The placeholder
// ("no screenshot yet") is deliberately left alone — it is dashboard chrome, not device output.
// Set by the Capture button, cleared by the frame that answers it — see the click handler.
let awaitingCapture = false;

/*
 * The captured frame, over the page. Sized to the viewport rather than to a fixed box: a portrait
 * panel and a landscape one produce very different pictures, and letterboxing either into the
 * other's shape wastes the thing you opened it to look at.
 */
function showCaptureModal(src) {
  document.getElementById('captureModal')?.remove();
  const box = document.createElement('div');
  box.id = 'captureModal';
  box.className = 'modal-overlay';
  box.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:1200';
  box.innerHTML = `
    <div class="modal" style="max-width:min(92vw,1100px);width:auto">
      <div class="modal-header">
        <h3>${esc('Captura da tela')}</h3>
        <button class="btn-icon" data-capture-close aria-label="${esc('Fechar')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body" style="padding:0;background:#000;display:flex;align-items:center;justify-content:center">
        <img src="${esc(src)}" alt="" style="max-width:100%;max-height:72vh;display:block">
      </div>
      <div class="modal-footer">
        <span style="font-size:12px;color:var(--text-muted);margin-right:auto">${esc(new Date().toLocaleString())}</span>
        <button class="btn btn-secondary" data-capture-close>${esc('Fechar')}</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelectorAll('[data-capture-close]').forEach((b) => { b.onclick = close; });
  box.onclick = (e) => { if (e.target === box) close(); };
}

function frameNowPlaying() {
  const stage = document.getElementById('screenshotStage');
  const img = document.getElementById('currentScreenshot');
  if (stage && img && img.tagName === 'IMG') frameDeviceOutput(stage, img, currentDevice?.orientation);
}

let currentDevice = null;
let statusHandler = null;

let screenshotHandler = null;
/*
 * Whether this page holds changes that have not been written yet.
 *
 * Module-scoped rather than per-render because the beforeunload listener outlives a re-render,
 * and two listeners disagreeing about the same flag is worse than none.
 */
let deviceFormDirty = false;
function markDirty() {
  deviceFormDirty = true;
  const hint = document.getElementById('unsavedHint');
  if (hint) hint.style.display = '';
}
function clearDirty() {
  deviceFormDirty = false;
  const hint = document.getElementById('unsavedHint');
  if (hint) hint.style.display = 'none';
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!deviceFormDirty) return;
    e.preventDefault();
    e.returnValue = '';   // the browser shows its own wording; the value is ignored
  });
}
let logHandler = null;
let shellHandler = null;
let diagPollTimer = null; // polls a diag-smoothness widget's reported frame stats while the page is open
let screenshotInterval = null;
let remoteActive = false;
// Mirrors the Debug-logging checkbox so cleanup() can switch the device's stream back off.
// Without this, leaving the screen left the panel streaming into nothing: the device kept
// emitting, the dashboard kept relaying, and nobody was listening. The player carries its own
// auto-off as the backstop for the case this can't cover -- a tab that is killed, not closed.
let debugStreamOn = false;
let debugFrozen = false;
let debugHeld = [];              // lines that arrived while frozen, replayed on resume
const DEBUG_PANEL_MAX = 500;     // panel rows AND the held-while-frozen cap

// Every player sends a level and the panel used to render all four identically, so the one line
// that explains the fault sat in a wall of grey. Errors and warnings are why the operator opened it.
const DEBUG_LEVEL_COLOR = { e: '#f87171', w: '#fbbf24', d: '#64748b' };

function debugLineText(d) {
  return `${new Date(d.ts || Date.now()).toLocaleTimeString()} [${d.tag || ''}] ${d.message || ''}`;
}

function appendDebugLine(d) {
  const panel = document.getElementById('debugLogPanel');
  if (!panel) return;
  const line = document.createElement('div');
  line.textContent = debugLineText(d);                       // textContent — no HTML injection
  const tone = DEBUG_LEVEL_COLOR[(d.level || '').toLowerCase()];
  if (tone) line.style.color = tone;
  panel.appendChild(line);
  while (panel.childElementCount > DEBUG_PANEL_MAX) panel.removeChild(panel.firstChild);
  panel.scrollTop = panel.scrollHeight;
}

function updateDebugTools() {
  const btn = document.getElementById('debugFreezeBtn');
  const status = document.getElementById('debugLogStatus');
  if (btn) btn.textContent = debugFrozen ? 'Retomar' : 'Congelar';
  if (status) {
    // Say how many are waiting, so freezing never feels like the device went quiet.
    status.textContent = debugFrozen
      ? (debugHeld.length >= DEBUG_PANEL_MAX
          ? `congelado — ${debugHeld.length} aguardando (as mais antigas já estão sendo descartadas)`
          : `congelado — ${debugHeld.length} linha(s) nova(s) aguardando`)
      : '';
  }
}

function setDebugFrozen(frozen) {
  debugFrozen = frozen;
  if (!frozen) {
    const held = debugHeld;
    debugHeld = [];
    for (const d of held) appendDebugLine(d);   // resume shows what you missed, in order
  }
  updateDebugTools();
}

/*
 * Clipboard with a fallback, because a self-hosted dashboard on plain http is NOT a secure context
 * and `navigator.clipboard` is simply absent there — the copy buttons elsewhere in this app quietly
 * do nothing in that case. A debug log is precisely what a self-hoster wants to paste into an issue.
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// Belt for the orphaned-stream fix: if the tab is hidden/closed/backgrounded while a Remote session
// is live, stop it (the server also auto-stops on socket drop, but bfcache keeps the socket alive).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (remoteActive && currentDevice) { remoteActive = false; try { stopRemote(currentDevice.id); } catch (e) {} }
  });
}

// #161 device-owner Terminal presets. Commands chosen to work at the APP UID (not root) — getprop,
// /proc + /sys reads, df, pm list, ip. dumpsys/settings are deliberately avoided (OS-denied to apps).
const TERMINAL_PRESETS = [
  { label: 'Device info', cmd: 'getprop ro.product.manufacturer; getprop ro.product.model; echo "Android $(getprop ro.build.version.release) (sdk $(getprop ro.build.version.sdk))"' },
  { label: 'Build', cmd: 'getprop ro.build.fingerprint; echo "serial=$(getprop ro.serialno)"' },
  { label: 'Memory', cmd: 'head -3 /proc/meminfo' },
  { label: 'CPU', cmd: 'grep -iE "hardware|processor" /proc/cpuinfo | head; echo "cores=$(cat /proc/cpuinfo | grep -c ^processor)"' },
  { label: 'Storage', cmd: 'df -h /data 2>/dev/null; df -h /storage/emulated/0 2>/dev/null' },
  { label: 'Uptime', cmd: 'echo "up $(cut -d. -f1 /proc/uptime)s"' },
  { label: 'Date / TZ', cmd: 'date; echo "tz=$(getprop persist.sys.timezone)"' },
  { label: 'Display', cmd: 'getprop | grep -iE "lcd_density|ro.sf.lcd|ro.hwui|ro.surface_flinger" | head' },
  { label: '3rd-party apps', cmd: 'pm list packages -3 2>/dev/null | sed s/package:// | head -40 || echo "pm list denied at app uid"' },
  { label: 'Props', cmd: 'getprop | grep -iE "model|version.release|serialno|wifi.interface|timezone"' },
  { label: 'Whoami', cmd: 'id' },
];

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/*
 * The SSID line UNDER the signal strength. Empty when the panel cannot read the network name,
 * because "Requer permissão de localização" is an answer to a question nobody asked.
 */
/*
 * The tooltip. When the network name is readable it IS the tooltip; when it is not, the tooltip
 * explains why rather than repeating a placeholder the operator cannot act on.
 */
function wifiTitle(ssid) {
  const name = wifiSubLabel(ssid);
  return name || 'Requer permissão de localização';
}

function wifiSubLabel(ssid) {
  if (!ssid) return '';
  const s = String(ssid);
  if (s === '<unknown ssid>' || /permission/i.test(s) || /permiss/i.test(s)) return '';
  return s;
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// The device-clock renderer went with the card that displayed it. The skew check it did - device
// UTC against server receipt time - was a genuinely useful signal and is worth rebuilding as a
// warning ON the schedule editor, where a wrong clock actually costs something, rather than as a
// card nobody reads.

// A BrightSign runs the same web player, so client_type is 'player' and it would otherwise read as
// "Web Player" — indistinguishable from a browser tab on someone's desk. The player reports
// platform 'brightsign' (autorun.brs puts ?platform=brightsign on the URL); the user-agent check
// covers panels paired before that existed, which registered as "Chrome 120" with a BrightSign UA.
function isBrightSignDevice(device) {
  if (!device) return false;
  // platform only: `devices` has no user_agent column, so a fallback on it could never fire.
  return String(device.platform || '').toLowerCase().includes('brightsign');
}

// Mirrors platformFamily() in server/lib/player-capabilities.js — SAME FOUR SIGNALS, SAME ORDER,
// so the UI and the server never disagree about what a device is.
//
// The precedence is the whole point and is easy to get wrong. An earlier version of this helper
// kept only the last test, and a Tizen TV registers `android_version: 'Tizen 6.5'` (see
// tizen/js/app.js) — non-empty, not "Web/..." — so every Samsung panel in the fleet classified as
// Android. It was invisible only because Tizen happens to declare remote.screenshot today; the
// moment that changes, a MediaProjection button appears on a TV that has no such API.
//
// Gates the MediaProjection capture bootstrap below, and that gate is deliberately Android-and-
// nothing-else — NOT "Android that cannot already capture".
//
// The tempting extra condition is to hide it once a panel declares remote.screenshot. Two reasons
// not to. First, the dashboard cannot tell "this device declared it" from "the server filled in a
// baseline": /api/devices/:id ships capabilitiesFor(), which resolves both into one array (see
// server/routes/devices.js), and the android baseline CONTAINS remote.screenshot — so that
// condition hides the button from every one of the ~440 undeclared panels in the field, which is
// exactly backwards. Second, even where capture already works it is the accessibility path;
// MediaProjection is the better one (WebSocketService tries it FIRST), so offering the upgrade to
// a panel that has the weaker path is a feature, not redundancy.
function isAndroidDevice(device) {
  if (!device) return false;
  const platform = String(device.platform || '').toLowerCase();
  if (platform.includes('brightsign')) return false;
  if (platform.includes('tizen')) return false;
  // Second, independent signal for a Tizen TV: the .wgt player sends client_type 'wgt'. `platform`
  // is the primary key, but it lives in a column an older client's register could overwrite.
  if (device.client_type === 'wgt') return false;
  if (device.client_type === 'apk') return true;
  const av = String(device.android_version || '');
  return av !== '' && !av.startsWith('Web/');
}

export function render(container, deviceId) {
  container.innerHTML = `
    <div class="device-detail">
      <a href="#/" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
        Voltar para Telas
      </a>
      <div id="deviceContent">
        <div class="empty-state"><h3>Carregando...</h3></div>
      </div>
    </div>
  `;

  loadDevice(deviceId);

  // Real-time updates
  statusHandler = (data) => {
    if (data.device_id !== deviceId) return;
    // The state badge left this header — see the note where it used to be. The state is on the
    // fleet row you came from, and every diagnostic below says more than a one-word chip did.
    if (data.telemetry) updateTelemetryDisplay(data.telemetry);
  };

  screenshotHandler = (data) => {
    if (data.device_id !== deviceId) return;
    // Use inline base64 data if available, otherwise fall back to URL
    const imgSrc = data.image_data || (() => {
      const token = localStorage.getItem('token');
      return data.url + (data.url.includes('?') ? '&' : '?') + 'token=' + token;
    })();
    // Update screenshot in Now Playing tab
    const screenshotEl = document.getElementById('currentScreenshot');
    if (screenshotEl) {
      if (screenshotEl.tagName === 'IMG') {
        screenshotEl.src = imgSrc;
      } else {
        // Replace placeholder div with actual image
        const img = document.createElement('img');
        img.id = 'currentScreenshot';
        img.src = imgSrc;
        img.alt = 'Current screen';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain';
        screenshotEl.replaceWith(img);
      }
      // #238: a screenshot is the RAW framebuffer, so a portrait panel's arrives sideways — the
      // player rotated the content into it and only the wall mount turns it back. Re-frame on every
      // arrival, not just at render: the branch above swaps the element out from under us.
      if (awaitingCapture) {
        awaitingCapture = false;
        showCaptureModal(imgSrc);
      }
      frameNowPlaying();
    }
    // Update remote canvas
    const canvas = document.getElementById('remoteCanvas');
    if (canvas && remoteActive) {
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
      };
      img.src = imgSrc;
    }
  };

  /*
   * The now-playing line is gone. It printed data.current_content_id RAW, so a screen showing the
   * clock widget reported "Reproduzindo: a31d4418-0346-48ba-ac3f-0de908814b6b" — an id nobody can
   * read, in the most prominent position on the page.
   *
   * Removed rather than repaired because the two controls at the top answer the same question
   * better: Pré-visualização shows what the screen SHOULD be playing, Captura shows what it IS.
   * Between them there is nothing a name in text adds.
   *
   * ⚠️ The device LIST has a "Reproduzindo agora" column with the same underlying gap — it shows
   * "—" for every row. Fixing this here would not have fixed that; it is a separate job.
   */
  // (no handler: the now-playing line it fed is gone)

  // Live debug log lines streamed from the device (when the Debug logging
  // checkbox is on). Appended via textContent — no HTML injection.
  logHandler = (data) => {
    if (data.device_id !== deviceId) return;
    // Frozen: HOLD the line rather than drop it. A log you froze to read something is the exact
    // moment the lines that explain it are still arriving — pausing the stream would throw away
    // the part you were about to want.
    if (debugFrozen) {
      debugHeld.push(data);
      if (debugHeld.length > DEBUG_PANEL_MAX) debugHeld.shift();
      updateDebugTools();
      return;
    }
    appendDebugLine(data);
  };

  on('device-status', statusHandler);

  on('screenshot-ready', screenshotHandler);
  on('device-log', logHandler);
}

async function loadDevice(deviceId, activeTab = null) {
  const contentEl = document.getElementById('deviceContent');
  try {
    const device = await api.getDevice(deviceId);
    // Who is looking: the live-debug block below is platform-staff only.
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
    currentDevice = device;

    /*
     * Does this display support `cap`? Drives which controls render at all.
     *
     * Every control used to be offered to every display: a browser tab was shown "Reboot device",
     * a Tizen TV was shown screen power. They did nothing, silently, and read as bugs. Hidden
     * rather than disabled — a greyed-out button on a panel that will NEVER gain the capability is
     * a permanent question ("what do I have to do to enable this?") with no answer. The capability
     * list is shown in the Info tab so a missing control is explainable.
     *
     * The server resolves the baseline for the ~440 displays that declare nothing, so this sees a
     * populated list either way and never has to know the difference.
     */
    const caps = Array.isArray(device.capabilities) ? device.capabilities : null;
    const can = (cap) => (caps ? caps.includes(cap) : true);   // no list at all => pre-capability server, show everything

    const latestTelemetry = device.telemetry?.[0] || {};
    const diagWidget = (device.assignments || []).find(a => a && a.widget_type === 'diag-smoothness');

    contentEl.innerHTML = `
      <div class="device-header">
        <div class="device-header-left">
          <h1 id="deviceName" class="is-clickable" title="${esc('Renomear')}">${esc(device.name)}</h1>
          <!--
            The state badge and the owner are gone from this header.

            The badge said "Saudável" beside a screen you had already opened on purpose — and the
            fleet list, which is where you compare screens, carries the state as a coloured stripe
            per row. Repeating it here was the loudest thing on a page whose subject is settings.

            The owner is the same name on every screen of a single-tenant fleet.

            The state is not lost: it is still on the row you came from, and every diagnostic on
            this page says more than a one-word chip ever did.
          -->
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <!--
            BLOCK was removed from here, and only from here.

            It writes devices.blocked, which the socket refuses on the next register — but the
            refusal is keyed on device_id, fingerprint and token, and a factory reset changes all
            three. The panel comes back as a stranger and the block never reaches it, so as a
            security control it was theatre. The one honest use left, a panel reconnecting in a
            loop, is already handled without anyone pressing anything by lib/flap-limiter and
            lib/reconnect-throttle.

            The COLUMN and the socket check stay: routes/devices.js documents an outage procedure
            that sets it by hand, and a lever nobody can reach by accident costs nothing.
          -->
          <span style="width:1px;height:20px;background:var(--border);margin:0 2px"></span>
          <!-- Substituir tela: the screen stays, the hardware behind it changes. Offered only on
               a screen that has actually been paired - on an unclaimed row there is nothing to
               carry across and it would just be a confusing second way to pair. -->
          ${device.user_id ? `<button class="btn btn-secondary btn-sm" id="replaceDeviceBtn">Substituir tela</button>` : ''}
          <button class="btn btn-danger btn-sm" id="deleteDeviceBtn">Remover</button>
        </div>
      </div>

      ${/* tier===2 is kept alongside the capability: it is already an accurate RUNTIME signal from
            the panel, and a device-owner display that has not yet shipped a capability declaration
            would otherwise lose these buttons the day this deploys. */
        (device.tier === 2 || can('system.device_owner')) ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 0 4px" title="Controles privilegiados disponíveis porque este painel é o proprietário do dispositivo">
        <span style="font-size:12px;color:var(--text-muted)">Proprietário do dispositivo:</span>
        <button class="btn btn-secondary btn-sm" id="t2Reboot">Reiniciar</button>
        <button class="btn btn-secondary btn-sm" id="t2Lock">Bloquear tela</button>
        ${(device.tier === 2 || can('system.kiosk')) ? `
        <button class="btn btn-secondary btn-sm" id="t2KioskOn">Travar quiosque</button>
        <button class="btn btn-secondary btn-sm" id="t2KioskOff">Destravar quiosque</button>` : ''}
      </div>` : ''}

      ${device.tier === 2 ? `
      <div class="tabs">
        <div class="tab active" data-tab="terminal">Terminal</div>
      </div>` : ''}

      <div class="device-section" id="tab-screen">

        <!--
          LAYOUT FIRST, then content. The layout decides how many lists this page has to ask
          for, so asking for the list above it put the answer before the question — and on a
          two-zone layout the single Playlist field below is not merely redundant, it is a
          control the server ignores (buildPlaylistPayload composes from the zone map instead).
          renderZoneFields() hides it in that case rather than leaving a field that does nothing.
        -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <div style="flex:1">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Layout da tela</div>
            <select id="deviceLayoutSelect" class="input" style="background:var(--bg-input);padding:4px 8px;font-size:13px">
              <option value="">Tela cheia (padrão)</option>
            </select>
          </div>
        </div>

        <!-- One playlist field per zone. Empty for a fullscreen or single-zone layout, filled by
             renderZoneFields() below once the layout is known. This is the answer to the only
             question a multi-zone layout raises, and until now there was nowhere to answer it. -->
        <div id="zonePlaylists"></div>

        <!--
          Which list this screen runs is a property of the SCREEN, so choosing it belongs here.
          What is IN the list is a property of the list, and had a full second editor on this page —
          drag, mute, delete — for the same rows the Playlists page already edits. One editor now,
          one click away.
        -->
        <div id="fullscreenPlaylistRow" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <h3 style="font-size:15px;margin:0">Playlist</h3>
          <select class="input" id="playlistPicker" style="font-size:13px;padding:5px 8px;width:220px">
            <option value="">Sem playlist</option>
          </select>
          ${device.playlist_id ? `<a class="btn btn-secondary btn-sm" href="#/playlists/${esc(device.playlist_id)}">Editar esta lista</a>` : ''}
          <button class="btn btn-secondary btn-sm" id="copyPlaylistBtn" style="margin-left:auto">Copiar para...</button>
        </div>
      </div>

      <!-- Settings Tab -->
      <div class="device-section" id="tab-settings">
        <!-- The device-owner provisioning QR was removed with the decision to ship auto start and
             not kiosk. Enrolling a device owner needs a factory-reset panel and a USB cable, so a
             button that opens a QR nobody can act on from the dashboard was an invitation to a
             dead end. The provisioning code itself is untouched. -->

        <div style="margin-top:20px">
          <div style="display:flex;gap:12px;margin-bottom:12px">
            <div class="form-group" style="flex:1;margin:0">
              <label>Orientação / Rotação</label>
              <select id="deviceOrientation" class="input" style="background:var(--bg-input)">
                <option value="landscape" ${'landscape' === (device.orientation || 'landscape') ? 'selected' : ''}>Paisagem (0°)</option>
                <option value="portrait" ${'portrait' === device.orientation ? 'selected' : ''}>Retrato (90° SH)</option>
                <option value="landscape-flipped" ${'landscape-flipped' === device.orientation ? 'selected' : ''}>Paisagem invertida (180°)</option>
                <option value="portrait-flipped" ${'portrait-flipped' === device.orientation ? 'selected' : ''}>Retrato invertido (270° SH)</option>
              </select>
            </div>
            <div hidden class="form-group" style="flex:1;margin:0">
              <label>Conteúdo padrão</label>
              <select id="deviceDefaultContent" class="input" style="background:var(--bg-input)">
                <option value="">${'Nenhum (mostrar "Aguardando...")'}</option>
              </select>
            </div>
          </div>
          <div hidden class="form-group">
            <label>Notas</label>
            <textarea id="deviceNotes" class="input" rows="3" placeholder="Localização, detalhes de instalação, etc." style="resize:vertical">${esc(device.notes || '')}</textarea>
          </div>
          <!--
            WHO UPDATES THIS PANEL — staff only, and the same lesson as live debug above.

            This block carried a bare hidden attribute with nothing anywhere able to remove it, so
            the pre-release checkbox existed and could not be reached. A beta build was published,
            the panel was told to check, and the server correctly answered "up to date" because the
            one flag that would have changed the answer had no control on any screen. Both symptoms
            — no new version offered, and "Forçar atualização" appearing to do nothing — were that.

            It is gated rather than simply un-hidden because choosing an update channel is an
            OPERATOR decision, not a shopkeeper's: a tenant who ticks pre-release puts their own
            shop window on an untested build, and would have no way to know that is what they did.
          -->
          <div ${isPlatformAdmin(currentUser) ? '' : 'hidden'} style="margin:12px 0">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="otaToggle" ${device.ota_enabled === 0 ? '' : 'checked'}> Atualização automática (OTA)
            </label>
            <div style="font-size:11px;color:var(--text-muted);margin:4px 0 0 24px">Quando desligado, esta tela nunca recebe atualização — um MDM ou operador controla as atualizações dela. Desligue em painéis gerenciados por MDM (ex.: Pivot/MAXHUB) para o app nunca mostrar a caixa de instalação.</div>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-top:8px">
                <input type="checkbox" id="otaBetaToggle" ${device.ota_beta === 1 ? 'checked' : ''}> Aceitar versões de pré-lançamento
              </label>
              <div style="font-size:11px;color:var(--text-muted);margin:4px 0 0 24px">Coloca esta tela no canal de pré-lançamento: ela recebe a versão beta se o servidor tiver uma publicada, e mantém a versão de teste em vez de voltar para a versão atual. Desmarque para trazê-la de volta à versão estável. Não faz nada se não houver beta publicada.</div>
          </div>
          <div hidden class="form-group" style="max-width:280px">
            <label>Reinício noturno</label>
            <input type="time" id="rebootSchedule" class="input" style="background:var(--bg-input)" value="${esc(device.reboot_schedule || '')}">
            <div style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">Reinicia este painel uma vez por dia neste horário local do aparelho (deixe em branco para desligar). Um reinício noturno limpo libera memória e ressincroniza o relógio. Silencioso em painéis proprietários; não faz nada em painéis que não conseguem se reiniciar.</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="reAdoptBtn" hidden style="margin-left:8px" title="Aplica as configurações salvas de uma tela removida anteriormente nesta (para uma tela repareada cuja identificação mudou)">Restaurar de uma tela removida…</button>
        </div>

        <!--
          LIVE DEBUG. Hidden from a subscriber, shown to platform staff.

          It streams the player's own log off the panel over its socket — which is the only way to
          find out why a screen on a wall is not drawing what it was sent, short of a cable and a
          trip. The whole block used to carry a bare hidden attribute, with nothing anywhere able to remove
          it, so the feature existed and could not be reached: an entire investigation into a widget
          stuck on "carregando" ran without it, because the instruction "turn on live debug" pointed
          at a control that was not on the page.

          It is not for a shopkeeper — it is our internals, in English, at speed — hence the role
          gate rather than simply un-hiding it.
        -->
        <div ${isPlatformAdmin(currentUser) ? '' : 'hidden'} style="margin-top:20px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="debugLogToggle"> Log de depuração (ao vivo)
          </label>
          <div style="font-size:11px;color:var(--text-muted);margin:4px 0 0 24px">Transmite o log desta tela em tempo real e reexibe o que ficou armazenado antes de você abrir. Desliga quando você sai desta tela, e no próprio aparelho após 30 minutos.</div>
          <!-- Freeze holds the view still WITHOUT dropping what arrives: a log you are reading
               scrolls the interesting line off the top, and pausing the stream instead would lose
               exactly the lines that follow the fault. Copy exists because the useful next step is
               pasting this into an issue. -->
          <div id="debugLogTools" style="display:none;margin-top:8px;gap:6px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" id="debugFreezeBtn">Congelar</button>
            <button class="btn btn-secondary btn-sm" id="debugCopyBtn">Copiar</button>
            <button class="btn btn-secondary btn-sm" id="debugClearBtn">Limpar</button>
            <span id="debugLogStatus" style="font-size:11px;color:var(--text-muted)"></span>
          </div>
          <div id="debugLogPanel" style="display:none;margin-top:8px;background:var(--console-bg);border:1px solid var(--border);border-radius:6px;padding:8px;height:220px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.45;color:var(--console-text)"></div>
        </div>

        <!-- #109: PiP overlay tester. Pushes device:pip-show/clear via POST /api/pip
             (real triggers are external via the API token; this is for testing). -->
        <div hidden style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
          <div style="font-weight:600;margin-bottom:8px" hidden>Overlay (PiP) — test</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select id="pipType" class="btn btn-secondary btn-sm" style="min-width:90px">
              <option value="image">image</option>
              <option value="web">web</option>
            </select>
            <input id="pipUri" type="url" placeholder="https://… (image or page URL)" style="flex:1;min-width:240px;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
            <select id="pipPosition" class="btn btn-secondary btn-sm" style="min-width:120px">
              <option value="top-right">top-right</option>
              <option value="top-left">top-left</option>
              <option value="bottom-right">bottom-right</option>
              <option value="bottom-left">bottom-left</option>
              <option value="center">center</option>
            </select>
            <input id="pipDuration" type="number" min="0" value="30" title="seconds (0 = until cleared)" style="width:90px;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
            <button class="btn btn-primary btn-sm" id="sendPipBtn">Send overlay</button>
            <button class="btn btn-secondary btn-sm" id="clearPipBtn">Clear overlay</button>
          </div>
        </div>
        ${device.playlist_status === 'draft' ? `
        <div id="deviceDraftBanner" style="background:var(--warning-dim);border:1px solid var(--warning);border-radius:var(--radius);padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div style="display:flex;align-items:center;gap:10px;color:var(--warning)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <div style="font-weight:600;font-size:14px">Alterações não publicadas</div>
              <div style="font-size:12px;color:var(--warning);opacity:0.8">${device.playlist_has_published ? 'Os dispositivos ainda exibem a última versão publicada.' : 'Esta playlist nunca foi publicada. Os dispositivos não exibirão nada até você publicar.'}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0">
            ${device.playlist_has_published ? `<button class="btn btn-secondary btn-sm" id="deviceDiscardDraftBtn" style="color:var(--warning);border-color:var(--warning)">Descartar</button>` : ''}
            <button class="btn btn-sm" id="devicePublishBtn" style="background:var(--warning);color:#fff;font-weight:600;border:none">Publicar</button>
          </div>
        </div>
        ` : ''}
      </div>

      <!-- Diagnostics Tab -->
      <div class="device-section" id="tab-diagnostics">
        ${diagWidget ? renderDiagPanel(diagWidget) : ''}

        <!-- The actions an operator opens this page to take. They used to sit below the info
             grid, the reboot schedule and the debug log panel, which on a phone meant scrolling
             past everything to reach the one button you came for. Kept as a single wrapping row
             so a narrow screen reflows rather than clipping, and each button still renders only
             where the display can honour it. -->
        <div style="margin:20px 0;display:flex;gap:8px;flex-wrap:wrap">
          ${can('system.reboot') ? `
          <button class="btn btn-secondary btn-sm" id="rebootBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Reiniciar dispositivo
          </button>` : ''}
          ${can('display.power') ? `
          <button class="btn btn-secondary btn-sm" id="screenOffBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            Desligar tela
          </button>` : ''}
          ${can('display.power') ? `
          <button class="btn btn-secondary btn-sm" id="screenOnBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            Ligar tela
          </button>` : ''}
          <button class="btn btn-secondary btn-sm" id="devicePreviewBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            Pré-visualização
          </button>
          ${can('remote.screenshot') ? `
          <button class="btn btn-secondary btn-sm" id="screenshotBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            Captura
          </button>` : ''}
          ${can('system.restart_player') ? `
          <button class="btn btn-secondary btn-sm" id="launchAppBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Reiniciar aplicativo
          </button>` : ''}
          <button class="btn btn-secondary btn-sm" id="forceUpdateBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Forçar atualização
          </button>
          <!-- Clearing the staged APK cache left the dashboard: it is the escape hatch for a panel
               holding a download that cannot install, which is a support call once a year, not an
               operator control. The command still exists and is still reachable through the API. -->
          ${can('system.reboot') ? `
          <button class="btn btn-danger btn-sm" id="shutdownBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
            Desligar
          </button>` : ''}
        </div>

        <div hidden class="screenshot-container" id="screenshotStage">
          ${false && device.screenshot
            ? `<img id="currentScreenshot" src="/api/devices/${device.id}/screenshot?t=${Date.now()}&token=${localStorage.getItem('token')}" alt="Current screen">`
            : `<div class="no-screenshot" id="currentScreenshot">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <!-- The default copy tells the operator to click a button that is only rendered
                     for a panel that can capture. On one that cannot, pointing at a control that
                     is not on the page reads as a broken dashboard. -->
                <span>${can('remote.screenshot') ? 'Sem captura disponível. Clique em "Captura" para tirar uma.' : 'Este player não consegue capturar a própria tela.'}</span>
              </div>`
          }
        </div>

        <div class="info-grid">
          <div class="info-card" hidden>
            <div class="info-card-label">Status</div>
            <div class="info-card-value" style="color:var(--${device.status === 'online' ? 'success' : 'danger'})">${device.status}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">Endereço IP</div>
            <div class="info-card-value small">${device.ip_address || '--'}</div>
          </div>
          <div class="info-card" hidden>
            <!-- Two different addresses, and conflating them confused a customer into reading their
                 ISP's address as the screen's. Above is where the connection comes FROM (public);
                 this is what the screen calls itself on its own network. -->
            <div class="info-card-label">IP local</div>
            <div class="info-card-value small" id="telLocalIp">${device.local_ip || '--'}</div>
          </div>
          ${device.local_ip6 ? `
          <div class="info-card" hidden>
            <!-- Rendered only when the panel actually has one. A v6 address is long, and showing an
                 empty row for the overwhelmingly v4 fleet would cost every operator screen space to
                 tell them nothing. A dual-stack panel shows both cards; a v6-only panel used to
                 show a dash here and nothing else, because the player only ever collected v4. -->
            <div class="info-card-label">IPv6 local</div>
            <div class="info-card-value small" id="telLocalIp6">${device.local_ip6}</div>
          </div>` : ''}
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div hidden class="info-card">
            <div class="info-card-label">Bateria</div>
            <div class="info-card-value" id="telBattery">${latestTelemetry.battery_level != null ? latestTelemetry.battery_level + '%' : '--'}</div>
            ${latestTelemetry.battery_level != null ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${latestTelemetry.battery_level > 50 ? 'success' : latestTelemetry.battery_level > 20 ? 'warning' : 'danger'}"
                   style="width:${latestTelemetry.battery_level}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">Armazenamento</div>
            <div class="info-card-value small" id="telStorage">${latestTelemetry.storage_free_mb ? `${formatBytes(latestTelemetry.storage_free_mb)} livres` : '--'}</div>
            ${latestTelemetry.storage_total_mb ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb) < 0.8 ? 'success' : 'warning'}"
                   style="width:${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb * 100)}%"></div>
            </div>` : ''}
          </div>
          ` : `
          <div class="info-card">
            <div class="info-card-label">Tipo de player</div>
            <div class="info-card-value small">${isBrightSignDevice(device) ? 'BrightSign' : 'Player web'}</div>
          </div>
          ${device.hardware_model ? `
          <div class="info-card">
            <div class="info-card-label">Modelo</div>
            <div class="info-card-value small">${esc(device.hardware_model)}${device.output_index > 1 ? ` <span style="color:var(--text-muted)">${`(saída ${device.output_index})`}</span>` : ''}</div>
          </div>` : ''}
          ${device.hardware_os_version ? `
          <div class="info-card">
            <div class="info-card-label">Versão do sistema</div>
            <div class="info-card-value small">${esc(device.hardware_os_version)}</div>
          </div>` : ''}
          ${device.hardware_serial ? `
          <div class="info-card">
            <div class="info-card-label">Número de série</div>
            <div class="info-card-value small">${esc(device.hardware_serial)}</div>
          </div>` : ''}
          ${latestTelemetry.storage_total_mb ? `
          <div class="info-card">
            <!-- This used to be labelled "player storage" because the number WAS the widget's
                 cache quota rather than the disk — a real XT245 with a 119 GB NVMe reported
                 "1026 MB", and the label was the only thing stopping that being read as the disk
                 size. The bridge now reads the actual filesystem (statfs over the mounts under
                 /storage, largest wins), so it means the same thing as Android's figure and is
                 labelled the same. ⚠️ The bridge is served per page load, so a player that has not
                 re-fetched it yet still reports the quota — see the CDN caching note in
                 docs/player-parity.md before trusting a suspiciously round ~1 GB here. -->
            <div class="info-card-label">Armazenamento</div>
            <div class="info-card-value small" id="telStorage">${latestTelemetry.storage_free_mb != null ? `${formatBytes(latestTelemetry.storage_free_mb)} livres` : '--'}</div>
            <div class="progress-bar">
              <div class="progress-bar-fill ${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb) < 0.8 ? 'success' : 'warning'}"
                   style="width:${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb * 100)}%"></div>
            </div>
          </div>` : ''}
          `}
          ${latestTelemetry.temperature_c != null ? `
          <div class="info-card">
            <div class="info-card-label">Temperatura</div>
            <div class="info-card-value small" id="telTemp">${latestTelemetry.temperature_c}&deg;C</div>
          </div>` : ''}
          <!-- The physical panel, from its EDID, and the mode the output is negotiated to. Shown
               only when the player reports them, like every other card here: a family that cannot
               read its own output must not grow an empty row. On a dual-output player each device
               row is one output, so this is THAT output's screen — not the box's first. -->
          ${latestTelemetry.attached_display ? `
          <div class="info-card">
            <div class="info-card-label">Monitor conectado</div>
            <div class="info-card-value small" id="telDisplay">${esc(latestTelemetry.attached_display)}</div>
          </div>` : ''}
          ${latestTelemetry.video_mode ? `
          <div class="info-card">
            <div class="info-card-label">Modo de vídeo</div>
            <div class="info-card-value small" id="telVideoMode">${esc(latestTelemetry.video_mode)}</div>
          </div>` : ''}
          <!--
            The Wi-Fi card is gone, and so is the Android-only branch that wrapped it. "-66 dBm"
            tells an operator nothing, and the one moment it matters — a screen that drops every
            afternoon — is a support investigation, not a glance. The value is STILL REPORTED and
            still reaches the live debug log, which is where that hunt starts.
          -->
          <div class="info-card" hidden>
            <div class="info-card-label">Tempo ativo</div>
            <div class="info-card-value small" id="telUptime">${formatUptime(latestTelemetry.uptime_seconds)}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card" hidden>
            <div class="info-card-label">Versão do Android</div>
            <div class="info-card-value small">${device.android_version}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">Versão do app</div>
            <div class="info-card-value small">${device.app_version || '--'}</div>
          </div>
          <div hidden class="info-card">
            <div class="info-card-label">PIN de configurações</div>
            <div class="info-card-value small" style="font-family:monospace;letter-spacing:1px">${device.settings_pin || '--'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Menu de configurações no dispositivo (2× Voltar)</div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button class="btn btn-secondary btn-sm" id="rotatePinBtn">Trocar</button>
              <button class="btn btn-secondary btn-sm" id="setPinBtn">Definir…</button>
            </div>
          </div>
          ` : ''}
          <div class="info-card">
            <div class="info-card-label">Resolução</div>
            <div class="info-card-value small">${device.screen_width && device.screen_height
              ? device.screen_width + 'x' + device.screen_height +
                // #134: show the UI render surface alongside the HDMI output when they differ
                // (TV boxes that render at 720p and upscale to a 1080p signal).
                (device.render_width && device.render_height &&
                 (device.render_width !== device.screen_width || device.render_height !== device.screen_height)
                  ? ` (UI ${device.render_width}x${device.render_height})` : '')
              : '--'}</div>
          </div>
          <!-- The device clock card was removed: the panel's reported timezone and time are
               diagnostics, not settings, and an operator has no decision to make from them.
               The COLUMNS stay - schedule evaluation resolves its zone from exactly those
               fields (lib/device-timezone), so deleting them would silently move every timed
               block to the server's zone. -->
          <!-- Shown for Android as before, and now for ANY player that actually reports the value.
               These were platform-gated when Android was the only family that could measure them;
               a BrightSign widget runs with nodejs_enabled and the bridge reads os.totalmem/freemem
               and the load average, so the numbers exist and were being thrown away by a gate that
               asked what the device IS instead of what it SENT. Keeping the Android arm means a
               panel that reports nothing still shows "--" there rather than losing its cards. -->
          ${(device.android_version && !device.android_version.startsWith('Web/')) || latestTelemetry.ram_free_mb != null ? `
          <div class="info-card" hidden>
            <div class="info-card-label">RAM</div>
            <div class="info-card-value small" id="telRam">${latestTelemetry.ram_free_mb ? `${formatBytes(latestTelemetry.ram_free_mb)} livres` : '--'}</div>
          </div>` : ''}
          ${(device.android_version && !device.android_version.startsWith('Web/')) || latestTelemetry.cpu_usage != null ? `
          <div class="info-card" hidden>
            <div class="info-card-label">Uso de CPU</div>
            <div class="info-card-value small" id="telCpu">${latestTelemetry.cpu_usage != null ? latestTelemetry.cpu_usage.toFixed(1) + '%' : '--'}</div>
          </div>
          ` : ''}
        </div>

        <!-- What this display can do.
             Controls are now hidden when the player cannot honour them, which on its own looks
             like the dashboard has lost features. This is the answer to "where did the reboot
             button go" — it names the exact set the panel reported, and says plainly when the set
             is a per-platform assumption rather than something the player actually declared. -->
        <div style="margin-top:20px" hidden>
          <h4 style="font-size:13px;margin-bottom:8px">Recursos do player</h4>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
            ${caps ? 'Reportado pelo próprio player. Controles que esta tela não consegue executar ficam ocultos.' : 'Este player ainda não reportou seus recursos, então assumimos os padrões da plataforma dele. Serão atualizados na próxima conexão.'}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${(device.capabilities || []).map(c => `<span style="font-family:monospace;font-size:11px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:2px 6px">${esc(c)}</span>`).join('')
              || `<span style="font-size:12px;color:var(--danger)">O player informa que não consegue executar nada.</span>`}
          </div>
        </div>

        <!-- Uptime Timeline (24h) -->
        <div hidden style="margin-top:20px">
          <h4 style="font-size:13px;margin-bottom:8px">Linha do tempo (últimas 24 horas)</h4>
          <div id="uptimeTimeline" style="display:flex;height:32px;border-radius:4px;overflow:hidden;border:1px solid var(--border);background:var(--bg-primary)"></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="font-size:10px;color:var(--text-muted)">há 24h</span>
            <span style="font-size:10px;color:var(--text-muted)">Agora</span>
          </div>
          <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--success);border-radius:2px;vertical-align:-1px"></span> Online</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--danger);border-radius:2px;vertical-align:-1px"></span> Offline</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:2px;vertical-align:-1px"></span> Sem dados</span>
            <span id="uptimePercent" style="margin-left:auto;font-weight:600"></span>
          </div>
        </div>

        <!-- Recent incidents (device diagnostics / offline-cause log) -->
        <div hidden style="margin-top:20px">
          <h4 style="font-size:13px;margin-bottom:8px">Ocorrências recentes</h4>
          <div id="incidentsPanel"></div>
        </div>

        ${(can('remote.stream') || can('remote.input') || can('remote.screenshot')) ? `
        <div hidden style="margin-top:24px">
          <h4 style="font-size:13px;margin-bottom:8px">Controle remoto</h4>
        <div class="remote-container">
          ${can('remote.stream') ? `
          <div class="remote-screen" id="remoteScreen">
            <!-- Deliberately NOT rotated with the rest of the previews (#238). This is a control
                 surface: taps and swipes are sent as fractions of THIS canvas, which is the raw
                 framebuffer the device replays them into, and it also shows the Android system UI —
                 which really is landscape on a portrait-hung panel. Turning the picture without
                 inverting the touch mapping would send every tap to the wrong place. -->
            <canvas id="remoteCanvas" width="960" height="540" style="background:#000;width:100%"></canvas>
            <div class="no-screenshot" id="remoteOverlay" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
              <div style="text-align:center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <p style="color:var(--text-secondary)">${'Clique em "Iniciar controle remoto" para começar'}</p>
              </div>
            </div>
          </div>` : ''}
          <div class="remote-controls">
            ${can('remote.stream') ? `
            <button class="btn btn-primary" id="startRemoteBtn">Iniciar controle remoto</button>
            <button class="btn btn-secondary" id="stopRemoteBtn" style="display:none">Parar controle remoto</button>
            <hr style="border-color:var(--border);margin:8px 0">` : ''}
            ${can('remote.input') ? `
            <!-- Key pad -->
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_UP')">Vol +</button>
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_DOWN')">Vol -</button>
            <hr style="border-color:var(--border);margin:8px 0">
            <!-- System View controls — auto-unlocked on a device owner (#161: full-screen via the
                 accessibility path, no MediaProjection consent); locked until enabled otherwise. -->
            <div id="systemViewControls" style="opacity:${device.tier === 2 ? '1' : '0.4'};pointer-events:${device.tier === 2 ? 'auto' : 'none'}">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_HOME')">Início</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_BACK')">Voltar</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_APP_SWITCH')">Recentes</button>
              <button class="btn btn-danger btn-sm" onclick="window._sendKey('KEYCODE_POWER')">Energia</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_UP')">&#9650;</button>
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_LEFT')">&#9664;</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_RIGHT')">&#9654;</button>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_DOWN')">&#9660;</button>
              <button class="btn btn-primary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_CENTER')">OK</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendCmd('settings')">Configurações</button>
              ${can('display.power') ? `
              <hr style="border-color:var(--border);margin:8px 0">
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_off')">Tela off</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_on')">Tela on</button>
              </div>` : ''}
            </div>` : ''}
            ${device.tier === 2 ? `
            <span style="font-size:10px;color:var(--success);line-height:1.2;display:block;margin-top:8px">Visão do sistema ativada automaticamente (proprietário do dispositivo) — tela cheia, sem precisar de aprovação</span>
            ` : `
            ${isAndroidDevice(device) ? `
            <button class="btn btn-primary btn-sm" id="enableSystemCaptureBtn" onclick="window._enableSystemView()" title="Solicita ao usuário do dispositivo permitir captura de tela cheia - habilita visualização remota da tela inicial, configurações e outros apps" style="margin-top:8px">
              Ativar visão do sistema
            </button>
            <span id="systemViewHint" style="font-size:10px;color:var(--text-muted);line-height:1.2;display:block;margin-top:4px">Aprovação única necessária no dispositivo</span>` : ''}`}
          </div>
        </div>
        </div>` : ''}

        <!-- The sliders are gone, and what replaced them is one switch.

             Volume asked the wrong question: the LEVEL belongs to whoever holds the TV remote,
             and setting it from here fights them. Whether the screen may speak AT ALL is the
             business decision - a waiting room cannot, an electronics shop must - and that is
             what an operator actually needs from a dashboard.

             Brightness went for a harder reason: system brightness rode on WRITE_SETTINGS,
             which the store build no longer requests, so on a Play-installed panel it was a
             control that could not work. And TV brightness is a property of the television,
             not of the sign. -->
        <!--
          AUTOSTART WARNING, shown only where it is true.

          After a power cut the boot receiver starts the WebSocket service — which is why the
          screen reports itself healthy — and then tries to open the player. On Android 10 a
          background receiver cannot start an Activity, so that second step needs "display over
          other apps". Without it the service connects, the dashboard shows green, and the wall
          stays black until somebody walks up to the panel.

          The panel already tells us: DeviceInfo reports overlay_granted on every heartbeat and
          the socket stores it. So this is not a standing notice that everyone learns to skim —
          it appears on the screens where the permission is actually off, and nowhere else.
        -->
        ${isAndroidDevice(device) && Number(device.overlay_granted) === 0 ? `
        <div style="margin:16px 0;padding:12px 14px;border:1px solid var(--warning);border-radius:var(--radius);background:color-mix(in srgb, var(--warning) 8%, transparent)">
          <div style="font-size:13px;font-weight:600;color:var(--warning)">${esc('O auto start não vai funcionar nesta tela')}</div>
          <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0;line-height:1.5">${esc('Depois de uma queda de energia o serviço volta sozinho — por isso a tela aparece online — mas o player não abre. Ative "Exibir sobre outros apps" no aparelho para que ele volte a exibir conteúdo sozinho.')}</p>
          <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">${esc('No aparelho: Configurações → Apps → Loop Player → Exibir sobre outros apps')}</p>
        </div>` : ''}

        <!-- Operating hours. Not a schedule for the CONTENT — the screen plays whatever its list
             says, whenever. This is when the PLACE is open, and it exists so an alert can tell a
             broken screen from a shut shop. -->
        <div style="margin-top:24px">
          <h4 style="font-size:13px;margin-bottom:8px">Horário de funcionamento</h4>
          <div style="display:flex;gap:8px;align-items:center">
            <button type="button" class="btn btn-secondary btn-sm" id="deviceHoursBtn">Definir horário</button>
            <span id="deviceHoursSummary" style="font-size:12px;color:var(--text-muted)"></span>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px;max-width:520px">Quando o local está aberto. Não muda o que a tela exibe — serve para o painel saber se uma tela offline é defeito ou o estabelecimento fechado.</p>
        </div>

        <div style="margin-top:24px">
          <h4 style="font-size:13px;margin-bottom:8px">Som</h4>
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;cursor:pointer;max-width:480px">
            <input type="checkbox" id="devAudioEnabled" ${Number(device.audio_enabled) === 0 ? '' : 'checked'} style="margin-top:3px">
            <span>
              Esta tela pode emitir som
              <span style="display:block;font-size:11px;color:var(--text-muted);line-height:1.4;margin-top:2px">Desligado, tudo toca em silêncio nesta tela, mesmo que um vídeo tenha áudio. O volume em si continua sendo do controle da TV.</span>
            </span>
          </label>
        </div>
      </div>

      ${device.tier === 2 ? `
      <!-- Terminal Tab (device owner) -->
      <div class="tab-content" id="tab-terminal">
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
          ${TERMINAL_PRESETS.map(p => `<button class="btn btn-secondary btn-sm term-preset" data-cmd="${esc(p.cmd)}" title="${esc(p.cmd)}">${esc(p.label)}</button>`).join('')}
        </div>
        <div id="termOut" style="background:var(--console-bg);color:var(--console-text);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;padding:12px;border-radius:8px;height:360px;overflow:auto;white-space:pre-wrap;border:1px solid var(--border)">Shell do player — roda com o UID do app (não como root). Digite um comando ou toque em um atalho.\n</div>
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
          <span style="color:var(--success);font-family:monospace;font-weight:700">$</span>
          <input id="termCmd" class="input" style="flex:1;font-family:monospace;font-size:13px" placeholder="comando, ex.: getprop ro.product.model" autocomplete="off" spellcheck="false"/>
          <button class="btn btn-primary btn-sm" id="termRun">Executar</button>
          <button class="btn btn-secondary btn-sm" id="termClear">Limpar</button>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Roda com o UID do app (untrusted_app), não como root — ser proprietário do dispositivo não concede shell privilegiado. dumpsys/settings/ip/battery são bloqueados pelo sistema aqui; endereço IP e bateria estão na aba Informações (reportados pelo app).</div>
        <hr style="border-color:var(--border);margin:14px 0 10px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Enviar um APK</div>
        <div style="display:flex;gap:6px">
          <input id="apkUrl" class="input" placeholder="https://…/app.apk" style="flex:1;font-size:12px"/>
          <button class="btn btn-secondary btn-sm" id="apkInstall">Enviar APK</button>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Baixa a URL e instala silenciosamente (proprietário do dispositivo). Qualquer chave de assinatura — não só a nossa.</div>
      </div>` : ''}

      <div class="device-save-bar">
          <button class="btn btn-primary" id="saveNotesBtn">Salvar configurações</button>
          <span id="unsavedHint" style="display:none;margin-left:10px;font-size:12px;color:var(--warning)">alterações não salvas</span>

      </div>
    `;
    // If this device is assigned the smoothness-diagnostic widget, poll THIS device's reported stats.
    if (diagWidget) startDiagPoll(diagWidget.widget_id, deviceId);
    // Hydrate authenticated thumbnail images in the playlist tab
    const pc = document.getElementById('playlistContainer');
    if (pc) hydrateAuthImages(pc);

    // Global key/command handlers for remote
    window._sendKey = (keycode) => {
      if (currentDevice) sendKey(currentDevice.id, keycode);
    };
    window._sendCmd = (type) => {
      if (currentDevice) sendCommand(currentDevice.id, type, {});
    };
    window._enableSystemView = () => {
      if (!currentDevice) return;
      sendCommand(currentDevice.id, 'enable_system_capture', {});
      // Unlock the system controls after a short delay (user needs to tap "Start now" on device)
      const btn = document.getElementById('enableSystemCaptureBtn');
      const hint = document.getElementById('systemViewHint');
      if (btn) { btn.textContent = 'Aguardando aprovação do dispositivo...'; btn.disabled = true; }
      // Check periodically if the device granted it (we'll know because screenshots keep coming even after Home)
      setTimeout(() => {
        const controls = document.getElementById('systemViewControls');
        if (controls) { controls.style.opacity = '1'; controls.style.pointerEvents = 'auto'; }
        if (btn) { btn.textContent = 'Visão do sistema ativada'; btn.style.background = 'var(--success)'; }
        if (hint) hint.textContent = 'Navegação e controles do sistema desbloqueados';
      }, 5000);
    };

    // #161 device-owner Terminal tab (tier 2 only): a real scrollback shell + preset commands + push-APK.
    if (device.tier === 2) {
      const termOut = document.getElementById('termOut');
      const append = (text) => { if (!termOut) return; termOut.textContent += text; termOut.scrollTop = termOut.scrollHeight; };
      const runCmd = (cmd) => { if (!cmd) return; append('\n$ ' + cmd + '\n'); sendCommand(device.id, 'shell', { cmd }); };
      const termCmd = document.getElementById('termCmd');
      document.getElementById('termRun')?.addEventListener('click', () => { const c = termCmd?.value?.trim(); if (c) { runCmd(c); termCmd.value = ''; } });
      termCmd?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.value.trim(); if (c) { runCmd(c); e.target.value = ''; } } });
      document.querySelectorAll('.term-preset').forEach(b => b.addEventListener('click', () => runCmd(b.dataset.cmd)));
      document.getElementById('termClear')?.addEventListener('click', () => { if (termOut) termOut.textContent = ''; });
      document.getElementById('apkInstall')?.addEventListener('click', () => {
        const url = document.getElementById('apkUrl')?.value?.trim();
        if (!url) return;
        if (!/^https?:\/\//.test(url)) { showToast('Informe uma URL http(s) válida de APK', 'error'); return; }
        sendCommand(device.id, 'install_apk', { url });
        append('\n# push apk → ' + url + '  (installs silently on a device owner)\n');
        showToast('Instalação do APK enviada', 'success');
      });
      if (shellHandler) off('shell-result', shellHandler);
      shellHandler = (data) => {
        if (data.device_id !== device.id) return;
        append((data.output || '') + (data.exit != null && data.exit !== 0 ? '\n[exit ' + data.exit + ']\n' : '\n'));
      };
      on('shell-result', shellHandler);
    }

    // Render uptime timeline
    renderUptimeTimeline(device.uptimeData || [], device.statusLog || []);

    // Render the Recent incidents panel (merges typed device_events with
    // offline→online transitions derived from the status log).
    renderIncidents(device.deviceEvents || [], device.statusLog || []);

    frameNowPlaying();
    setupTabs();
    setupActions(device);
    setupRemote(device);
    setupPlaylistActions(device);

    // Restore active tab if specified (e.g. after layout change)
    /*
     * One page now, so there is nothing to switch to — but the argument survives at nine call
     * sites that reload after a write, and Terminal is still a tab on device-owner panels. Scroll
     * the named section into view instead: same intent, "put me back where I was".
     */
    if (activeTab) {
      document.getElementById('tab-' + activeTab)?.scrollIntoView({ block: 'start' });
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      // Both loops above just cleared every tab, so a requested tab that no longer renders (its
      // capability went away, or the page was reloaded against a player that has since declared a
      // smaller set) would leave NO tab selected and the page blank. Fall back to Info, which is
      // never gated.
      const wanted = document.getElementById(`tab-${activeTab}`) ? activeTab : 'diagnostics';
      const tab = document.querySelector(`.tab[data-tab="${wanted}"]`);
      if (tab) tab.classList.add('active');
      const content = document.getElementById(`tab-${wanted}`);
      if (content) content.classList.add('active');
    }

    // Request a fresh screenshot on page load + poll periodically. #159: the preview used to go stale
    // because nothing re-requested it — the device only sends a frame on an explicit request or during
    // a live Remote session. Poll every 5s while this page is open so the Now Playing preview stays
    // current (cleared on view teardown). A Remote session streams at its own faster rate on top.
    if (device.status === 'online') {
      // NOT polled. This asked every open page for a fresh frame every five seconds, which is
      // why a preview appeared without anyone requesting one — and with a fleet of fifty it is a
      // standing cost paid per open tab. Capture is a command; it runs when commanded.
      if (screenshotInterval) clearInterval(screenshotInterval);
      screenshotInterval = null && setInterval(() => {
        if (!document.hidden) requestScreenshot(deviceId);
      }, 5000);
    }

  } catch (err) {
    contentEl.innerHTML = `<div class="empty-state"><h3>Falha ao carregar o dispositivo</h3><p>${esc(err.message)}</p></div>`;
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// #104: device preview — reuse the player in device-free preview mode, iframed
// same-origin (dashboard CSP frame-src 'self' allows it). Shows the device's CURRENT
// playlist in the device's OWN layout/orientation (server payload). wall members
// preview full-frame (server forces wall_config:null in v1).
//
// #238: the iframe is the panel's FRAMEBUFFER, not its face. It used to be given the as-displayed
// 9/16 shape directly, so on a portrait device the player rotated content a second time inside a
// box that was already the finished picture and the preview came out sideways — while the panel
// itself was right, which is the worst possible split for someone trying to verify their work.
// The stage is the face; the frame is landscape underneath it and the mount turns it back.
function showDevicePreview(device) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);max-width:95vw;max-height:92vh">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border);gap:12px">
        <strong style="color:var(--text-primary)">Pré-visualização — ${esc(device.name)}</strong>
        <button class="btn btn-secondary btn-sm" id="dpvClose">Fechar</button>
      </div>
      <div style="padding:16px;display:flex;align-items:center;justify-content:center;background:#000">
        <div id="dpvStage" style="height:78vh;max-width:92vw;aspect-ratio:${displayAspectRatio(device.orientation)};background:#000">
          <iframe style="border:0;background:#000" src="/player?preview=1&device=${encodeURIComponent(device.id)}&t=${Date.now()}"></iframe>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  frameDeviceOutput(overlay.querySelector('#dpvStage'), overlay.querySelector('#dpvStage iframe'), device.orientation);
  const close = () => overlay.remove();
  overlay.querySelector('#dpvClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', function esc2(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
}

// #150 re-adopt fallback: browse the workspace's previously-removed device snapshots and
// apply one onto THIS (usually blank, just-re-paired) device. Primary restore is the silent
// fingerprint-match on re-pair; this is for factory-reset / new-hardware / changed-fingerprint.
const ORIENT_LABELS = {
  'landscape': 'Paisagem (0°)',
  'portrait': 'Retrato (90° SH)',
  'landscape-flipped': 'Paisagem invertida (180°)',
  'portrait-flipped': 'Retrato invertido (270° SH)',
};
const orientLabel = (o) => (ORIENT_LABELS[o] || ORIENT_LABELS.landscape);
const fmtTs = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '—');

// #161: device-owner provisioning helper — QR (scan after factory-reset, tap welcome 6×) + the ADB
// one-liner. Device owner is optional; it unlocks silent updates, reboot, kiosk, time control.

async function showReAdoptModal(device) {
  let snapshots, playlists;
  try {
    [snapshots, playlists] = await Promise.all([
      api.getRemovedDevices(),
      api.getPlaylists().catch(() => []),   // best-effort: only used to label the restored playlist
    ]);
  } catch (err) { showToast(err.message || 'Não foi possível restaurar as configurações', 'error'); return; }

  const plById = new Map((playlists || []).map(p => [p.id, p.name]));
  const playlistLabel = (s) => !s.playlist_id
    ? 'nenhuma'
    : (plById.get(s.playlist_id) || '(playlist já excluída)');

  const rowsHtml = (snapshots || []).map((s, i) => {
    const blockedBadge = s.blocked
      ? `<span style="background:var(--danger);color:#fff;padding:1px 7px;border-radius:4px;font-size:11px;margin-left:8px;vertical-align:middle">Bloqueada</span>`
      : '';
    // Fingerprint is the key but not an operator-facing identifier — truncated + on-hover only.
    const fpShort = (s.fingerprint || '').slice(0, 8);
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${esc(s.device_name || 'Tela sem nome')}${blockedBadge}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
            Orientação: ${esc(orientLabel(s.orientation))}
            &nbsp;·&nbsp; Fuso horário: ${esc(s.timezone || 'UTC')}
            &nbsp;·&nbsp; Playlist: ${esc(playlistLabel(s))}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px" title="fp ${esc(fpShort)}…">
            Visto por último: ${esc(fmtTs(s.last_seen))} &nbsp;·&nbsp; Removida: ${esc(fmtTs(s.removed_at))}
          </div>
        </div>
        <button class="btn btn-primary btn-sm readopt-apply" data-i="${i}">Aplicar</button>
      </div>`;
  }).join('');

  const emptyHtml = `<div style="text-align:center;color:var(--text-muted);padding:36px 12px">Nenhuma tela removida anteriormente neste workspace.</div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:600px;width:95vw">
      <div class="modal-header">
        <h3>Restaurar configurações de uma tela removida</h3>
        <button class="btn-icon" id="readoptClose">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-muted);font-size:13px;margin-top:0">${`Escolha uma tela removida anteriormente para copiar as configurações salvas dela para “${esc(device.name || '')}”. Isto sobrescreve as configurações atuais.`}</p>
        ${(snapshots && snapshots.length) ? rowsHtml : emptyHtml}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#readoptClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  overlay.querySelectorAll('.readopt-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const s = snapshots[parseInt(btn.dataset.i, 10)];
      let msg = `Aplicar as configurações salvas de “${s.device_name || 'Tela sem nome'}” em “${device.name || ''}”? Isto sobrescreve as configurações atuais.`;
      if (s.blocked) msg += '\n\n⚠ ' + 'Esta tela estava BLOQUEADA. Aplicar vai bloquear novamente a tela de destino — ela vai recusar a conexão imediatamente e ficar preta. Continuar?';   // explicit: target will go dark
      if (!confirm(msg)) return;
      btn.disabled = true;
      try {
        await api.reAdoptDevice(device.id, s.fingerprint);
        showToast(`Configurações restauradas (${orientLabel(s.orientation)})`, 'success');
        close();
        loadDevice(device.id);   // refresh so restored orientation/name/etc show immediately
      } catch (err) {
        // Server messages: 404 no snapshot, 403 cross-workspace, 400 bad request.
        showToast(err.message || 'Não foi possível restaurar as configurações', 'error');
        btn.disabled = false;
      }
    });
  });
}

function setupActions(device) {
  // #104 Preview button
  // PIN rotate / set. The response says whether the panel took it LIVE: an offline display
  // applies it on its next reconnect, and an operator rotating a leaked PIN needs to know
  // which of those happened rather than assuming access is already revoked.
  async function applyPin(body, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      const r = await api.setDevicePin(device.id, body);
      device.settings_pin = r.settings_pin;
      const el = document.querySelector('#rotatePinBtn')?.closest('.info-card')?.querySelector('.info-card-value');
      if (el) el.textContent = r.settings_pin;
      showToast(r.delivered ? 'PIN atualizado — a tela já recebeu' : 'PIN salvo — a tela vai receber quando reconectar', 'success');
    } catch (e) {
      showToast(e?.message || 'Não foi possível atualizar o PIN', 'error');
    }
  }

  document.getElementById('rotatePinBtn')?.addEventListener('click', () =>
    applyPin({ rotate: true }, 'Gerar um novo PIN de configuração para esta tela? O PIN atual para de funcionar imediatamente.'));

  document.getElementById('setPinBtn')?.addEventListener('click', async () => {
    const pin = await showPrompt({
      title: 'Novo PIN de 6 dígitos',
      label: 'Novo PIN de 6 dígitos',
      maxLength: 6,
    });
    if (pin === null) return;
    applyPin({ pin });
  });

  document.getElementById('devicePreviewBtn')?.addEventListener('click', () => showDevicePreview(device));

  // Screenshot button — pass a callback so the server's verdict surfaces as a toast
  // instead of the request silently going nowhere (offline device, or a player type
  // that can't capture at all, e.g. BrightSign).
  document.getElementById('screenshotBtn')?.addEventListener('click', () => {
    // Armed only by a press. A Remote session streams frames through the same event, and a dialog
    // opening on each one would be unusable.
    awaitingCapture = true;
    requestScreenshot(device.id, (ack) => {
      if (ack?.delivered) showToast('Captura solicitada', 'info');
      else if (ack?.reason === 'unsupported') { awaitingCapture = false; showToast('O player desta tela não suporta capturas de tela', 'warning'); }
      else if (ack?.reason === 'offline') { awaitingCapture = false; showToast('A tela está offline — captura não solicitada', 'warning'); }
      // Delivered-into-silence is the failure this replaces: the socket belongs to the service and
      // the capture belongs to the Activity, so a panel that booted without its player answered
      // nothing and the dashboard waited for ever.
      else if (ack?.reason === 'not_playing') { awaitingCapture = false; showToast('O player não está em execução nesta tela — não há o que capturar', 'warning'); }
      else { awaitingCapture = false; showToast('Falha na solicitação de captura — sem resposta do servidor', 'error'); }
    });
  });

  // Rename
  document.getElementById('deviceName')?.addEventListener('click', async () => {
    const name = await showPrompt({
      title: 'Digite o novo nome:',
      label: 'Digite o novo nome:',
      value: device.name,
    });
    if (name && name !== device.name) {
      try {
        await api.updateDevice(device.id, { name });
        document.getElementById('deviceName').textContent = name;
        currentDevice.name = name;
        showToast('Tela renomeada', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  // Populate default content dropdown (async, non-blocking — same .then() pattern as the
  // playlist picker below). setupActions is a SYNCHRONOUS function; awaiting here made the whole
  // file fail to parse ("Unexpected reserved word") AND would have deferred every listener below
  // (save, #150 re-adopt, delete) until this fetch resolved. .then() keeps them registering immediately.
  api.getContent().then(content => {
    const defaultSelect = document.getElementById('deviceDefaultContent');
    if (defaultSelect) {
      content.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.filename;
        if (device.default_content_id === c.id) opt.selected = true;
        defaultSelect.appendChild(opt);
      });
    }
  }).catch(() => {});

  // Save settings (notes + orientation + default content)
  // Debug logging toggle: sends a transient set_debug command to the device and
  // reveals the live log panel. State is per-session (resets on device reconnect).
  document.getElementById('debugLogToggle')?.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    const panel = document.getElementById('debugLogPanel');
    if (panel) panel.style.display = enabled ? 'block' : 'none';
    const tools = document.getElementById('debugLogTools');
    if (tools) tools.style.display = enabled ? 'flex' : 'none';
    debugStreamOn = enabled;
    // Unticking and reticking should not resume into a frozen panel the operator forgot about.
    if (!enabled) { debugFrozen = false; debugHeld = []; }
    updateDebugTools();
    sendCommand(device.id, 'set_debug', { enabled });
  });

  document.getElementById('debugFreezeBtn')?.addEventListener('click', () => setDebugFrozen(!debugFrozen));

  document.getElementById('debugClearBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('debugLogPanel');
    if (panel) panel.textContent = '';
    debugHeld = [];
    updateDebugTools();
  });

  document.getElementById('debugCopyBtn')?.addEventListener('click', async () => {
    const panel = document.getElementById('debugLogPanel');
    // Copy what is ON SCREEN. Anything held while frozen is deliberately excluded — the operator
    // is copying the capture they are looking at, and silently appending lines they have not seen
    // would make the paste disagree with the panel.
    const text = panel ? [...panel.children].map((el) => el.textContent).join('\n') : '';
    if (!text) { showToast('Ainda não há nada para copiar', 'error'); return; }
    const header = `${device.name || device.id} — ${device.platform || ''} ${device.hardware_model || ''} — ${new Date().toISOString()}`.trim();
    const ok = await copyToClipboard(`${header}\n${'-'.repeat(header.length)}\n${text}\n`);
    showToast(ok ? `${panel.childElementCount} linha(s) copiada(s) para a área de transferência` : 'Não foi possível acessar a área de transferência — selecione o log e copie manualmente', ok ? 'success' : 'error');
  });

  /*
   * ONE Save for the whole page.
   *
   * This page used to have three: Aplicar wrote the layout, Salvar zonas wrote the zone map, and
   * Salvar configurações wrote everything else. Each of them reached the wall on its own, so a
   * screen could sit in front of customers wearing a new layout with nothing in its zones while
   * the operator was still halfway through deciding. Now nothing leaves this page until the
   * button is pressed, and then all of it does.
   *
   * THE ORDER IS LOAD-BEARING. The zones route validates each zone id against the device's
   * CURRENT layout_id, so writing the layout second would have every zone in a freshly chosen
   * layout rejected as unknown. Layout first, always.
   */
  document.getElementById('saveNotesBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const layoutSel = document.getElementById('deviceLayoutSelect');
      await api.updateDevice(device.id, {
        notes: document.getElementById('deviceNotes').value,
        orientation: document.getElementById('deviceOrientation').value,
        default_content_id: document.getElementById('deviceDefaultContent').value || null,
        ota_enabled: document.getElementById('otaToggle')?.checked ? 1 : 0,
        ota_beta: document.getElementById('otaBetaToggle')?.checked ? 1 : 0,
        reboot_schedule: document.getElementById('rebootSchedule')?.value || null,
        ...(layoutSel ? { layout_id: layoutSel.value || null } : {}),
      });

      // Only after the layout is stored, and only if this layout actually has zones on screen.
      const zoneSelects = document.querySelectorAll('.zone-playlist');
      if (zoneSelects.length) {
        const zones = {};
        zoneSelects.forEach((sel) => { zones[sel.dataset.zone] = sel.value || null; });
        await api.setDeviceZones(device.id, zones);
      }

      device.layout_id = layoutSel ? (layoutSel.value || null) : device.layout_id;
      clearDirty();
      showToast('Configurações salvas', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally { btn.disabled = false; }
  });

  /*
   * Unsaved-change tracking.
   *
   * Deferring the writes fixes one way of being surprised and introduces another: configure,
   * walk away, and nothing happened. A label by the button and a browser prompt on leaving are
   * what keep the trade honest.
   */
  for (const id of ['deviceOrientation', 'deviceNotes', 'deviceDefaultContent', 'otaToggle',
    'otaBetaToggle', 'rebootSchedule', 'playlistPicker']) {
    document.getElementById(id)?.addEventListener('change', markDirty);
  }

  // #150 re-adopt: apply a previously-removed device's saved settings onto THIS device (the
  // fallback for when the fingerprint changed and automatic restore couldn't fire).
  document.getElementById('reAdoptBtn')?.addEventListener('click', () => showReAdoptModal(device));

  // Publish / Discard from device detail
  const devicePublishBtn = document.getElementById('devicePublishBtn');
  if (devicePublishBtn && device.playlist_id) {
    devicePublishBtn.addEventListener('click', async () => {
      try {
        devicePublishBtn.disabled = true;
        devicePublishBtn.textContent = 'Publicando...';
        await api.publishPlaylist(device.playlist_id);
        showToast('Playlist publicada — dispositivos atualizados');
        loadDevice(device.id, 'screen');
      } catch (err) {
        devicePublishBtn.disabled = false;
        devicePublishBtn.textContent = 'Publicar';
        showToast(err.message, 'error');
      }
    });
  }
  const deviceDiscardBtn = document.getElementById('deviceDiscardDraftBtn');
  if (deviceDiscardBtn && device.playlist_id) {
    deviceDiscardBtn.addEventListener('click', async () => {
      if (!confirm('Descartar todas as alterações não publicadas e voltar à última versão publicada?')) return;
      try {
        await api.discardPlaylistDraft(device.playlist_id);
        showToast('Alterações do rascunho descartadas');
        loadDevice(device.id, 'screen');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Populate playlist picker
  const playlistPicker = document.getElementById('playlistPicker');
  if (playlistPicker) {
    api.getPlaylists().then(playlists => {
      playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.is_auto_generated
          ? `${p.name} (auto) — ${p.item_count} itens`
          : `${p.name} — ${p.item_count} itens`;
        if (p.id === device.playlist_id) opt.selected = true;
        playlistPicker.appendChild(opt);
      });
      // If device has no playlist, keep "No playlist" selected
      if (!device.playlist_id) playlistPicker.value = '';
    }).catch(() => {});

    playlistPicker.addEventListener('change', async () => {
      const newPlaylistId = playlistPicker.value;
      try {
        // Empty value is the "No playlist" option. It used to be discarded right here, so the
        // option was offered, selecting it did nothing, and nothing said so (#234).
        if (newPlaylistId) {
          await api.assignPlaylistToDevice(newPlaylistId, device.id);
        } else {
          await api.clearDevicePlaylist(device.id);
        }
        device.playlist_id = newPlaylistId || null;
        showToast('Playlist alterada');
        // Reload rather than repaint: the "Editar esta lista" link exists only once a playlist is
        // set, so there is no partial update that leaves the tab correct.
        loadDevice(device.id, 'screen');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

/* One screen out of a list, in the product's own modal. Resolves to the device or null. */
function pickDevice(devices) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><h3>${esc('Copiar lista para outra tela')}</h3></div>
        <div class="modal-body">
          <div class="form-group">
            <label for="copyTarget">${esc('Tela de destino')}</label>
            <select id="copyTarget" class="input">
              ${devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="copyCancel">${esc('Cancelar')}</button>
          <button class="btn btn-primary" id="copyOk">${esc('Copiar')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    function onKey(e) { if (e.key === 'Escape') close(null); }

    overlay.querySelector('#copyOk').addEventListener('click', () => {
      const id = overlay.querySelector('#copyTarget').value;
      close(devices.find((d) => d.id === id) || null);
    });
    overlay.querySelector('#copyCancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

  // Copy playlist to another device
  document.getElementById('copyPlaylistBtn')?.addEventListener('click', async () => {
    try {
      const devices = await api.getDevices();
      const others = devices.filter(d => d.id !== device.id);
      if (!others.length) { showToast('Não há outros dispositivos para copiar', 'info'); return; }

      /*
       * A CHOICE, so a list to choose from — not a number to type.
       *
       * This was a prompt() that rendered the screens as a numbered list INSIDE the message and
       * asked the operator to type the index. Every failure mode of that is silent: type 3 when
       * the list shifted and the playlist lands on the wrong wall, type a name instead of a
       * number and it just says "invalid selection".
       *
       * showPrompt is deliberately one text field, so this gets its own small modal rather than
       * an options mode bolted onto a component that exists to stay simple.
       */
      const target = await pickDevice(others);
      if (!target) return;

      const token = localStorage.getItem('token');
      const res = await fetch(`/api/assignments/device/${device.id}/copy-to/${target.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ replace: false })
      });
      const data = await res.json();
      if (res.ok) showToast(`${data.copied} itens copiados para ${target.name}`, 'success');
      else showToast(data.error, 'error');
    } catch (err) { showToast(err.message, 'error'); }
  });

  // #146 Item D: operator block/unblock — takes effect on the device's next register,
  // no restart. Server enforces even a device_id-less reconnect via the identity chain.

  // #161 Tier-2 controls (rendered only for device-owner panels).
  const t2 = (type, confirm) => {
    if (confirm && !window.confirm(confirm)) return;
    sendCommand(device.id, type, {});
    showToast('Comando enviado', 'success');
  };
  document.getElementById('t2Reboot')?.addEventListener('click', () => t2('reboot', 'Reiniciar este painel agora?'));
  document.getElementById('t2Lock')?.addEventListener('click', () => t2('lock_now'));
  document.getElementById('t2KioskOn')?.addEventListener('click', () => t2('kiosk_lock'));
  document.getElementById('t2KioskOff')?.addEventListener('click', () => t2('kiosk_unlock'));

  /*
   * The sound switch. Saved immediately, because it is the one setting people press while
   * standing in front of a screen that is making noise it should not make.
   *
   * The checkbox is reverted if the save fails. A switch that stays where you put it while the
   * server never heard about it is how someone walks away believing a waiting room is silent.
   */
  /*
   * Operating hours, edited with the same block editor as a content schedule — same shape, same
   * validation, and one fewer thing for an operator to learn. Mon-Fri 08:00-19:00 plus Sat
   * 08:00-13:00 is two blocks; Sunday closed is simply no block covering it.
   *
   * Saved on its own rather than waiting for Salvar configurações: it is edited inside a modal
   * that already has its own Save, and two nested save buttons meaning different things is worse
   * than one exception to the page rule.
   */
  async function refreshHoursSummary() {
    const el = document.getElementById('deviceHoursSummary');
    if (!el) return;
    try {
      const blocks = await api.getDeviceHours(device.id);
      el.textContent = blocks.length ? `${blocks.length} faixa(s)`
        : 'não configurado';
    } catch (e) { el.textContent = ''; }
  }
  refreshHoursSummary();

  document.getElementById('deviceHoursBtn')?.addEventListener('click', async () => {
    let blocks = [];
    try { blocks = await api.getDeviceHours(device.id); } catch (e) { /* none yet */ }
    showScheduleEditor({
      title: device.name,
      blocks,
      onSave: async (payload) => {
        await api.setDeviceHours(device.id, payload);
        /*
         * Opening hours decide whether an offline screen is a fault or a shut shop, so saving them
         * can silence — or raise — the sidebar alert without any screen changing state. Nothing
         * announced that, which is exactly how a screen stayed flagged after its hours were set.
         */
        window.dispatchEvent(new CustomEvent('device-config-changed', { detail: { id: device.id } }));
        showToast('Horário de funcionamento salvo', 'success');
        refreshHoursSummary();
      },
    });
  });

  const audioBox = document.getElementById('devAudioEnabled');
  audioBox?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    audioBox.disabled = true;
    try {
      await api.updateDevice(device.id, { audio_enabled: on });
      device.audio_enabled = on ? 1 : 0;
      showToast((on ? 'Som liberado nesta tela' : 'Esta tela agora fica em silêncio'), 'success');
    } catch (err) {
      e.target.checked = !on;
      showToast(err.message, 'error');
    } finally { audioBox.disabled = false; }
  });

  /*
   * Substituir tela. The screen keeps its name, playlist, layout, sound setting, history and
   * licence; the old box drops back to a pairing code.
   *
   * This was a prompt(): an unstyled browser box with no validation, for an operation that moves
   * a screen onto different hardware. It now opens the same modal as Add Display, because it is
   * the same six-digit field doing the same job.
   */
  document.getElementById('replaceDeviceBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('replaceDeviceModal');
    const input = document.getElementById('replaceCodeInput');
    if (!modal || !input) return;
    input.value = '';
    const intro = document.getElementById('replaceDeviceIntro');
    if (intro) intro.textContent = `Digite o código de pareamento que o novo aparelho está mostrando para "${device.name}".`;
    modal.style.display = 'flex';
    input.focus();
  });

  document.getElementById('replaceOwnerQrBtn')?.addEventListener('click', () => showDeviceOwnerQRModal());

  document.getElementById('replaceConfirmBtn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const code = (document.getElementById('replaceCodeInput')?.value || '').trim();
    if (!/^\d{6}$/.test(code)) { showToast('O código tem 6 dígitos', 'error'); return; }
    btn.disabled = true;
    try {
      await api.replaceDevice(device.id, code);
      document.getElementById('replaceDeviceModal').style.display = 'none';
      showToast(`"${device.name}" agora roda no aparelho novo`, 'success');
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      // The server refuses a code that belongs to a live screen and names it. Surface that text
      // verbatim: it is the difference between "it did not work" and "you typed Vitrine’s code".
      showToast(err.message, 'error');
    } finally { btn.disabled = false; }
  });

  // Delete (double-click to confirm)
  const deleteBtn = document.getElementById('deleteDeviceBtn');
  let deleteConfirming = false;
  let deleteTimeout = null;
  deleteBtn?.addEventListener('click', async () => {
    if (deleteConfirming) {
      try {
        deleteBtn.textContent = 'Removendo...';
        deleteBtn.disabled = true;
        await api.deleteDevice(device.id);
        showToast('Tela removida', 'success');
        window.location.hash = '/';
      } catch (err) {
        showToast(err.message, 'error');
        deleteBtn.textContent = 'Remover';
        deleteBtn.disabled = false;
        deleteConfirming = false;
      }
      return;
    }
    deleteConfirming = true;
    deleteBtn.textContent = 'Clique novamente para confirmar';
    deleteBtn.style.background = 'var(--danger)';
    deleteBtn.style.color = 'white';
    clearTimeout(deleteTimeout);
    deleteTimeout = setTimeout(() => {
      deleteConfirming = false;
      deleteBtn.textContent = 'Remover';
      deleteBtn.style.background = '';
      deleteBtn.style.color = '';
    }, 3000);
  });

  // Send a command and surface the ack as a toast.
  // - delivered: device received it (green/success)
  // - queued: device is offline, will deliver on reconnect (amber/warning)
  // - unsupported: the player cannot do this at all (red/error, names the capability)
  // - no_ack / fallback: server didn't respond or queue unavailable (red/error)
  function sendWithFeedback(type, cmdLabel, successKey) {
    sendCommand(device.id, type, {}, (ack) => {
      if (ack?.delivered) showToast((successKey), 'success');
      // Reachable from a stale tab rendered before the panel declared its capabilities: the
      // button was there when the page loaded and is gone on reload. Say why rather than
      // showing the generic "undeliverable", which reads as a network problem.
      else if (ack?.reason === 'unsupported') showToast(`${cmdLabel} — este player não suporta (${ack.capability || ''}). Recarregue a página para atualizar os controles.`, 'error');
      else if (ack?.queued) showToast(`${cmdLabel} — tela offline, será entregue ao reconectar`, 'warning');
      else if (ack?.reason === 'no_ack') showToast(`${cmdLabel} — sem resposta do servidor`, 'error');
      else showToast(`${cmdLabel} — tela offline e fila indisponível`, 'error');
    });
  }

  // Reboot (double-click to confirm)
  const rebootBtn = document.getElementById('rebootBtn');
  let rebootConfirming = false;
  let rebootTimeout = null;
  rebootBtn?.addEventListener('click', () => {
    if (rebootConfirming) {
      sendWithFeedback('reboot', 'Reboot', 'Comando de reinício enviado');
      rebootConfirming = false;
      rebootBtn.textContent = 'Reiniciar dispositivo';
      return;
    }
    rebootConfirming = true;
    rebootBtn.textContent = 'Clique novamente para confirmar';
    clearTimeout(rebootTimeout);
    rebootTimeout = setTimeout(() => {
      rebootConfirming = false;
      rebootBtn.textContent = 'Reiniciar dispositivo';
    }, 3000);
  });

  // Shutdown (double-click to confirm)
  const shutdownBtn = document.getElementById('shutdownBtn');
  let shutdownConfirming = false;
  let shutdownTimeout = null;
  shutdownBtn?.addEventListener('click', () => {
    if (shutdownConfirming) {
      sendWithFeedback('shutdown', 'Shutdown', 'Comando de desligamento enviado');
      shutdownConfirming = false;
      shutdownBtn.textContent = 'Desligar';
      return;
    }
    shutdownConfirming = true;
    shutdownBtn.textContent = 'Clique novamente para confirmar';
    shutdownBtn.style.background = 'var(--danger)';
    shutdownBtn.style.color = 'white';
    clearTimeout(shutdownTimeout);
    shutdownTimeout = setTimeout(() => {
      shutdownConfirming = false;
      shutdownBtn.textContent = 'Desligar';
      shutdownBtn.style.background = '';
      shutdownBtn.style.color = '';
    }, 3000);
  });

  // Screen Off
  document.getElementById('screenOffBtn')?.addEventListener('click', () => {
    sendWithFeedback('screen_off', 'Screen off', 'Comando para desligar tela enviado');
  });

  // Screen On
  document.getElementById('screenOnBtn')?.addEventListener('click', () => {
    sendWithFeedback('screen_on', 'Screen on', 'Comando para ligar tela enviado');
  });

  // Launch Player
  /*
   * "Reiniciar aplicativo" sends RESTART, not launch.
   *
   * It sent 'launch' for as long as it existed, and launch is startActivity(MainActivity) with
   * CLEAR_TOP — it brings the player to the front. On a signage panel the player IS the front, so
   * the button did nothing, every time, and nothing said so.
   *
   * A panel on an older build does not know this command and ignores it, which is the same
   * outcome the button already had. It starts working when the panel takes the new APK.
   */
  document.getElementById('launchAppBtn')?.addEventListener('click', () => {
    sendWithFeedback('restart', 'Restart', 'Reinício enviado — a tela volta em alguns segundos');
  });

  // Force Update
  document.getElementById('forceUpdateBtn')?.addEventListener('click', () => {
    sendWithFeedback('update', 'Update', 'Verificação de atualização disparada');
  });

  // #109: PiP overlay tester — pushes/clears an overlay via the public API (POST /api/pip).
  document.getElementById('sendPipBtn')?.addEventListener('click', async () => {
    const uri = (document.getElementById('pipUri')?.value || '').trim();
    if (!uri) { showToast('Enter an overlay URL', 'error'); return; }
    try {
      const res = await api.sendPip(device.id, {
        type: document.getElementById('pipType').value,
        uri,
        position: document.getElementById('pipPosition').value,
        duration: Number(document.getElementById('pipDuration').value) || 0,
      });
      showToast(`Overlay sent (${res.sent} sent, ${res.offline} offline)`, res.sent ? 'success' : 'warning');
    } catch (err) { showToast(err.message, 'error'); }
  });
  document.getElementById('clearPipBtn')?.addEventListener('click', async () => {
    try { await api.clearPip(device.id); showToast('Overlay cleared', 'success'); }
    catch (err) { showToast(err.message, 'error'); }
  });
}

function setupRemote(device) {
  const startBtn = document.getElementById('startRemoteBtn');
  const stopBtn = document.getElementById('stopRemoteBtn');
  const overlay = document.getElementById('remoteOverlay');
  const canvas = document.getElementById('remoteCanvas');

  startBtn?.addEventListener('click', () => {
    console.log('Start Remote clicked for device:', device.id);
    remoteActive = true;
    startRemote(device.id);
    requestScreenshot(device.id);
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    overlay.style.display = 'none';
    showToast('Sessão de controle remoto iniciada', 'info');
  });

  stopBtn?.addEventListener('click', () => {
    remoteActive = false;
    stopRemote(device.id);
    stopBtn.style.display = 'none';
    startBtn.style.display = '';
    overlay.style.display = 'flex';
  });

  // #159: mouse-as-finger. A click = tap; a drag = swipe (scroll). Pointer events so a press-move-
  // release maps to a gesture with the same normalized start/end + duration the device replays.
  let drag = null;
  const norm = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  };
  const feedback = (cx, cy) => {
    const ctx = canvas.getContext('2d');
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = brandInk();
    ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;
  };
  canvas?.addEventListener('pointerdown', (e) => {
    if (!remoteActive) return;
    const p = norm(e);
    drag = { ...p, t: Date.now() };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    feedback(p.cx, p.cy);
  });
  canvas?.addEventListener('pointerup', (e) => {
    if (!remoteActive || !drag) return;
    const p = norm(e);
    const dist = Math.hypot(p.x - drag.x, p.y - drag.y);
    const dur = Math.min(1200, Math.max(120, Date.now() - drag.t));
    if (dist > 0.02) {
      sendSwipe(device.id, drag.x, drag.y, p.x, p.y, dur);   // drag → scroll
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = brandInk();
      ctx.globalAlpha = 0.6; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(drag.cx, drag.cy); ctx.lineTo(p.cx, p.cy); ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      sendTouch(device.id, drag.x, drag.y, 'tap');
    }
    drag = null;
  });
  canvas?.addEventListener('pointercancel', () => { drag = null; });
}

async function setupPlaylistActions(device) {
  // Load layouts into selector
  try {
    const layoutsRes = await fetch('/api/layouts', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }});
    const layouts = await layoutsRes.json();
    const select = document.getElementById('deviceLayoutSelect');
    if (select) {
      layouts.filter(l => !l.is_template).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `${l.name} (${l.zones?.length || 0} zonas)`;
        if (device.layout_id === l.id) opt.selected = true;
        select.appendChild(opt);
      });
      // Add templates too
      layouts.filter(l => l.is_template).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `[Modelo] ${l.name} (${l.zones?.length || 0} zonas)`;
        if (device.layout_id === l.id) opt.selected = true;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('Failed to load layouts:', err);
  }

  /*
   * Draw a playlist field per zone of the current layout.
   *
   * The server returns the ZONES, not just the saved rows, so an unfilled zone still gets a
   * field. Asking the page to join the layout against a sparse map is how one of them ends up
   * missing, and a zone with no field is a zone the operator cannot fill.
   */
  /*
   * Draw a playlist field per zone of the layout CURRENTLY CHOSEN in the select — which is not
   * necessarily the one saved on the device.
   *
   * That distinction is what lets Aplicar disappear. Asking the device for its zones only ever
   * answers for the layout it already has, so the fields could not appear until something was
   * written. Asking the LAYOUT instead answers for whatever the operator just picked, and the
   * write waits for Salvar configurações like everything else on this page.
   *
   * `layoutId === undefined` means "first render, use whatever the device has saved".
   */
  async function renderZoneFields(layoutId) {
    const host = document.getElementById('zonePlaylists');
    if (!host) return;
    host.innerHTML = '';
    const fullscreenRow = document.getElementById('fullscreenPlaylistRow');

    let data;
    try {
      if (layoutId === undefined) {
        // First paint: the device knows both its layout and which list sits in each zone.
        data = await api.getDeviceZones(device.id);
      } else if (layoutId) {
        // A different layout was picked. Its zones come from the layout; any list already mapped
        // for a zone id that survives the change is kept, so switching back and forth does not
        // silently empty the fields.
        const [layout, saved] = await Promise.all([
          api.getLayout(layoutId),
          api.getDeviceZones(device.id).catch(() => ({ zones: [] })),
        ]);
        const previous = new Map((saved.zones || []).map((z) => [z.id, z.playlist_id]));
        data = {
          zones: (layout.zones || []).map((z) => ({
            id: z.id, name: z.name, playlist_id: previous.get(z.id) || null,
          })),
        };
      } else {
        data = { zones: [] };        // fullscreen
      }
    } catch (e) { return; }   // no access: the single-playlist field still applies

    /*
     * On a multi-zone layout the single Playlist field is not just redundant — the server
     * ignores devices.playlist_id entirely and composes from the zone map, so leaving it on
     * screen offers a control that silently does nothing. Hide it, and put it back the moment
     * the layout goes back to one zone.
     */
    const multi = (data?.zones?.length || 0) >= 2;
    if (fullscreenRow) fullscreenRow.style.display = multi ? 'none' : '';
    if (!multi) return;

    const playlists = await api.getPlaylists().catch(() => []);
    const options = (selected) => [
      `<option value="">${esc('— nenhuma —')}</option>`,
      ...playlists.map((pl) => `<option value="${esc(pl.id)}" ${pl.id === selected ? 'selected' : ''}>${esc(pl.name)}</option>`),
    ].join('');

    host.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${esc('Qual lista toca em cada zona')}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:10px 12px;align-items:center;font-size:13px">
          ${data.zones.map((z) => `
            <label for="zone-${esc(z.id)}" style="white-space:nowrap">${esc(z.name || z.id)}</label>
            <select id="zone-${esc(z.id)}" data-zone="${esc(z.id)}" class="input zone-playlist"
                    style="background:var(--bg-input);padding:4px 8px;font-size:13px">${options(z.playlist_id)}</select>
          `).join('')}
        </div>
      </div>`;

    // One Save for the whole page: the zone selects just mark the form dirty, like every other
    // field. saveNotesBtn is what writes them.
    host.querySelectorAll('.zone-playlist').forEach((sel) => sel.addEventListener('change', markDirty));
  }
  renderZoneFields();

  /*
   * Choosing a layout redraws the zone fields, and saves NOTHING until Salvar configurações.
   *
   * It used to write layout_id immediately and reload the page, which is how a screen ended up
   * with a two-zone layout and no lists in it — the layout reached the wall while the operator
   * was still deciding what should play there.
   */
  document.getElementById('deviceLayoutSelect')?.addEventListener('change', (e) => {
    markDirty();
    renderZoneFields(e.target.value || null);
  });

  // Add content button
  document.getElementById('addContentBtn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };

    try {
      const [content, widgets, kioskPages] = await Promise.all([
        api.getContent(),
        fetch('/api/widgets', { headers }).then(r => r.json()),
        fetch('/api/kiosk', { headers }).then(r => r.json()),
      ]);

      // Get layout zones if device has a layout assigned. We track
      // zonesFetchFailed separately so the modal can distinguish "fetch
      // broke" from "fetch succeeded, layout genuinely has no zones" -
      // both end with zones=[] but the user message differs.
      // The !res.ok throw is required because fetch only rejects on network
      // errors; an HTTP 403/404 would otherwise json-parse into {error: ...}
      // and zones would silently be [].
      let zones = [];
      let zonesFetchFailed = false;
      if (device.layout_id) {
        try {
          const res = await fetch(`/api/layouts/${device.layout_id}`, { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const layout = await res.json();
          zones = layout.zones || [];
        } catch (e) {
          console.warn('Failed to load layout for zone picker:', e.message);
          zonesFetchFailed = true;
        }
      }

      if (!content.length && !widgets.length && !kioskPages.length) {
        showToast('Ainda não há conteúdo, widgets ou páginas de quiosque. Crie algo primeiro!', 'error');
        return;
      }

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal" style="max-width:650px;width:95vw">
          <div class="modal-header">
            <h3>Adicionar à playlist</h3>
            <button class="btn-icon" id="closeAssignModal">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>Zona</label>
              ${zones.length > 0 ? `
                <select id="assignZone" class="input" style="background:var(--bg-input)">
                  <option value="">Padrão (tela cheia)</option>
                  ${zones.map(z => `<option value="${z.id}">${esc(z.name)} (${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}%)</option>`).join('')}
                </select>
              ` : !device.layout_id ? `
                <div style="font-size:12px;color:var(--text-muted);padding:6px 0;line-height:1.5">Esta tela não tem layout atribuído. O conteúdo vai tocar em tela cheia. Escolha um layout na lista Layout desta tela para usar zonas.</div>
              ` : zonesFetchFailed ? `
                <div style="font-size:12px;color:var(--danger);padding:6px 0;line-height:1.5">Não foi possível carregar as zonas do layout. Tente recarregar a página.</div>
              ` : `
                <div style="font-size:12px;color:var(--text-muted);padding:6px 0;line-height:1.5">Este layout não tem zonas definidas.</div>
              `}
            </div>
            <div class="form-group">
              <label>Duração (segundos, para imagens/widgets)</label>
              <!-- max is the server's absurd-duration ceiling (12h): a feature-length clip
                   pre-filled from its own length must not land in an out-of-range field. -->
              <input type="number" id="assignDuration" class="input" value="10" min="1" max="43200">
            </div>
            <!-- Tabs -->
            <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:12px">
              <div class="assign-tab active" data-tab="media" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid var(--accent-ink);color:var(--accent-ink)">${`Mídia (${content.length})`}</div>
              <div class="assign-tab" data-tab="widgets" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">${`Widgets (${widgets.length})`}</div>
              <div class="assign-tab" data-tab="kiosk" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">${`Quiosque (${kioskPages.length})`}</div>
            </div>
            <!-- Media grid -->
            <div class="assign-content-grid" id="assignMedia">
              ${content.map(c => `
                <div class="assign-content-item" data-content-id="${c.id}" data-type="content" data-duration="${Number(c.duration_sec) > 0 ? Math.ceil(c.duration_sec) : ''}">
                  ${c.thumbnail_path
                    ? `<img data-auth-src="/api/content/${c.id}/thumbnail" alt="">`
                    : c.remote_url
                      ? `<div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </div>`
                      : `<div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </div>`
                  }
                  <div class="assign-content-item-name">${esc(c.filename)}</div>
                </div>
              `).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">Nenhuma mídia enviada ainda</p>`}
            </div>
            <!-- Widgets grid -->
            <div class="assign-content-grid" id="assignWidgets" style="display:none">
              ${widgets.map(w => {
                const icons = {clock:'&#128339;',weather:'&#9925;',rss:'&#128240;',text:'&#128221;',webpage:'&#127760;',social:'&#128172;'};
                return `
                <div class="assign-content-item" data-content-id="${w.id}" data-type="widget">
                  <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary);font-size:32px">
                    ${icons[w.widget_type] || '&#9881;'}
                  </div>
                  <div class="assign-content-item-name">${esc(w.name)}</div>
                </div>`;
              }).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">Nenhum widget criado ainda. <a href="#/widgets" style="color:var(--accent-ink)">Crie um</a></p>`}
            </div>
            <!-- Kiosk grid -->
            <div class="assign-content-grid" id="assignKiosk" style="display:none">
              ${kioskPages.map(k => `
                <div class="assign-content-item" data-content-id="${k.id}" data-type="kiosk">
                  <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary);font-size:32px">&#128433;</div>
                  <div class="assign-content-item-name">${esc(k.name)}</div>
                </div>
              `).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">Nenhuma página de quiosque ainda. <a href="#/kiosk" style="color:var(--accent-ink)">Crie um</a></p>`}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="cancelAssign">Cancelar</button>
            <button class="btn btn-primary" id="confirmAssign">Adicionar selecionados</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      hydrateAuthImages(modal, { eager: true });

      // Tab switching
      modal.querySelectorAll('.assign-tab').forEach(tab => {
        tab.onclick = () => {
          modal.querySelectorAll('.assign-tab').forEach(t => { t.style.borderBottomColor = 'transparent'; t.style.color = 'var(--text-secondary)'; });
          tab.style.borderBottomColor = 'var(--accent-ink)'; tab.style.color = 'var(--accent-ink)';
          document.getElementById('assignMedia').style.display = tab.dataset.tab === 'media' ? '' : 'none';
          document.getElementById('assignWidgets').style.display = tab.dataset.tab === 'widgets' ? '' : 'none';
          document.getElementById('assignKiosk').style.display = tab.dataset.tab === 'kiosk' ? '' : 'none';
        };
      });

      let selectedId = null;
      let selectedType = null;
      // #237: this modal always SENDS a duration, so the server's "default a video to its own
      // length" rule can never fire here — the field has to carry the clip length itself, or
      // picking a 32s video silently assigns a 10s item that cuts off. Anything the operator
      // typed is theirs and is never overwritten.
      const durInput = modal.querySelector('#assignDuration');
      let durationTouched = false;
      durInput?.addEventListener('input', () => { durationTouched = true; });
      modal.querySelectorAll('.assign-content-item').forEach(item => {
        item.addEventListener('click', () => {
          modal.querySelectorAll('.assign-content-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          selectedId = item.dataset.contentId;
          selectedType = item.dataset.type;
          const clip = parseInt(item.dataset.duration || '', 10);
          if (durInput && !durationTouched) durInput.value = clip > 0 ? clip : 10;
        });
      });

      modal.querySelector('#closeAssignModal').onclick = () => modal.remove();
      modal.querySelector('#cancelAssign').onclick = () => modal.remove();
      modal.querySelector('#confirmAssign').onclick = async () => {
        if (!selectedId) {
          showToast('Selecione algo primeiro', 'error');
          return;
        }
        const duration = parseInt(modal.querySelector('#assignDuration').value) || 10;
        const zoneId = modal.querySelector('#assignZone')?.value || null;
        try {
          if (selectedType === 'content') {
            await api.addAssignment(device.id, { content_id: selectedId, duration_sec: duration, zone_id: zoneId });
          } else if (selectedType === 'widget') {
            await api.addAssignment(device.id, { widget_id: selectedId, duration_sec: duration, zone_id: zoneId });
          } else if (selectedType === 'kiosk') {
            // For kiosk pages, create a webpage widget pointing to the kiosk render URL
            const serverUrl = window.location.origin;
            const wRes = await fetch('/api/widgets', {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ widget_type: 'webpage', name: `Quiosque: ${kioskPages.find(k => k.id === selectedId)?.name || 'Page'}`, config: { url: `${serverUrl}/api/kiosk/${selectedId}/render` } })
            });
            const widget = await wRes.json();
            await api.addAssignment(device.id, { widget_id: widget.id, duration_sec: 0 });
          }
          modal.remove();
          showToast('Adicionado à playlist', 'success');
          loadDevice(device.id, 'screen');
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  attachRemoveHandlers(device);
}

function attachRemoveHandlers(device) {
  // Populate zone selectors if device has a layout. The current zone_id for
  // each assignment is read from data-current-zone-id on the .zone-select
  // element (stashed at render time from a.zone_id); no DOM-scraping.
  // Fetch errors are logged - the dropdowns simply stay hidden (display:none
  // is the default from the render), same end-state as before but no longer
  // silent.
  // Inline per-item zone reassign dropdowns. A device WITH a layout always gets them;
  // visibility is NOT gated on whether the zone list arrived (gating on that silently hid
  // the selector when the server payload lacked active_layout_zones — e.g. a stale server
  // during a deploy skew). Only a genuinely fullscreen device (no layout_id) has no zones.
  if (device.layout_id) {
    // Show the selectors immediately; they become usable once zones populate below.
    document.querySelectorAll('.zone-select').forEach(s => { s.style.display = ''; });
    // Clicking an item's orphan warning badge scrolls to + focuses its zone-select.
    document.querySelectorAll('.pl-orphan-warning').forEach(w => {
      w.addEventListener('click', () => {
        const sel = document.querySelector('.zone-select[data-assignment-id="' + w.dataset.orphanAssignment + '"]');
        if (sel) { sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); sel.focus(); }
      });
    });

    const populateZoneSelects = (zones) => {
      const activeIds = new Set((zones || []).map(z => z.id));
      document.querySelectorAll('.zone-select').forEach(select => {
        select.style.display = '';
        while (select.options.length > 1) select.remove(1); // keep the "no zone" placeholder, drop stale options
        const assignmentId = select.dataset.assignmentId;
        const currentZoneId = select.dataset.currentZoneId || '';
        (zones || []).forEach(z => {
          const opt = document.createElement('option');
          opt.value = z.id;
          opt.textContent = z.name;
          select.appendChild(opt);
        });
        const orphan = !!currentZoneId && !activeIds.has(currentZoneId);
        if (currentZoneId && !orphan) select.value = currentZoneId; // can't select a zone the layout lacks
        if (orphan) { select.style.borderColor = 'var(--danger)'; select.style.color = 'var(--danger)'; }
        select.onchange = async () => {
          try {
            await api.updateAssignment(assignmentId, { zone_id: select.value || null });
            showToast('Zona atualizada', 'success');
            loadDevice(device.id, 'screen');
          } catch (err) { showToast(err.message, 'error'); }
        };
      });
    };

    if (device.active_layout_zones && device.active_layout_zones.length) {
      // Fast path: zones already in the device payload — no round-trip.
      populateZoneSelects(device.active_layout_zones);
    } else {
      // Fallback: payload field absent/empty (server/frontend version skew, or a payload
      // change) — fetch the layout so the dropdowns still populate. A missing field must
      // never make the selector silently vanish.
      const token = localStorage.getItem('token');
      fetch(`/api/layouts/${device.layout_id}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(layout => populateZoneSelects(layout.zones || []))
        .catch(e => console.warn('Zone dropdowns: layout fetch fallback failed:', e.message));
    }
  }

  // Mute toggle buttons
  document.querySelectorAll('.mute-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.muteAssignment;
      const currentlyMuted = btn.dataset.muted === '1';
      try {
        await api.updateAssignment(id, { muted: !currentlyMuted });
        showToast(currentlyMuted ? 'Áudio ativado' : 'Silenciado', 'success');
        loadDevice(device.id, 'screen');
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Remove buttons
  document.querySelectorAll('[data-remove-assignment]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.removeAssignment;
      try {
        await api.deleteAssignment(id);
        showToast('Conteúdo removido da playlist', 'success');
        loadDevice(device.id, 'screen');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Drag-and-drop reorder
  const container = document.getElementById('playlistContainer');
  if (!container) return;
  let dragItem = null;

  container.querySelectorAll('.playlist-item[draggable]').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragItem = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      dragItem = null;
      container.querySelectorAll('.playlist-item').forEach(i => i.style.borderTop = '');
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.playlist-item').forEach(i => i.style.borderTop = '');
      if (item !== dragItem) item.style.borderTop = '2px solid var(--accent)';
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.style.borderTop = '';
      if (!dragItem || dragItem === item) return;

      // Get new order
      const items = [...container.querySelectorAll('.playlist-item[data-assignment-id]')];
      const fromIdx = items.indexOf(dragItem);
      const toIdx = items.indexOf(item);
      if (fromIdx < 0 || toIdx < 0) return;

      // Reorder in DOM
      if (fromIdx < toIdx) item.after(dragItem);
      else item.before(dragItem);

      // Get new order of assignment IDs
      const newOrder = [...container.querySelectorAll('.playlist-item[data-assignment-id]')]
        .map(el => parseInt(el.dataset.assignmentId));

      try {
        await api.reorderAssignments(device.id, newOrder);
        showToast('Playlist reordenada', 'success');
        loadDevice(device.id, 'screen');
      } catch (err) {
        showToast(err.message, 'error');
        loadDevice(device.id, 'screen');
      }
    });
  });
}

function renderUptimeTimeline(uptimeData, statusLog = []) {
  const timeline = document.getElementById('uptimeTimeline');
  const percentEl = document.getElementById('uptimePercent');
  if (!timeline) return;

  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const slots = 96; // 15-minute slots over 24 hours
  const slotDuration = 86400 / slots; // 900 seconds = 15 min

  // Build slot status: 'online', 'offline', or 'unknown'
  const slotStatus = new Array(slots).fill('unknown');
  // Parallel array: for offline slots, the {reason, detail} of the covering offline event
  // (why the device was offline) — surfaced in the slot's hover title.
  const slotReason = new Array(slots).fill(null);

  // First pass: mark slots that have heartbeat telemetry as online
  for (const ts of uptimeData) {
    const slotIdx = Math.floor((ts - dayAgo) / slotDuration);
    if (slotIdx >= 0 && slotIdx < slots) slotStatus[slotIdx] = 'online';
  }

  // Second pass: use status log events to paint ranges
  // Walk through events and fill slots between online/offline transitions
  for (let i = 0; i < statusLog.length; i++) {
    const event = statusLog[i];
    const nextEvent = statusLog[i + 1];
    const startSlot = Math.max(0, Math.floor((event.timestamp - dayAgo) / slotDuration));
    const endSlot = nextEvent
      ? Math.min(slots - 1, Math.floor((nextEvent.timestamp - dayAgo) / slotDuration))
      : (event.status === 'online' ? slots - 1 : startSlot);

    const isOnline = event.status === 'online';
    const reason = isOnline ? null : { reason: event.reason || null, detail: event.detail || null };
    for (let s = startSlot; s <= endSlot && s < slots; s++) {
      if (s >= 0) {
        slotStatus[s] = isOnline ? 'online' : 'offline';
        slotReason[s] = reason;
      }
    }
  }

  // Mark future slots as unknown
  const nowSlot = Math.floor((now - dayAgo) / slotDuration);
  for (let i = nowSlot + 1; i < slots; i++) slotStatus[i] = 'unknown';

  // Calculate uptime percentage (only over known slots)
  const knownSlots = slotStatus.filter(s => s !== 'unknown').length;
  const onlineSlots = slotStatus.filter(s => s === 'online').length;
  const uptimePct = knownSlots > 0 ? Math.round((onlineSlots / knownSlots) * 100) : 0;
  if (percentEl) {
    percentEl.textContent = knownSlots > 0
      ? `${uptimePct}% ativo (${knownSlots * 15}min monitorados)`
      : `${uptimePct}% ativo (sem dados)`;
  }

  // Color map
  const colors = {
    online: 'var(--success)',
    offline: 'var(--danger)',
    unknown: 'var(--bg-secondary)'
  };
  const opacities = { online: 0.8, offline: 0.6, unknown: 0.3 };

  // Render bars
  timeline.innerHTML = slotStatus.map((status, i) => {
    const time = new Date((dayAgo + i * slotDuration) * 1000);
    const label = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const statusLabel = status === 'unknown' ? 'Sem dados' : status === 'online' ? 'Online' : 'Offline';
    let title = `${label} - ${statusLabel}`;
    if (status === 'offline' && slotReason[i]) {
      const r = slotReason[i];
      title = `${label} – ${statusLabel} · ${eventLabel(r.reason)}${r.detail ? ` (${r.detail})` : ''}`;
    }
    return `<div style="flex:1;background:${colors[status]};opacity:${opacities[status]}" title="${esc(title)}"></div>`;
  }).join('');
}

// Map an event/reason token to a friendly label via i18n, falling back to the raw
// token if no translation exists. Null → "Unknown cause".
function eventLabel(key) {
  if (!key) return 'Causa desconhecida';
  const full = EVENTO[key];
  return full === ('device.event.' + key) ? key : full;
}

// Dot color by incident type. Amber (#f59e0b) matches the warning accent used
// elsewhere in this view; the rest use the shared CSS vars.
function incidentColor(type) {
  if (type === 'online' || type === 'display_on') return 'var(--success)';
  if (type === 'display_off') return 'var(--text-muted)';
  if (type === 'reboot') return '#f59e0b';
  return 'var(--danger)'; // offline, network, crash, app_error
}

// Compact duration ("4m", "1h 5m", "2d 3h") for an offline period.
function formatDur(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Compact relative time ("2h ago").
function relTime(tsSec, nowSec = Math.floor(Date.now() / 1000)) {
  const diff = Math.max(0, nowSec - tsSec);
  if (diff < 60) return diff + 's ago';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

// "Recent incidents" panel: a newest-first, time-sorted merge of typed device_events
// (display sleep, crash, reboot, network, app_error) with offline→online periods
// derived from the status log (so a device with only server-side offline data still
// shows incidents, and downtime carries a duration).
function renderIncidents(deviceEvents = [], statusLog = []) {
  const panel = document.getElementById('incidentsPanel');
  if (!panel) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const incidents = [];

  // Offline periods from the status log (server-side ground truth). Start a period
  // on each offline transition and close it at the next 'online' row.
  const log = (statusLog || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < log.length; i++) {
    const ev = log[i];
    if (ev.status === 'online') continue;
    // Collapse a repeated offline row (e.g. offline followed by offline_timeout).
    if (i > 0 && log[i - 1].status !== 'online') continue;
    let end = null;
    for (let j = i + 1; j < log.length; j++) {
      if (log[j].status === 'online') { end = log[j].timestamp; break; }
    }
    incidents.push({
      type: 'offline',
      reason: ev.reason || null,
      detail: ev.detail || null,
      timestamp: ev.timestamp,
      durationSec: (end != null ? end : nowSec) - ev.timestamp,
      ongoing: end == null,
    });
  }

  // Typed incidents from device_events. offline/online are already represented as
  // periods above, so skip them here to avoid double-listing the same event.
  for (const ev of (deviceEvents || [])) {
    if (!ev || ev.type === 'offline' || ev.type === 'online') continue;
    incidents.push({
      type: ev.type,
      reason: ev.reason || null,
      detail: ev.detail || null,
      timestamp: ev.timestamp,
    });
  }

  if (!incidents.length) {
    panel.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">Nenhuma ocorrência registrada</div>`;
    return;
  }

  incidents.sort((a, b) => b.timestamp - a.timestamp);

  panel.innerHTML = incidents.slice(0, 15).map(inc => {
    const label = eventLabel(inc.reason || inc.type);
    const detail = inc.detail
      ? `<span style="color:var(--text-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(inc.detail)}</span>`
      : '';
    const dur = (inc.durationSec != null)
      ? `<span style="color:var(--text-muted);font-size:11px;flex:none">${esc(`fora por ${formatDur(inc.durationSec)}` + (inc.ongoing ? '…' : ''))}</span>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span title="${esc(eventLabel(inc.type))}" style="flex:none;width:9px;height:9px;border-radius:50%;background:${incidentColor(inc.type)}"></span>
        <span style="font-weight:600;color:var(--text-primary);flex:none">${esc(label)}</span>
        ${detail}
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;flex:none">
          ${dur}
          <span style="color:var(--text-muted);font-size:11px">${esc(relTime(inc.timestamp, nowSec))}</span>
        </span>
      </div>`;
  }).join('');
}

function updateTelemetryDisplay(telemetry) {
  const update = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  if (telemetry.battery_level != null) update('telBattery', telemetry.battery_level + '%');
  if (telemetry.storage_free_mb) update('telStorage', `${formatBytes(telemetry.storage_free_mb)} livres`);
  if (telemetry.wifi_ssid !== undefined) update('telWifi', wifiSubLabel(telemetry.wifi_ssid));
  if (telemetry.local_ip) update('telLocalIp', telemetry.local_ip);
  // update() no-ops when the card is absent, which is the case for a v4-only panel — a screen that
  // acquires a v6 address mid-session picks the card up on the next full render, not this path.
  if (telemetry.local_ip6) update('telLocalIp6', telemetry.local_ip6);
  // wifi_rssi is deliberately not displayed: "-66 dBm" tells an operator nothing, and the one
  // moment it matters — a screen that drops every afternoon — is an investigation, not a glance.
  // It keeps being reported and still reaches the live debug log, which is where that hunt starts.
  if (telemetry.uptime_seconds) update('telUptime', formatUptime(telemetry.uptime_seconds));
  if (telemetry.ram_free_mb) update('telRam', `${formatBytes(telemetry.ram_free_mb)} livres`);
  if (telemetry.cpu_usage != null) update('telCpu', telemetry.cpu_usage.toFixed(1) + '%');
}

// ----- diag-smoothness widget: show the frame stats it reports from the panel -----
function renderDiagPanel(w) {
  return `
    <div class="info-card" id="diagCard" style="grid-column:1/-1;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div class="info-card-label">Frame-rate diagnostic${w.widget_name ? ' · ' + esc(w.widget_name) : ''}</div>
        <span id="diagVerdict" style="font-weight:700;font-size:15px;color:var(--text-muted)">waiting for panel…</span>
      </div>
      <div class="info-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:10px">
        <div class="info-card"><div class="info-card-label">FPS</div><div class="info-card-value" id="diagFps">--</div></div>
        <div class="info-card"><div class="info-card-label">Refresh</div><div class="info-card-value" id="diagHz">--</div></div>
        <div class="info-card"><div class="info-card-label">Long frames</div><div class="info-card-value" id="diagLong">--</div></div>
        <div class="info-card"><div class="info-card-label">Worst stall</div><div class="info-card-value" id="diagWorst">--</div></div>
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text-muted)" id="diagMeta">The panel running this widget reports its frame timing here every few seconds.</div>
      <div style="margin-top:6px;font-size:12px;color:var(--danger);font-family:ui-monospace,Menlo,monospace" id="diagStalls"></div>
    </div>`;
}

function startDiagPoll(widgetId, deviceId) {
  if (diagPollTimer) clearInterval(diagPollTimer);
  const url = `/api/widgets/${encodeURIComponent(widgetId)}/telemetry?device=${encodeURIComponent(deviceId)}`;
  const tick = async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      updateDiagPanel(res.ok ? await res.json() : null);
    } catch (e) { /* transient — keep last shown */ }
  };
  tick();
  diagPollTimer = setInterval(tick, 2500);
}

function updateDiagPanel(d) {
  const v = document.getElementById('diagVerdict');
  if (!v) { if (diagPollTimer) { clearInterval(diagPollTimer); diagPollTimer = null; } return; } // navigated away
  const set = (id, val, color) => { const el = document.getElementById(id); if (el) { el.textContent = val; if (color) el.style.color = color; } };
  if (!d) {
    v.textContent = 'no report yet'; v.style.color = 'var(--text-muted)';
    set('diagMeta', 'No data received yet — make sure the panel is showing this widget, then give it a few seconds.');
    return;
  }
  const age = d.receivedAt ? Math.max(0, Math.round((Date.now() - d.receivedAt) / 1000)) : null;
  const stale = age != null && age > 15;
  const verdict = d.verdict || 'measuring';
  const vcolor = verdict === 'SMOOTH' ? 'var(--success)' : (verdict === 'STALLING' ? 'var(--danger)' : 'var(--text-muted)');
  // If we haven't heard from THIS panel recently, say so plainly rather than showing stale numbers as live.
  if (stale) { v.textContent = 'no live report'; v.style.color = 'var(--text-muted)'; }
  else { v.textContent = verdict; v.style.color = vcolor; }
  set('diagFps', d.fps != null ? String(d.fps) : '--');
  set('diagHz', d.refreshHz != null ? d.refreshHz + ' Hz' : '--');
  set('diagLong', d.longFrames != null ? String(d.longFrames) : '--', d.longFrames > 0 ? 'var(--danger)' : 'var(--success)');
  set('diagWorst', d.worstStallMs != null ? d.worstStallMs + ' ms' : '--', d.worstStallMs > 50 ? 'var(--danger)' : 'var(--text-primary)');
  const meta = [];
  if (d.vp) meta.push('viewport ' + d.vp);
  if (d.dpr) meta.push('dpr ' + d.dpr);
  if (d.elapsedS != null) meta.push('running ' + d.elapsedS + 's');
  if (age != null) meta.push('last report ' + age + 's ago');
  set('diagMeta', meta.join(' · '));
  set('diagStalls', Array.isArray(d.recent) && d.recent.length ? ('recent stalls: ' + d.recent.join('   ')) : '');
}

export function cleanup() {
  if (diagPollTimer) { clearInterval(diagPollTimer); diagPollTimer = null; }
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  if (logHandler) off('device-log', logHandler);
  if (shellHandler) off('shell-result', shellHandler);   // #161 owner-tools listener
  if (screenshotInterval) clearInterval(screenshotInterval);
  if (remoteActive && currentDevice) stopRemote(currentDevice.id);
  // Same reasoning as stopRemote above: an operator who navigates away has stopped watching, so
  // the display should stop talking. Must run BEFORE currentDevice is cleared.
  if (debugStreamOn && currentDevice) sendCommand(currentDevice.id, 'set_debug', { enabled: false });
  debugStreamOn = false;
  debugFrozen = false;
  debugHeld = [];
  remoteActive = false;
  currentDevice = null;
  window._sendKey = null;
}
