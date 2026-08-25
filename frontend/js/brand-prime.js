// Render-blocking branding primer (#38). Loaded as a synchronous same-origin
// <script> right after the sidebar logo, so it runs DURING parse, before first
// paint — applying the current workspace's CACHED white-label so the page paints
// branded instead of flashing the default brand. branding.js then
// refreshes it from the server and re-writes the cache. Plain script (not a
// module) so it's not deferred; keyed by workspace so a switch shows the right
// brand (or the neutral default for a workspace we haven't cached yet).
(function () {
  /*
   * WCAG relative luminance, so the derived colours are measured rather than guessed.
   * Duplicated in branding.js: this file is a standalone pre-paint script with no imports, and
   * an import here would defeat the reason it exists.
   */
  function luminance(hex) {
    var c = String(hex || '').replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
    var l = 0, w = [0.2126, 0.7152, 0.0722];
    for (var i = 0; i < 3; i++) {
      var v = parseInt(c.substr(i * 2, 2), 16) / 255;
      l += w[i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    }
    return l;
  }

  /*
   * A brand colour is three tokens, not one.
   *
   * --accent is a SURFACE. --accent-on is what is legible on top of it, and which of black or
   * white that is depends entirely on the colour the tenant picked. --accent-ink is the same hue
   * darkened until it can be read on the light page, because a bright brand colour as text on
   * white is the failure this whole palette is built around.
   *
   * Setting --accent alone left the other two pointing at the default green, so a tenant with a
   * dark brand colour got dark ink on a dark button.
   */
  function applyAccent(root, hex) {
    var lum = luminance(hex);
    if (lum === null) return;
    root.style.setProperty('--accent', hex);
    // 0.45 is where black and white cross over against a mid-tone; measured either side it is
    // the point at which the better of the two stops being obvious.
    root.style.setProperty('--accent-on', inkOn(hex));
    if (lum > 0.18) root.style.setProperty('--accent-ink', darken(hex, lum));
  }

  /* Toward black until it measures 4.5:1 on white — the bar --accent-ink itself was chosen at.
     The first guess inverts the gamma curve; the loop corrects for the fact that scaling sRGB
     channels is not the same as scaling luminance. */
  /* The legible ink for a filled button of this colour, chosen by measurement.
     A threshold on luminance was the first attempt and pure red broke it: it picked white at
     4.00:1 when black would have given 5.25:1. */
  function inkOn(hex) {
    var candidates = ['#04231A', '#000000', '#FFFFFF'];
    var best = null, bestRatio = 0;
    for (var i = 0; i < candidates.length; i++) {
      var r = contrast(candidates[i], hex);
      // The brand's near-black is preferred while it passes: warmer than pure black, and it is
      // what the palette itself pairs with the default green.
      if (r >= 4.5) return candidates[i];
      if (r > bestRatio) { bestRatio = r; best = candidates[i]; }
    }
    return best;
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function darken(hex, lum) {
    var c = String(hex).replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var target = 0.16;                                  // 1.05/(0.16+0.05) = 5.0:1 on white
    var f = Math.min(1, Math.pow(target / lum, 1 / 2.4));
    for (var step = 0; step < 12; step++) {
      var out = '#';
      for (var i = 0; i < 3; i++) {
        var v = Math.round(parseInt(c.substr(i * 2, 2), 16) * f);
        out += ('0' + v.toString(16)).slice(-2);
      }
      if (luminance(out) <= target) return out;
      f *= 0.85;
    }
    return '#000000';
  }

  try {
    var token = localStorage.getItem('token');
    if (!token) return;
    var ws = 'none';
    try {
      var seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      ws = (JSON.parse(atob(seg)) || {}).current_workspace_id || 'none';
    } catch (e) { /* malformed token -> treat as no workspace */ }

    var wl = JSON.parse(localStorage.getItem('rd_branding_' + ws) || 'null');
    if (!wl) {
      // #76: no per-workspace cache yet (e.g. a never-visited org). Fall back to
      // the server-injected instance / custom-domain branding so the page paints
      // the configured brand instead of flashing the default brand;
      // branding.js then fetches and caches the workspace-specific brand.
      try {
        var ssr = document.querySelector('meta[name="ssr-brand"]');
        if (ssr && ssr.content) wl = JSON.parse(ssr.content);
      } catch (e) { /* ignore */ }
    }
    if (!wl) return;

    var root = document.documentElement;
    applyAccent(root, wl.primary_color);
    if (wl.brand_name) {
      document.title = wl.brand_name;
      var span = document.getElementById('brandName');
      if (span) span.textContent = wl.brand_name;
    }
    if (wl.favicon_url) {
      var links = document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]');
      for (var i = 0; i < links.length; i++) links[i].setAttribute('href', wl.favicon_url);
    }
    if (wl.custom_css) {
      var s = document.createElement('style');
      s.id = 'wl-custom-css';
      s.textContent = wl.custom_css;
      document.head.appendChild(s);
    }
  } catch (e) { /* never let branding break boot */ }
})();
