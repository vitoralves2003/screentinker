import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';

// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url) => fetch('/api' + url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

/*
 * The log as a panel inside Settings, rather than a page of its own.
 *
 * ASKS PERMISSION FIRST and stays hidden if the answer is no. The section is only revealed once
 * /activity/available says this caller may read it, so a member never meets a panel that exists
 * only to refuse them — and the owner-only rule stays enforced on the server, where it counts.
 * `section` is the element to reveal; passing it in keeps this view ignorant of Settings' layout.
 */
export async function mountActivityLog(host, section) {
  if (!host) return;

  try {
    const { available } = await API('/activity/available');
    if (!available) return;
  } catch (err) {
    return; // Not reachable or not permitted: leave the section hidden rather than show an error.
  }
  if (section) section.hidden = false;

  let users = [];
  try { users = await API('/activity/users'); } catch (err) { /* the filter is optional */ }

  host.innerHTML = `
    ${users.length > 1 ? `
    <div style="margin-bottom:12px">
      <select id="activityUserFilter" class="input" style="width:auto;max-width:280px;background:var(--bg-input)">
        <option value="">${esc('Todos os usuários')}</option>
        ${users.map((u) => `<option value="${esc(u.id)}">${esc(u.name || u.email)}</option>`).join('')}
      </select>
    </div>` : ''}
    <div id="activityList"><div class="empty-state"><h3>Carregando...</h3></div></div>
    <div style="text-align:center;margin-top:16px">
      <button class="btn btn-secondary btn-sm" id="loadMoreBtn" style="display:none">Carregar mais</button>
    </div>`;

  wireActivityList(host);
}

/*
 * Shared by the panel above. Kept separate from the markup so the offset/paging state belongs to
 * one mount: switching the person filter resets it, which a module-level offset would not.
 */
function wireActivityList(root) {
  const limit = 50;
  let offset = 0;

  const filter = root.querySelector('#activityUserFilter');
  const list = root.querySelector('#activityList');
  const more = root.querySelector('#loadMoreBtn');

  async function load(append = false) {
    const userId = filter ? filter.value : '';
    try {
      const q = `/activity?limit=${limit}&offset=${offset}${userId ? `&user_id=${encodeURIComponent(userId)}` : ''}`;
      const items = await API(q);

      if (!append) list.innerHTML = '';
      if (!items.length && offset === 0) {
        list.innerHTML = `<div class="empty-state"><h3>Sem atividade ainda</h3><p>As ações aparecerão aqui conforme você usa o sistema.</p></div>`;
        more.style.display = 'none';
        return;
      }
      list.insertAdjacentHTML('beforeend', items.map(rowHtml).join(''));
      more.style.display = items.length >= limit ? '' : 'none';
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  more.onclick = () => { offset += limit; load(true); };
  if (filter) filter.onchange = () => { offset = 0; load(false); };
  load();
}

function rowHtml(item) {
  const time = new Date(item.created_at * 1000);
  const timeStr = time.toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' }) + ' '
    + time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `
    <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);align-items:flex-start">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-card);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">${getActionIcon(item.action)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px">
          <strong>${esc(item.user_name || item.user_email || 'Sistema')}</strong>
          <span style="color:var(--text-secondary)"> ${esc(formatAction(item.action))}</span>
        </div>
        ${item.details ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(item.details)}</div>` : ''}
      </div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">${timeStr}</div>
    </div>`;
}

function getActionIcon(action) {
  if (action.includes('DELETE')) return '&#128465;';
  if (action.includes('POST') && action.includes('content')) return '&#128228;';
  if (action.includes('POST') && action.includes('provision')) return '&#128279;';
  if (action.includes('POST') && action.includes('assignment')) return '&#128203;';
  if (action.includes('alert')) return '&#128276;';
  if (action.includes('PUT')) return '&#9998;';
  if (action.includes('POST')) return '&#10133;';
  return '&#128196;';
}

// Action verbs are user-visible; translate them through t() so they switch
// languages with the rest of the UI. The mapping below preserves the original
// verb-then-noun structure of the English version.
function formatAction(action) {
  // Verbs
  let s = action
    .replace('POST /api/', 'criou' + ' ')
    .replace('PUT /api/', 'atualizou' + ' ')
    .replace('DELETE /api/', 'excluiu' + ' ');
  // Specific endpoints
  s = s
    .replace('/provision/pair', 'pareou um dispositivo')
    .replace('/content/remote', 'adicionou conteúdo remoto')
    .replace('/content', 'conteúdo')
    .replace('/devices/:id', 'dispositivo')
    .replace('/assignments/device/:deviceId', 'atribuição de playlist')
    .replace('/assignments/:id', 'atribuição')
    .replace('/layouts', 'layout')
    .replace('/widgets', 'widget')
    .replace('/schedules', 'agenda')
    .replace('/walls', 'parede de vídeo')
    .replace('alert:device_offline', 'alerta: dispositivo offline');
  return s;
}


