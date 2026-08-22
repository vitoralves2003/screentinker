import { api } from '../api.js';
import { on, off, sendCommand } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc, livenessBadge, isPlatformAdmin } from '../utils.js';
import { t, tn } from '../i18n.js';
import { createSelection, selectCell, wireSelection, renderBulkBar, runEach } from '../bulk-select.js';
import * as gettingStarted from '../components/getting-started.js';
import { showDeviceOwnerQRModal } from '../components/device-owner-qr-modal.js';

const DESTRUCTIVE_COMMANDS = ['reboot', 'shutdown'];
// Command types only — labels resolved through t('dashboard.cmd.<type>')
/*
 * Every bulk command, and the capability a screen needs to honour it.
 *
 * The list used to be unconditional, and three of the six were no-ops on this fleet: screen_off
 * needs device-admin FORCE_LOCK or the accessibility service, and reboot/shutdown need device
 * owner. Nobody has either. The panel logged "unsupported on this panel" and the dashboard said
 * "command sent" — a button that lies is worse than a button that is missing, because the
 * operator concludes the screen is broken rather than the feature absent.
 *
 * The per-screen buttons on the device page have gated on capabilities all along; this simply
 * makes the multi-select agree with them. Capability names mirror COMMAND_CAPABILITY in
 * server/lib/player-capabilities.js, which is the source of truth — change it there first.
 */
const GROUP_COMMANDS = [
  { type: 'screen_on', cap: 'display.power' },
  { type: 'screen_off', cap: 'display.power' },
  { type: 'launch', cap: 'system.restart_player' },
  { type: 'update', cap: 'system.self_update' },
  { type: 'reboot', cap: 'system.reboot', destructive: true },
  { type: 'shutdown', cap: 'system.reboot', destructive: true },
];

/*
 * Which commands to offer for a selection: those at least ONE selected screen can honour.
 *
 * Any-not-all is the deliberate choice. A mixed selection of ten panels where one is a device
 * owner should still offer reboot — it does something real — and sendCommand is already a no-op
 * on a panel that cannot take it. Requiring all would hide working commands behind the least
 * capable screen in the list.
 *
 * A device with no capabilities array at all is a pre-capability server talking to us; it gets
 * everything, exactly as device-detail.js does for the same reason.
 */
function commandsForSelection(ids) {
  const chosen = lastDevices.filter((d) => ids.includes(d.id));
  if (!chosen.length) return GROUP_COMMANDS;
  if (chosen.some((d) => !Array.isArray(d.capabilities))) return GROUP_COMMANDS;
  const union = new Set(chosen.flatMap((d) => d.capabilities));
  return GROUP_COMMANDS.filter((c) => union.has(c.cap));
}
const CMD_LABEL_KEY = {
  screen_on: 'dashboard.cmd.screen_on',
  screen_off: 'dashboard.cmd.screen_off',
  launch: 'dashboard.cmd.restart_app',
  update: 'dashboard.cmd.check_update',
  reboot: 'dashboard.cmd.reboot',
  shutdown: 'dashboard.cmd.shutdown',
};

let statusHandler = null;
let refreshInterval = null;
let playbackHandler = null;
let progressTickInterval = null;
let wallChangedHandler = null;
// device_id -> { content_name, duration_sec, started_at }
const playbackByDevice = new Map();
/*
 * One selection for the fleet list, shared with the content library and playlists through
 * bulk-select.js. It began life as the "pick screens for a video wall" gesture; the wall is now
 * one action among several that the same ticks can drive.
 */
const devSel = createSelection();
const selectedDeviceIds = devSel.ids;

// The last playlists fetched, so the bulk bar can offer them without a round trip on every tick.
let lastPlaylists = [];
let lastDevices = [];

function formatTimeAgo(timestamp) {
  if (!timestamp) return t('common.never');
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return t('common.just_now');
  if (seconds < 3600) return t('common.minutes_ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('common.hours_ago', { n: Math.floor(seconds / 3600) });
  return t('common.days_ago', { n: Math.floor(seconds / 86400) });
}

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function renderProgressFor(deviceId) {
  const state = playbackByDevice.get(deviceId);
  document.querySelectorAll(`#progress-${CSS.escape(deviceId)}`).forEach(el => {
    if (!state) {
      el.style.display = 'none';
      const idle = el.parentElement?.querySelector('[data-now-idle]');
      if (idle) idle.style.display = '';
      return;
    }
    const elapsed = Math.max(0, (Date.now() - state.started_at) / 1000);
    const name = state.content_name || '';
    const fill = el.querySelector('.device-card-progress-fill');
    const nameEl = el.querySelector('.dcp-name');
    const timeEl = el.querySelector('.dcp-time');
    if (state.duration_sec && state.duration_sec > 0) {
      const remaining = Math.max(0, Math.ceil(state.duration_sec - elapsed));
      const pct = Math.min(100, (elapsed / state.duration_sec) * 100);
      fill.style.width = pct + '%';
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = remaining + 's';
    } else {
      // Unknown duration (e.g. video plays to end) — show indeterminate state
      fill.style.width = '100%';
      fill.classList.add('indeterminate');
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = '';
    }
    const idle = el.parentElement?.querySelector('[data-now-idle]');
    if (idle) idle.style.display = 'none';
    el.style.display = '';
  });
}

/*
 * One screen, one row.
 *
 * WHAT REPLACES THE PREVIEW. The thumbnail answered "is something on screen" with a picture too
 * small to read, and cost a capture request per panel every 30 seconds for the whole time the page
 * was open. The row answers the same question in words — the NAME of what is playing and how long
 * is left — which is both legible and free: it rides on the playback-progress event the panels
 * already send.
 */
/*
 * The state, as one phrase: what it is, for how long, and why.
 *
 * The elapsed time is deliberately absent for a healthy screen — "Agora mesmo" is what it always
 * says, so it earns nothing. It appears exactly when it starts to matter.
 */
function stateText(device, badge) {
  const b = badge || livenessBadge(device, { short: true });
  const hb = Number(device.last_heartbeat) || 0;
  const elapsed = hb ? Math.floor(Date.now() / 1000 - hb) : 0;
  const since = (b.state === 'offline' || b.state === 'degraded') && elapsed >= 60
    ? ' ' + formatTimeAgo(hb)
    : '';
  return b.base + since + (b.sub ? ' · ' + b.sub : '');
}

/* The state cell's innards, shared with the socket handler that repaints it live. */
function stateCellHtml(device, badge) {
  const b = badge || livenessBadge(device, { short: true });
  return `<span class="row-state ${b.state}" data-liveness="${b.state}" data-offline-reason="${esc(b.reason)}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(stateText(device, b))}</span>`;
}

function renderDeviceRow(device) {
  const b = livenessBadge(device, { short: true });
  const signals = [
    device.battery_level !== null && device.battery_level !== undefined ? `${device.battery_level}%` : null,
    device.wifi_rssi ? `${device.wifi_rssi} dBm` : null,
    device.storage_free_mb ? formatBytes(device.storage_free_mb) : null,
  ].filter(Boolean);

  return `
    <tr class="device-row" draggable="true" data-row-state="${b.state}" data-last-heartbeat="${device.last_heartbeat || ''}" data-device-id="${device.id}" data-device-name="${esc(device.name)}">
      ${selectCell(devSel, device.id)}
      <td>
        <div class="list-name">
          <span class="list-name-main is-clickable">${esc(device.name)}</span>
          ${device.orphan_count > 0 ? `
          <span class="device-orphan-badge" title="${esc(tn('dashboard.device_orphan_tip', device.orphan_count))}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--danger)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${device.orphan_count}
          </span>` : ''}
          ${device.ota_status === 'manual_update_required' ? `
          <span class="device-ota-badge" title="${esc(t('dashboard.device_ota_stuck', { version: device.ota_target_version || '?', n: device.ota_attempts || 0 }))}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--warning)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>update
          </span>` : ''}
        </div>
        ${device.owner_name || device.owner_email
          ? `<div class="list-sub">${esc(device.owner_name || device.owner_email)}</div>` : ''}
      </td>
      <td class="col-state">
        ${stateCellHtml(device, b)}
        ${device.status === 'provisioning' && device.pairing_code
          ? `<span class="pairing-code-inline">${esc(device.pairing_code)}</span>` : ''}
      </td>
      <td class="col-now">
        <span class="list-muted" data-now-idle>&mdash;</span>
        <div class="device-card-progress" id="progress-${device.id}" style="display:none">
          <div class="device-card-progress-label"><span class="dcp-name"></span><span class="dcp-time"></span></div>
          <div class="device-card-progress-track"><div class="device-card-progress-fill"></div></div>
        </div>
      </td>
      <td class="col-playlist">${device.playlist_name
        ? `<span class="list-chip">${esc(device.playlist_name)}</span>`
        : `<span class="list-muted">${esc(t('device.playlist.no_playlist'))}</span>`}</td>
      <td class="col-signals num">${signals.length
        ? esc(signals.join(' · '))
        : `<span class="list-muted">--</span>`}</td>
    </tr>
  `;
}

/*
 * The table around a set of rows. Every group renders its own, so a group's devices stay under
 * their heading — the alternative, one table for the fleet with a group column, loses the
 * drag-a-screen-into-a-group gesture the page is built around.
 */
function renderDeviceTable(devices) {
  return `
    <div class="list-table-wrap">
      <table class="list-table">
        <thead>
          <tr>
            <th class="bulk-cell">
              <input type="checkbox" class="bulk-check-all" aria-label="${esc(t('bulk.select_all_visible'))}">
            </th>
            <th>${esc(t('dashboard.col_name'))}</th>
            <th>${esc(t('dashboard.col_state'))}</th>
            <th class="col-now">${esc(t('dashboard.col_now_playing'))}</th>
            <th class="col-playlist">${esc(t('dashboard.col_playlist'))}</th>
            <th class="col-signals num">${esc(t('dashboard.col_signals'))}</th>
          </tr>
        </thead>
        <tbody class="device-tbody">${devices.map(renderDeviceRow).join('')}</tbody>
      </table>
    </div>
  `;
}

function renderWallCard(wall) {
  // Compose a tiny grid preview using the wall's actual cols×rows. Each cell
  // is filled (assigned) or hollow (empty slot).
  const cells = [];
  for (let r = 0; r < wall.grid_rows; r++) {
    for (let c = 0; c < wall.grid_cols; c++) {
      const dev = (wall.devices || []).find(d => d.grid_col === c && d.grid_row === r);
      cells.push(`<div class="wall-card-cell${dev ? ' filled' : ''}" title="${dev ? esc(dev.device_name) : '[' + c + ',' + r + ']'}"></div>`);
    }
  }
  const members = wall.devices || [];
  const onlineCount = members.filter(d => d.device_status === 'online').length;
  const allUp = onlineCount === members.length && members.length > 0;
  return `
    <div class="device-card wall-card" data-wall-id="${wall.id}" onclick="window.location.hash='#/wall/${wall.id}'">
      <div class="device-card-preview wall-card-preview">
        <div class="wall-card-grid" style="grid-template-columns:repeat(${wall.grid_cols},1fr);grid-template-rows:repeat(${wall.grid_rows},1fr)">${cells.join('')}</div>
        <div class="device-card-status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
          <span>${wall.grid_cols}×${wall.grid_rows} wall</span>
        </div>
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(wall.name)}</div>
        <div class="device-card-meta">
          <div class="meta-item">${members.length} ${members.length === 1 ? 'tile' : 'tiles'}</div>
          <div class="meta-item" style="color:${allUp ? 'var(--success)' : 'var(--danger, #e5484d)'}">${allUp ? 'all online' : `${onlineCount}/${members.length} online`}</div>
        </div>
        <!-- #235: a wall replaces its members' cards, so without this strip one dead panel of a
             four-panel wall is invisible from the dashboard. Each chip links straight to the
             device page — being in a wall must not cost device-level visibility. -->
        <div class="wall-card-members" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">
          ${members.map(d => `
            <a class="wall-card-member" href="#/device/${esc(d.device_id)}" data-member-device-id="${esc(d.device_id)}" onclick="event.stopPropagation()"
               title="${esc(d.device_name)} — ${esc(d.device_status || 'unknown')}. Open device info & controls"
               style="display:inline-flex;align-items:center;gap:4px;max-width:120px;padding:1px 6px;border:1px solid var(--border);border-radius:10px;font-size:10px;color:var(--text-secondary);text-decoration:none">
              <span class="status-dot ${esc(d.device_status || 'offline')}" style="display:inline-block;flex-shrink:0"></span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.device_name)}</span>
            </a>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function getGroupPlaylistLabel(devices, playlists) {
  const playlistMap = new Map((playlists || []).map(p => [p.id, p]));
  const assigned = devices.filter(d => d.playlist_id).map(d => d.playlist_id);
  if (assigned.length === 0) return '';
  const unique = [...new Set(assigned)];
  if (unique.length === 1) {
    const pl = playlistMap.get(unique[0]);
    return pl ? esc(pl.name) : t('dashboard.unknown_playlist');
  }
  return t('dashboard.mixed_playlists');
}

function renderGroupSection(group, devices, playlists) {
  const onlineCount = devices.filter(d => d.status === 'online').length;
  const playlistLabel = getGroupPlaylistLabel(devices, playlists);
  return `
    <div class="group-section" data-group-id="${group.id}" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid ${esc(group.color || '#3B82F6')}">
        <div style="display:flex;align-items:center;gap:10px">
          <strong style="font-size:15px">${esc(group.name)}</strong>
          <span style="color:var(--text-muted);font-size:12px">${tn('dashboard.devices_count', devices.length)} &middot; ${t('dashboard.online_count', { n: onlineCount })}</span>
          ${playlistLabel ? `<span style="font-size:11px;color:var(--text-secondary);background:var(--bg-primary);padding:2px 8px;border-radius:10px">${t('dashboard.playlist_label', { name: playlistLabel })}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${devices.length > 0 ? `
          <select class="input group-playlist-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" style="width:160px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.set_playlist_placeholder')}</option>
            ${(playlists || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('dashboard.draft_suffix') : ''}</option>`).join('')}
          </select>
          <select class="input group-cmd-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" data-device-count="${devices.length}" style="width:150px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.send_command_placeholder')}</option>
            ${GROUP_COMMANDS.map(c => `<option value="${c.type}" ${c.destructive ? 'style="color:var(--danger)"' : ''}>${t(CMD_LABEL_KEY[c.type])}</option>`).join('')}
          </select>
          ` : ''}
          ${devices.length > 0 ? `
          <label class="group-sync-label" style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);cursor:pointer;white-space:nowrap" title="${esc(t('dashboard.group_sync.hint'))}">
            <input type="checkbox" class="group-sync-cb" data-group-id="${group.id}" ${group.sync_enabled ? 'checked' : ''}> ${t('dashboard.group_sync.label')}
          </label>
          ${group.sync_enabled ? `
          <select class="input group-backend-select" data-group-id="${group.id}" style="width:130px;padding:4px 8px;font-size:12px;background:var(--bg-input)" title="${esc(t('dashboard.group_sync.backend_hint'))}">
            <option value="auto" ${(group.sync_backend || 'auto') === 'auto' ? 'selected' : ''}>${t('dashboard.group_sync.backend_auto')}</option>
            <option value="screentinker" ${group.sync_backend === 'screentinker' ? 'selected' : ''}>${t('dashboard.group_sync.backend_screentinker')}</option>
            <option value="brightsign" ${group.sync_backend === 'brightsign' ? 'selected' : ''}>${t('dashboard.group_sync.backend_brightsign')}</option>
          </select>
          ${group.sync_effective ? `
          <span style="font-size:11px;color:${group.sync_downgraded ? 'var(--warning, #d97706)' : 'var(--text-muted)'};white-space:nowrap"
                title="${esc(group.sync_reason || '')}">${group.sync_downgraded ? '&#9888; ' : ''}${esc(group.sync_effective)}${group.sync_reason ? ' — ' + esc(group.sync_reason) : ''}</span>` : ''}
          <button class="btn group-resync-btn" data-group-id="${group.id}" style="padding:4px 10px;font-size:12px" title="${esc(t('dashboard.group_sync.resync_hint'))}">${t('dashboard.group_sync.resync')}</button>` : ''}
          ` : ''}
          <button class="btn" data-group-manage="${group.id}" style="padding:4px 10px;font-size:12px" title="${t('dashboard.manage_tooltip')}">${t('dashboard.manage')}</button>
          <button class="btn" data-group-delete="${group.id}" style="padding:4px 8px;font-size:12px;color:var(--danger)" title="${t('dashboard.delete_group_tooltip')}">&#x2715;</button>
        </div>
      </div>
      <div class="device-list-wrap">
        ${devices.length > 0 ? renderDeviceTable(devices) : `<div style="color:var(--text-muted);font-size:13px;padding:8px 12px">${t('dashboard.no_devices_in_group')}</div>`}
      </div>
    </div>
  `;
}

/*
 * Asks, once, whether this install will share its screen count. Only a platform admin sees it,
 * and only while the decision is genuinely unmade — BOTH answers persist, so it never returns
 * after an update. Re-prompting is how telemetry earns its reputation and gets patched out.
 */
async function renderStatsPrompt(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) return;

  let info;
  try { info = await api.adminGetTelemetry(); } catch { return; }
  if (info.state !== 'unasked') return;

  const el = document.createElement('div');
  el.className = 'settings-section';
  el.style.cssText = 'margin-bottom:16px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap';
  el.innerHTML = `
    <div style="flex:1;min-width:260px">
      <strong>Help show how widely Loop Player is deployed?</strong>
      <p style="color:var(--text-muted);font-size:13px;margin:6px 0 0">
        Because most installs are private, we can't tell how many screens are out there. Sharing
        sends a random ID, the version, and how many screens you run — nothing else, ever.
        You can change this any time in Settings.
      </p>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="statsYes">Share</button>
      <button class="btn btn-secondary btn-sm" id="statsNo">No thanks</button>
    </div>
  `;
  container.prepend(el);

  const answer = async (enabled) => {
    try { await api.adminSetTelemetry(enabled); } catch { /* leave it unasked; it can ask again later */ return; }
    el.remove();
    if (enabled) showToast('Thank you — sharing install statistics', 'success');
  };
  el.querySelector('#statsYes').addEventListener('click', () => answer(true));
  el.querySelector('#statsNo').addEventListener('click', () => answer(false));
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('dashboard.title')}</h1>
        <div class="subtitle">${t('dashboard.subtitle')}</div>
      </div>
      <div>
        <button class="btn btn-primary" id="addDeviceBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          ${t('dashboard.add')}
        </button>
      </div>
    </div>
    <div id="selectionBar" style="display:none"></div>
    <div id="gettingStarted"></div>
      <!-- The Total / Online / Offline cards moved to Operação, the page the app now opens on.
           They sat directly above a list that shows the same thing row by row, and a number
           repeated next to its own detail is a number nobody reads. -->
    <div class="list-toolbar">
      <input type="text" id="deviceSearch" class="input list-toolbar-search" placeholder="${t('dashboard.search')}">
      <select id="deviceFilter" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <!-- Four states, four options. It offered six: three states plus a sub-group breaking
             Offline down by manner of death. The REASON is still shown on the row and in its
             tooltip, which is where it helps — deciding whether to drive out or restart from
             here. As a filter it asked the operator to classify a fault before they had looked
             at it. -->
        <option value="">${t('dashboard.all_status')}</option>
        <option value="healthy">${t('device.liveness.healthy')}</option>
        <option value="idle">${t('device.liveness.idle')}</option>
        <option value="awaiting">${t('device.liveness.awaiting')}</option>
        <option value="offline">${t('device.liveness.offline')}</option>
      </select>
      <span id="deviceResultCount" class="list-toolbar-count"></span>
      <div class="list-toolbar-end">
        <button class="btn btn-secondary btn-sm" id="createGroupBtn">${t('dashboard.create_group')}</button>
      </div>
    </div>
    <div id="groupedDevices"></div>
  `;

  const addBtn = container.querySelector('#addDeviceBtn');
  addBtn.addEventListener('click', () => {
    document.getElementById('addDeviceModal').style.display = 'flex';
    document.getElementById('pairingCodeInput').value = '';
    document.getElementById('deviceNameInput').value = '';
    document.getElementById('pairingCodeInput').focus();

  });

  // #device-owner: provision a fresh/factory-reset Android panel straight from Add Display.
  document.getElementById('deviceOwnerQrBtn')?.addEventListener('click', () => showDeviceOwnerQRModal());

  // Search and filter
  document.getElementById('deviceSearch').oninput = () => filterDevices();
  document.getElementById('deviceFilter').onchange = () => filterDevices();

  function filterDevices() {
    const search = document.getElementById('deviceSearch').value.toLowerCase();
    /*
     * Matched against the liveness STATE carried in data-liveness, never the badge TEXT — the
     * label is translated and reads "Ocioso"/"Offline", so comparing text once matched nothing
     * and emptied the whole list.
     *
     * The offline:<reason> drill-in went with the options that produced it. The reason is still on
     * the row and in its tooltip, which is where it helps: deciding whether to drive out or
     * restart from here. As a filter it asked the operator to classify a fault before looking at
     * it. `degraded` is still matched by the amber option because an older server emits that name
     * for the same state.
     */
    const filter = document.getElementById('deviceFilter').value;    // '' | healthy | idle | awaiting | offline
    document.querySelectorAll('.device-row').forEach(card => {
      const name = card.querySelector('.list-name-main')?.textContent.toLowerCase() || '';
      const el = card.querySelector('.col-state [data-liveness]');
      const raw = el?.dataset.liveness || '';
      const cardState = raw === 'degraded' ? 'idle' : raw;
      const matchSearch = !search || name.includes(search);
      const matchState = !filter || cardState === filter;
      card.style.display = (matchSearch && matchState) ? '' : 'none';
    });
    // Hide a group whose every screen was filtered out, rather than leaving a heading over an
    // empty table — and re-derive the shift-click range from what is left on screen.
    document.querySelectorAll('.list-table-wrap').forEach(wrap => {
      const rows = [...wrap.querySelectorAll('.device-row')];
      const section = wrap.closest('.group-section, .ungrouped-section');
      if (section) section.style.display = rows.some(r => r.style.display !== 'none') ? '' : 'none';
    });
    const shown = document.querySelectorAll('.device-row:not([style*="display: none"])').length;
    const total = document.querySelectorAll('.device-row').length;
    const countEl = document.getElementById('deviceResultCount');
    if (countEl) countEl.textContent = shown === total ? '' : t('bulk.showing', { shown, total });
    refreshSelectionOrder();
    syncRowChecks();
  }

  // Setup pairing
  const pairBtn = document.getElementById('pairDeviceBtn');
  pairBtn.onclick = async () => {
    const code = document.getElementById('pairingCodeInput').value.trim();
    const name = document.getElementById('deviceNameInput').value.trim();
    if (!code || code.length !== 6) {
      showToast(t('dashboard.error_pairing_code'), 'error');
      return;
    }
    try {
      await api.pairDevice(code, name || undefined);
      document.getElementById('addDeviceModal').style.display = 'none';
      showToast(t('dashboard.toast.display_paired'), 'success');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Create group
  container.querySelector('#createGroupBtn').addEventListener('click', async () => {
    const name = prompt(t('dashboard.prompt_group_name'));
    if (!name) return;
    try {
      await api.createGroup(name);
      showToast(t('dashboard.toast.group_created'), 'success');
      loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });

  /*
   * Selection is wired per render (loadDashboard), because the tables are rebuilt each time. What
   * stays here is only the row click: opening a screen. The checkbox cell stops propagation, so
   * ticking never navigates.
   */

  container.addEventListener('click', (ev) => {
    const row = ev.target.closest?.('.device-row');
    if (!row || ev.target.closest('.bulk-cell')) return;
    window.location.hash = '/device/' + row.dataset.deviceId;
  });

  // Load everything
  loadDashboard();

  // Ask once about sharing install statistics. Fire-and-forget: it prepends itself if and only
  // if the decision is still unmade, and a failure here must never affect the dashboard.
  renderStatsPrompt(container).catch(() => {});

  // Real-time updates
  statusHandler = (data) => {
    const b = livenessBadge(data, { short: true }); // list = concise label; tooltip carries the full text
    const cards = document.querySelectorAll(`[data-device-id="${data.device_id}"]`);
    cards.forEach(card => {
      const statusEl = card.querySelector('.col-state');
      // The event carries no heartbeat, so keep the one the row already knows: a screen that just
      // went down must not lose the "há 12h" it was showing a second ago.
      if (statusEl) {
        statusEl.innerHTML = stateCellHtml(
          { ...data, last_heartbeat: data.last_heartbeat || card.dataset.lastHeartbeat }, b);
      }
      if (card.classList.contains('device-row')) card.dataset.rowState = b.state;
    });
    // #235: a wall member has no card of its own, only a chip on the wall card. Without this a
    // panel could go offline and the dashboard would keep showing it green until a full reload —
    // exactly the blind spot the issue is about.
    document.querySelectorAll(`.wall-card-member[data-member-device-id="${CSS.escape(data.device_id)}"]`).forEach(chip => {
      const dot = chip.querySelector('.status-dot');
      if (dot) dot.className = `status-dot ${b.state}`;
      chip.title = `${chip.title.split(' — ')[0]} — ${b.label}. Open device info & controls`;
    });
  };

  const deviceAddedHandler = () => loadDashboard();
  const deviceRemovedHandler = () => loadDashboard();

  playbackHandler = (data) => {
    if (!data?.device_id) return;
    playbackByDevice.set(data.device_id, {
      content_name: data.content_name || '',
      duration_sec: data.duration_sec || null,
      started_at: data.started_at || Date.now(),
    });
    renderProgressFor(data.device_id);
  };

  wallChangedHandler = () => loadDashboard();

  on('device-status', statusHandler);
  on('device-added', deviceAddedHandler);
  on('device-removed', deviceRemovedHandler);
  on('playback-progress', playbackHandler);
  on('wall-changed', wallChangedHandler);

  progressTickInterval = setInterval(() => {
    for (const id of playbackByDevice.keys()) renderProgressFor(id);
  }, 1000);

  /*
   * NOT polled any more. The card carried a live thumbnail, which meant asking every panel in the
   * fleet for a fresh capture every 30 seconds for as long as anyone had this page open — a
   * standing cost on the panels and the server to render a picture too small to read. What is
   * playing now arrives on the playback-progress event instead, which the panels already send.
   */
}

/*
 * Bulk actions for the fleet.
 *
 * Selection used to exist here for exactly one gesture — make a video wall — which meant ticking
 * three screens and then having to visit each one to point it at a playlist. The same ticks now
 * carry the operations an operator actually repeats: assign a playlist, send a command, delete.
 *
 * The wall button appears only at two or more, rather than sitting greyed out: a disabled control
 * with a tooltip is a worse explanation than a control that arrives when it becomes possible.
 */
function renderDeviceBulkBar() {
  const bar = document.getElementById('selectionBar');
  const n = devSel.ids.size;

  const actions = [
    {
      id: 'playlist',
      html: () => `<select class="input" id="bulkPlaylistSelect" style="width:180px;padding:5px 8px;font-size:12px;background:var(--bg-input)">
          <option value="">${esc(t('dashboard.set_playlist_placeholder'))}</option>
          ${lastPlaylists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + esc(t('dashboard.draft_suffix')) : ''}</option>`).join('')}
        </select>`,
      wire: (root, ids) => {
        const sel = root.querySelector('#bulkPlaylistSelect');
        if (!sel) return;
        sel.onchange = async () => {
          const playlistId = sel.value;
          if (!playlistId) return;
          sel.disabled = true;
          const { ok, failed } = await runEach(ids, (id) => api.updateDevice(id, { playlist_id: playlistId }));
          showToast(failed.length ? t('bulk.partial', { ok, fail: failed.length })
            : tn('dashboard.toast.playlist_assigned', ok), failed.length ? 'error' : 'success');
          devSel.ids.clear();
          loadDashboard();
        };
      },
    },
    {
      id: 'command',
      // Nothing renders when the selection can honour nothing — an empty dropdown is a puzzle,
      // and this is the same rule the wall button already follows two actions down.
      // renderBulkBar hands html() the COUNT, not the ids, so the selection is read from devSel
      // here rather than widening a component four other pages share.
      html: () => {
        const cmds = commandsForSelection([...devSel.ids]);
        if (!cmds.length) return '';
        return `<select class="input" id="bulkCommandSelect" style="width:170px;padding:5px 8px;font-size:12px;background:var(--bg-input)">
          <option value="">${esc(t('dashboard.send_command_placeholder'))}</option>
          ${cmds.map(c => `<option value="${c.type}">${esc(t(CMD_LABEL_KEY[c.type]))}</option>`).join('')}
        </select>`;
      },
      wire: (root, ids) => {
        const sel = root.querySelector('#bulkCommandSelect');
        if (!sel) return;
        sel.onchange = () => {
          const type = sel.value;
          if (!type) return;
          const label = t(CMD_LABEL_KEY[type] || type);
          // Reboot and shutdown ask first. The count is in the question because "reboot the
          // selection" is only alarming once you know the selection is the whole fleet.
          if (DESTRUCTIVE_COMMANDS.includes(type)
              && !confirm(t('dashboard.confirm_destructive_selection', { cmd: label.toUpperCase(), n: ids.length }))) {
            sel.value = '';
            return;
          }
          for (const id of ids) sendCommand(id, type);
          showToast(t('dashboard.toast.command_sent', { cmd: label, sent: ids.length, total: ids.length }), 'success');
          sel.value = '';
        };
      },
    },
  ];

  if (n >= 2) {
    actions.push({
      id: 'wall',
      kind: 'primary',
      label: () => t('dashboard.bulk_create_wall'),
      run: () => createWallFromSelection(),
    });
  }

  actions.push({
    id: 'delete',
    kind: 'danger',
    confirm: true,
    label: (count) => tn('dashboard.bulk_delete', count),
    confirmLabel: (count) => tn('dashboard.bulk_delete_confirm', count),
    run: async (ids) => {
      const { ok, failed } = await runEach(ids, (id) => api.deleteDevice(id));
      showToast(failed.length ? t('bulk.partial', { ok, fail: failed.length })
        : tn('dashboard.bulk_deleted', ok), failed.length ? 'error' : 'success');
      devSel.ids.clear();
      loadDashboard();
    },
  });

  renderBulkBar(bar, devSel, actions, () => {
    syncRowChecks();
    renderDeviceBulkBar();
  });
}

/*
 * Push the selection back onto the checkboxes without re-rendering the table. A full reload here
 * would tear down the drag handlers and restart the progress bars mid-item.
 */
function syncRowChecks() {
  document.querySelectorAll('.device-row .bulk-check').forEach(cb => {
    cb.checked = devSel.ids.has(cb.dataset.bulkId);
  });
  document.querySelectorAll('.bulk-check-all').forEach(box => {
    const ids = visibleIdsIn(box.closest('table'));
    box.checked = ids.length > 0 && ids.every(id => devSel.ids.has(id));
  });
}

/* The rows of one table that the current filter is actually showing, in display order. */
function visibleIdsIn(table) {
  if (!table) return [];
  return [...table.querySelectorAll('.device-row')]
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.deviceId);
}

/*
 * Every visible row on the page, in order. This is what makes shift-click mean "the range I can
 * see": with a filter applied, the rows between two ticks are the rows on screen, not the rows
 * that happen to sit between them in the database.
 */
function refreshSelectionOrder() {
  devSel.order = [...document.querySelectorAll('.device-row')]
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.deviceId);
}

/*
 * Select-all is per TABLE, not per page: each group has its own header box, and ticking the one
 * over "Loja Centro" must not also select the screens in "Depósito". It still means all VISIBLE
 * rows of that table — a select-all that reached filtered-out rows is how a bulk delete takes
 * something nobody looked at.
 */
function wireDeviceSelection(root) {
  wireSelection(root, devSel, () => { syncRowChecks(); renderDeviceBulkBar(); });

  root.querySelectorAll('.bulk-check-all').forEach(box => {
    box.addEventListener('click', () => {
      const ids = visibleIdsIn(box.closest('table'));
      const every = ids.length > 0 && ids.every(id => devSel.ids.has(id));
      ids.forEach(id => { if (every) devSel.ids.delete(id); else devSel.ids.add(id); });
      syncRowChecks();
      renderDeviceBulkBar();
    });
  });
}

// Pick a sensible default grid for n devices: prefer near-square layouts,
// breaking ties toward more columns (more common physical wall layout).
function defaultGridForCount(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n === 6) return { cols: 3, rows: 2 };
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 9) return { cols: 3, rows: 3 };
  // Generic fallback — square-ish, columns >= rows
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

async function createWallFromSelection() {
  const ids = [...selectedDeviceIds];
  if (ids.length < 2) { showToast('Select at least 2 displays', 'error'); return; }
  const name = prompt('Name this video wall:', `Wall ${new Date().toLocaleString()}`);
  if (!name) return;
  const { cols, rows } = defaultGridForCount(ids.length);
  try {
    const wall = await api.createWall({ name, grid_cols: cols, grid_rows: rows });
    // Pack selected devices into row-major order. The user can reposition in
    // the editor; this just gives every selection a sensible starting tile.
    const placement = ids.slice(0, cols * rows).map((id, i) => ({
      device_id: id,
      grid_col: i % cols,
      grid_row: Math.floor(i / cols),
    }));
    await api.setWallDevices(wall.id, placement);
    selectedDeviceIds.clear();
    showToast('Video wall created', 'success');
    window.location.hash = `#/wall/${wall.id}`;
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadDashboard() {
  const main = document.getElementById('groupedDevices');
  if (!main) return;

  try {
    const [rawDevices, groups, playlists, walls] = await Promise.all([
      api.getDevices(), api.getGroups(), api.getPlaylists(), api.getWalls(),
    ]);

    // Deduplicate devices by id — a stale reconnect race can briefly cause the same
    // device to appear twice in the list. Last-write-wins keeps the freshest state.
    const seen = new Map();
    for (const d of rawDevices) seen.set(d.id, d);
    const devices = Array.from(seen.values());
    lastPlaylists = playlists || [];
    // Kept so the bulk bar can ask what the SELECTED screens can actually honour. Without it the
    // menu offered every command to every selection and half of them were no-ops.
    lastDevices = devices;

    // Getting started. Skipped entirely once put away or finished, so the extra content
    // lookup only ever happens for an account that still has something left to do.
    const gsHost = document.getElementById('gettingStarted');
    if (gsHost && !gettingStarted.isDismissed()) {
      try {
        const content = await api.getContent();
        const state = gettingStarted.computeSteps({ devices, content: content || [], playlists: playlists || [] });
        if (state.complete) gettingStarted.dismiss();   // finished: never costs a fetch again
        gettingStarted.render(gsHost, state, {
          onAction: (a) => {
            if (a === 'add-device') { document.getElementById('addDeviceBtn')?.click(); return true; }
            return false;
          },
        });
      } catch (_) { /* guidance must never break the dashboard */ }
    }


    if (devices.length === 0 && groups.length === 0) {
      main.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h3>${t('dashboard.no_displays')}</h3>
          <p>${t('dashboard.no_displays_desc')}</p>
        </div>
      `;
      return;
    }

    // Devices that belong to a wall are owned by that wall — they don't appear
    // as their own cards anywhere on the dashboard. The wall's card stands in.
    const walledDeviceIds = new Set();
    for (const w of (walls || [])) for (const d of (w.devices || [])) walledDeviceIds.add(d.device_id);
    const dashboardDevices = devices.filter(d => !walledDeviceIds.has(d.id));

    // Fetch group memberships
    const groupsWithDevices = await Promise.all(groups.map(async g => {
      const members = await api.getGroupDevices(g.id);
      const memberIds = new Set(members.map(m => m.id));
      // Use full device data from the main devices list (has telemetry/screenshots)
      // and exclude any wall members.
      const fullDevices = dashboardDevices.filter(d => memberIds.has(d.id));
      return { ...g, devices: fullDevices, memberIds };
    }));

    // Render each device exactly once: the first group it belongs to wins.
    // memberIds is preserved for the Manage modal so multi-group membership info stays accurate.
    const renderedIds = new Set();
    for (const g of groupsWithDevices) {
      g.devices = g.devices.filter(d => {
        if (renderedIds.has(d.id)) return false;
        renderedIds.add(d.id);
        return true;
      });
    }
    const ungrouped = dashboardDevices.filter(d => !renderedIds.has(d.id));

    let html = '';

    // Walls render before groups: they're a higher-level construct (multiple
    // physical screens acting as one logical display).
    if ((walls || []).length > 0) {
      html += `
        <div class="wall-section" style="margin-bottom:24px">
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid #8b5cf6">
            <strong style="font-size:15px">Video Walls</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${walls.length} wall${walls.length === 1 ? '' : 's'}</span>
          </div>
          <div class="device-grid">${walls.map(renderWallCard).join('')}</div>
        </div>
      `;
    }

    // Render each group with its devices
    for (const g of groupsWithDevices) {
      html += renderGroupSection(g, g.devices, playlists);
    }

    // Render ungrouped devices. The wrapper is tagged data-ungrouped="1" so
    // attachGroupHandlers can wire it as a drop target — dropping a device here
    // removes it from every group it currently belongs to.
    if (ungrouped.length > 0) {
      html += `
        <div class="ungrouped-section" data-ungrouped="1" style="margin-bottom:24px">
          ${groups.length > 0 ? `
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid var(--text-muted)">
            <strong style="font-size:15px;color:var(--text-muted)">${t('dashboard.ungrouped')}</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${tn('dashboard.devices_count', ungrouped.length)}</span>
          </div>` : ''}
          <div class="device-list-wrap">
            ${renderDeviceTable(ungrouped)}
          </div>
        </div>
      `;
    }

    main.innerHTML = html;
    attachGroupHandlers(groupsWithDevices, dashboardDevices);
    wireDeviceSelection(main);
    refreshSelectionOrder();
    // A device removed since the last render must not stay in the selection: it would put a count
    // on the toolbar for a screen that no longer exists, and a bulk action would then fail on it.
    const present = new Set(devices.map(d => d.id));
    for (const id of [...devSel.ids]) if (!present.has(id)) devSel.ids.delete(id);
    for (const id of playbackByDevice.keys()) renderProgressFor(id);

    // Drop any selections for devices that have since been absorbed into a
    // wall, and update the toolbar.
    for (const id of [...selectedDeviceIds]) {
      if (walledDeviceIds.has(id)) selectedDeviceIds.delete(id);
    }
    renderDeviceBulkBar();

  } catch (err) {
    main.innerHTML = `<div class="empty-state"><h3>${t('dashboard.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function attachGroupHandlers(groupsWithDevices, allDevices) {
  // Drag-and-drop: device cards are draggable; group sections + the Ungrouped
  // wrapper are drop targets. Drop on a group adds membership (mirrors the
  // Manage modal). Drop on Ungrouped removes the device from every group it's
  // currently a member of.
  const groupsByDeviceId = new Map();
  for (const g of groupsWithDevices) {
    g.memberIds.forEach(id => {
      if (!groupsByDeviceId.has(id)) groupsByDeviceId.set(id, []);
      groupsByDeviceId.get(id).push({ id: g.id, name: g.name });
    });
  }

  // #106: within-section drag-to-reorder. Tracks the in-flight drag (which device,
  // and which section it started in) so a CARD-level drop can tell reorder (same
  // section) from group-assign (different section / section background).
  let dragDeviceId = null;
  let dragSectionKey = null;
  const sectionKeyOf = (el) => {
    const g = el.closest('.group-section');
    if (g && g.dataset.groupId) return 'g:' + g.dataset.groupId;
    if (el.closest('[data-ungrouped="1"]')) return 'ungrouped';
    return null;
  };
  const clearDropIndicators = () => document.querySelectorAll('.device-row').forEach(c => { c.style.boxShadow = ''; });

  document.querySelectorAll('.device-row').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/device-id', card.dataset.deviceId);
      e.dataTransfer.setData('text/device-name', card.dataset.deviceName || '');
      e.dataTransfer.effectAllowed = 'move';
      dragDeviceId = card.dataset.deviceId;   // #106
      dragSectionKey = sectionKeyOf(card);    // #106
    });
    card.addEventListener('dragend', () => { dragDeviceId = null; dragSectionKey = null; clearDropIndicators(); });

    // #106 within-section reorder. Engages ONLY when the target is another card in the
    // SAME section; otherwise it no-ops and the event bubbles to the section handler
    // (group-assign), leaving the existing behavior untouched.
    card.addEventListener('dragover', (e) => {
      if (!dragDeviceId || dragDeviceId === card.dataset.deviceId) return;
      if (sectionKeyOf(card) !== dragSectionKey) return; // cross-section -> section handles (assign)
      e.preventDefault();
      e.stopPropagation();                    // suppress the section's group-assign dragover/highlight
      e.dataTransfer.dropEffect = 'move';
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      card.style.boxShadow = before ? 'inset 0 3px 0 var(--primary)' : 'inset 0 -3px 0 var(--primary)';
    });
    card.addEventListener('dragleave', () => { card.style.boxShadow = ''; });
    card.addEventListener('drop', async (e) => {
      if (!dragDeviceId || dragDeviceId === card.dataset.deviceId) return;
      if (sectionKeyOf(card) !== dragSectionKey) return; // cross-section -> bubble to section (assign)
      e.preventDefault();
      e.stopPropagation();                    // CRITICAL: stop the section's group-assign drop also firing
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      clearDropIndicators();
      const grid = card.closest('.device-tbody');
      if (!grid) return;
      const ids = Array.from(grid.querySelectorAll('.device-row')).map(c => c.dataset.deviceId).filter(Boolean);
      const from = ids.indexOf(dragDeviceId);
      if (from === -1) return;
      ids.splice(from, 1);
      let to = ids.indexOf(card.dataset.deviceId);
      if (!before) to += 1;
      ids.splice(to, 0, dragDeviceId);
      try {
        await api.reorderDevices(ids);
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  function highlightOn(el) { el.style.outline = '2px solid var(--primary)'; el.style.outlineOffset = '2px'; }
  function highlightOff(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

  document.querySelectorAll('.group-section').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      // Avoid flicker when moving across child elements
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const groupId = section.dataset.groupId;
      const targetGroup = groupsWithDevices.find(g => g.id === groupId);
      if (!targetGroup) return;
      // Already in this group — no-op.
      if (targetGroup.memberIds.has(deviceId)) {
        showToast(t('dashboard.toast.already_in_group', { name: deviceName, group: targetGroup.name }), 'info');
        return;
      }
      // Dragging a screen onto a group MOVES it. This used to borrow the Manage modal's
      // "add it too?" confirm and then only add — so the screen ended up in both groups while the
      // toast claimed it had moved, the page still showed the old group, and a second attempt said
      // "already in group 2". Reported by a customer doing exactly that with two screens.
      // The Manage modal keeps add/remove checkboxes: multi-group membership is deliberate THERE.
      // It is not deliberate here, and it is not harmless — deviceSyncGroup() picks arbitrarily
      // when a device is in several sync-enabled groups, so a half-move leaves sync ambiguous.
      const others = groupsByDeviceId.get(deviceId) || [];
      if (others.length > 0) {
        if (!confirm(t('dashboard.confirm_move_to_group', {
          name: deviceName, groups: others.map(g => g.name).join(', '), target: targetGroup.name,
        }))) return;
      }
      try {
        // Add first, then drop the old memberships: if the add fails the screen keeps the group it
        // had rather than being left ungrouped by a half-finished move.
        await api.addDeviceToGroup(groupId, deviceId);
        for (const g of others) {
          if (g.id === groupId) continue;
          try { await api.removeDeviceFromGroup(g.id, deviceId); }
          catch (e) { showToast(t('dashboard.toast.move_partial', { group: g.name }), 'warning'); }
        }
        showToast(t('dashboard.toast.moved_device', { name: deviceName, group: targetGroup.name }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Ungrouped wrapper: remove device from every group it's in.
  document.querySelectorAll('[data-ungrouped="1"]').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const memberships = groupsByDeviceId.get(deviceId) || [];
      if (memberships.length === 0) return; // already ungrouped
      try {
        await Promise.all(memberships.map(m => api.removeDeviceFromGroup(m.id, deviceId)));
        showToast(tn('dashboard.toast.removed_device', memberships.length, { name: deviceName }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Playlist assignment handlers
  document.querySelectorAll('.group-playlist-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const playlistId = e.target.value;
      if (!playlistId) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const playlistName = e.target.options[e.target.selectedIndex].textContent;

      if (!confirm(t('dashboard.confirm_assign_playlist', { playlist: playlistName, group: groupName }))) {
        e.target.value = '';
        return;
      }

      try {
        const result = await api.groupAssignPlaylist(groupId, playlistId);
        showToast(tn('dashboard.toast.playlist_assigned', result.devices_updated), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // #group-sync: toggle synchronized playback for a group.
  document.querySelectorAll('.group-sync-cb').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const groupId = e.target.dataset.groupId;
      const enabled = e.target.checked;
      try {
        await api.updateGroup(groupId, { sync_enabled: enabled });
        showToast(enabled ? t('dashboard.group_sync.toast_on') : t('dashboard.group_sync.toast_off'), 'success');
        loadDashboard(); // re-render so the Resync button shows/hides
      } catch (err) {
        showToast(err.message, 'error');
        e.target.checked = !enabled;
      }
    });
  });

  // Choose the sync protocol. The server may refuse the choice (native sync needs every member to
  // be a BrightSign on one L2 network), so re-render from its answer rather than assuming the
  // request took — showing a setting that isn't in force is exactly what makes a drifting wall
  // impossible to diagnose.
  document.querySelectorAll('.group-backend-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const groupId = e.target.dataset.groupId;
      const previous = sel.dataset.previous || 'auto';
      const chosen = e.target.value;
      try {
        const updated = await api.updateGroup(groupId, { sync_backend: chosen });
        if (updated?.sync_downgraded && updated?.sync_reason) {
          showToast(t('dashboard.group_sync.toast_downgraded') + ' ' + updated.sync_reason, 'warning');
        } else {
          showToast(t('dashboard.group_sync.toast_backend'), 'success');
        }
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
        e.target.value = previous;
      }
    });
    sel.dataset.previous = sel.value;
  });

  // #group-sync: manual "Resync now" — nudge all members to re-snap to the shared schedule.
  document.querySelectorAll('.group-resync-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const groupId = e.currentTarget.dataset.groupId;
      try {
        await api.resyncGroup(groupId);
        showToast(t('dashboard.group_sync.toast_resync'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Command select handlers
  document.querySelectorAll('.group-cmd-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const type = e.target.value;
      if (!type) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const count = e.target.dataset.deviceCount;
      const cmdLabel = t(CMD_LABEL_KEY[type] || type);

      if (DESTRUCTIVE_COMMANDS.includes(type)) {
        if (!confirm(t('dashboard.confirm_destructive_command', { cmd: cmdLabel.toUpperCase(), n: count, group: groupName }))) {
          e.target.value = '';
          return;
        }
      }

      try {
        const result = await api.sendGroupCommand(groupId, type);
        // A group is routinely mixed-platform, so these buttons stay visible — "reboot" is
        // meaningful for the Android panels in the group even when the web players in it can
        // never honour it. What must not happen is the toast counting those as sent: the
        // operator would walk away believing the whole group rebooted.
        let msg = result.offline > 0
          ? t('dashboard.toast.command_sent_with_offline', { cmd: cmdLabel, sent: result.sent, total: result.total, offline: result.offline })
          : t('dashboard.toast.command_sent', { cmd: cmdLabel, sent: result.sent, total: result.total });
        if (result.unsupported > 0) {
          msg += ' ' + t('dashboard.toast.command_unsupported_n', { n: result.unsupported });
        }
        showToast(msg, (result.offline > 0 || result.unsupported > 0) ? 'warning' : 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Delete group
  document.querySelectorAll('[data-group-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.groupDelete;
      if (!confirm(t('dashboard.confirm_delete_group'))) return;
      try {
        await api.deleteGroup(id);
        showToast(t('dashboard.toast.group_deleted'), 'success');
        loadDashboard();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  // Manage group (add/remove devices)
  document.querySelectorAll('[data-group-manage]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupManage;
      const group = groupsWithDevices.find(g => g.id === groupId);
      const memberIds = new Set(group.devices.map(d => d.id));

      // Get all groups for multi-group warning
      const otherGroups = groupsWithDevices.filter(g => g.id !== groupId);

      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
      modal.innerHTML = `
        <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto">
          <h3 style="margin:0 0 4px">${esc(group.name)}</h3>
          <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">${t('dashboard.manage_group_subtitle')}</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${allDevices.filter(d => d.status !== 'provisioning').map(d => {
              const inOther = otherGroups.filter(g => g.memberIds.has(d.id)).map(g => g.name);
              return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:var(--bg-secondary)">
                  <input type="checkbox" data-device-id="${d.id}" data-in-groups="${inOther.join(',')}" ${memberIds.has(d.id) ? 'checked' : ''}>
                  <span class="status-dot ${d.status}" style="width:8px;height:8px"></span>
                  <span style="font-size:13px;flex:1">${esc(d.name)}</span>
                  ${inOther.length > 0 ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-primary);padding:1px 6px;border-radius:8px">${esc(inOther.join(', '))}</span>` : ''}
                </label>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button class="btn" id="manageGroupClose">${t('common.done')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#manageGroupClose').onclick = () => { modal.remove(); loadDashboard(); };
      modal.addEventListener('click', (ev) => { if (ev.target === modal) { modal.remove(); loadDashboard(); } });

      modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const deviceId = cb.dataset.deviceId;
          const existingGroups = cb.dataset.inGroups;
          const cbName = cb.closest('label')?.querySelector('span:not(.status-dot)')?.textContent || '';
          try {
            if (cb.checked && existingGroups) {
              if (!confirm(t('dashboard.confirm_add_to_group', { name: cbName, groups: existingGroups, target: group.name }))) {
                cb.checked = false;
                return;
              }
            }
            if (cb.checked) {
              await api.addDeviceToGroup(groupId, deviceId);
            } else {
              await api.removeDeviceFromGroup(groupId, deviceId);
            }
          } catch (err) {
            showToast(err.message, 'error');
            cb.checked = !cb.checked;
          }
        });
      });
    });
  });
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (playbackHandler) off('playback-progress', playbackHandler);
  if (wallChangedHandler) off('wall-changed', wallChangedHandler);
  off('device-added', () => {});
  off('device-removed', () => {});
  if (refreshInterval) clearInterval(refreshInterval);
  if (progressTickInterval) clearInterval(progressTickInterval);
  statusHandler = null;
  playbackHandler = null;
  wallChangedHandler = null;
  refreshInterval = null;
  progressTickInterval = null;
  playbackByDevice.clear();
}
