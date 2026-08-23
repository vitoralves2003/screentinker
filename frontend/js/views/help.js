import { t } from '../i18n.js';
import { esc, isPlatformAdmin } from '../utils.js';

/*
 * The help page, rewritten to describe THIS product.
 *
 * It used to be nine cards and eleven answers, typed in English straight into the markup, and six
 * of the nine described screens a customer cannot open: Widgets, the AI designer, Kiosk, Video
 * Walls, Remote Control and a Schedule page that is not in the menu. The FAQ promised a 14-day
 * trial that no longer exists and explained how to export proof-of-play from a Reports page the
 * nav does not show. Help that names features the reader cannot find does not merely fail to
 * help — it makes them doubt they are looking at the right screen.
 *
 * So a guide appears only when the reader can reach the thing it describes, decided the same way
 * the menu decides: isPlatformAdmin for the staff-only pages, and for the activity log the server
 * itself is asked, because that rule lives in routes/activity.js and a copy here would be free to
 * drift from the one that actually refuses.
 *
 * Everything is a translation key. The previous version could not be translated at all.
 */

// A guide is { key, when } — `when` decides whether the reader can actually reach it. The keys
// resolve to help.<key>.title and help.<key>.s1..sN.
const GUIDES = [
  { key: 'display', icon: '&#128250;', steps: 5 },
  { key: 'upload', icon: '&#128228;', steps: 5 },
  { key: 'playlist', icon: '&#9776;', steps: 5 },
  { key: 'schedule', icon: '&#128197;', steps: 5 },
  { key: 'activity', icon: '&#128203;', steps: 3, when: (ctx) => ctx.isOwner },
  // Layouts is in the nav only for platform staff today; it appears here on the same rule, so the
  // two can never disagree about whether the page exists for this reader.
  { key: 'layouts', icon: '&#128465;', steps: 5, when: (ctx) => ctx.isStaff },
];

const FAQ = ['devices', 'formats', 'offline', 'portrait', 'update', 'schedule_vs_expiry'];

function stepsOf(key, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(t(`help.${key}.s${i}`));
  return out;
}

export async function render(container) {
  /*
   * Owner-only guidance is asked about, not guessed. The activity log is gated on org_owner in
   * routes/activity.js, and reproducing that rule here from the cached user would be a second
   * opinion free to drift from the one that decides.
   */
  // The router does not await this, so paint something before the probe: otherwise the page keeps
  // whatever the previous view left on screen until the request comes back.
  container.innerHTML = `<div class="page-header"><div><h1>${t('help.title')}</h1><div class="subtitle">${t('help.subtitle')}</div></div></div>`;

  let isOwner = false;
  try {
    const res = await fetch('/api/activity/available', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    isOwner = res.ok ? !!(await res.json()).available : false;
  } catch { /* not reachable: leave the owner-only card out rather than promise it */ }

  let user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch { /* fall through */ }
  const ctx = { isOwner, isStaff: isPlatformAdmin(user) };

  const guides = GUIDES.filter((g) => !g.when || g.when(ctx));

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('help.title')}</h1>
        <div class="subtitle">${t('help.subtitle')}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:24px">
      ${guides.map((g) => `
        <div class="settings-section" style="margin:0">
          <h3 style="font-size:15px">${g.icon} ${esc(t(`help.${g.key}.title`))}</h3>
          <ol style="padding-left:20px;list-style:decimal;margin-top:8px">
            ${stepsOf(g.key, g.steps).map((s) => `<li style="color:var(--text-secondary);font-size:13px;line-height:1.8">${esc(s)}</li>`).join('')}
          </ol>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>${t('help.faq')}</h3>
      ${FAQ.map((k) => `
        <div style="border-bottom:1px solid var(--border);padding:12px 0">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">${esc(t(`help.faq.${k}.q`))}</div>
          <div style="color:var(--text-secondary);font-size:13px">${esc(t(`help.faq.${k}.a`))}</div>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>${t('help.contact_title')}</h3>
      <p style="color:var(--text-secondary);font-size:13px">
        ${esc(t('help.contact_body'))}
        <a href="mailto:contato@loopplayer.com.br" style="color:var(--accent)">contato@loopplayer.com.br</a>
      </p>
    </div>
  `;
}

export function cleanup() {}
