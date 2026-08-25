// Applies the current user's saved white-label config to the DOM.
// Runs once after login/route bootstrap. Without this, saved values in the
// white_labels table are read into the Settings form but never applied to
// the actual page — so users see the default brand name and colours after
// every reload, as if their save reverted.

let applied = false;

// Current workspace id from the JWT, so the branding cache (read render-blocking by
// brand-prime.js) is keyed per workspace — a switch shows the right brand. (#38)
function currentWorkspaceId() {
  try {
    const seg = localStorage.getItem('token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(atob(seg)) || {}).current_workspace_id || 'none';
  } catch { return 'none'; }
}

/* Duplicated from brand-prime.js, which is a pre-paint script and cannot import. */
function luminance(hex) {
  let c = String(hex || '').replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  return [0, 1, 2].reduce((acc, i) => {
    const v = parseInt(c.substr(i * 2, 2), 16) / 255;
    return acc + [0.2126, 0.7152, 0.0722][i] * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0);
}
/* See brand-prime.js: measured rather than thresholded, because pure red broke the threshold. */
function inkOn(hex) {
  let best = null;
  let bestRatio = 0;
  for (const candidate of ['#04231A', '#000000', '#FFFFFF']) {
    const r = contrast(candidate, hex);
    if (r >= 4.5) return candidate;
    if (r > bestRatio) { bestRatio = r; best = candidate; }
  }
  return best;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* See brand-prime.js for why this aims at a luminance and then verifies it. */
function darken(hex, lum) {
  let c = String(hex).replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const target = 0.16;
  let f = Math.min(1, (target / lum) ** (1 / 2.4));
  for (let step = 0; step < 12; step++) {
    const out = '#' + [0, 1, 2]
      .map((i) => Math.round(parseInt(c.substr(i * 2, 2), 16) * f).toString(16).padStart(2, '0'))
      .join('');
    if (luminance(out) <= target) return out;
    f *= 0.85;
  }
  return '#000000';
}

function applyAccent(root, hex) {
  const lum = luminance(hex);
  if (lum === null) return;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-on', inkOn(hex));
  if (lum > 0.18) root.style.setProperty('--accent-ink', darken(hex, lum));
}

export async function applyBranding() {
  if (applied) return;
  applied = true;

  const token = localStorage.getItem('token');
  if (!token) return;

  let wl;
  try {
    const res = await fetch('/api/white-label', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    wl = await res.json();
  } catch { return; }
  if (!wl) return;

  // Cache for the next load/switch so brand-prime.js can apply it before paint.
  try { localStorage.setItem('rd_branding_' + currentWorkspaceId(), JSON.stringify(wl)); } catch {}

  /*
   * The accent, as a complete set — see the note at the top of brand-prime.js for why the page
   * ground is no longer brandable and why one colour cannot be applied on its own.
   */
  const root = document.documentElement;
  applyAccent(root, wl.primary_color);

  if (wl.brand_name) {
    document.title = wl.brand_name;
    const span = document.getElementById('brandName');
    if (span) span.textContent = wl.brand_name;
  }

  if (wl.favicon_url) {
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(l => {
      l.setAttribute('href', wl.favicon_url);
    });
  }

  if (wl.custom_css) {
    let style = document.getElementById('wl-custom-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wl-custom-css';
      document.head.appendChild(style);
    }
    style.textContent = wl.custom_css;
  }
}

// Force a re-apply (called from settings.js after save)
export function resetBranding() {
  applied = false;
  return applyBranding();
}
