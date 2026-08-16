'use strict';

/*
 * Shared base for every Loop Player widget: scale, motion, palette and icons.
 *
 * WHY THIS EXISTS. Each widget used to be a standalone HTML document with its own hardcoded
 * pixel sizes, and it showed: on a 1080p panel the content occupied about a tenth of the screen
 * and on a 4K one it was smaller still, because `font-size: 64px` means 64 physical pixels no
 * matter how big the display is. A widget fills the whole screen, so its type has to be measured
 * AGAINST the screen — hence vmin throughout. `--u` below is 1% of the shorter side, and every
 * size in every widget is a multiple of it. The same markup then reads correctly on a phone-sized
 * preview, a 1080p TV and a 4K wall with no per-device configuration.
 *
 * MOTION. Animation is the differentiator the product is going for, but on signage it has a job
 * beyond decoration: a screen that never changes stops being looked at, and a static panel is
 * indistinguishable from a crashed one. So every widget animates in on load and animates its
 * DATA when the data actually changes — not on a loop. Continuous motion at the edge of vision is
 * what makes signage tiring to sit near.
 *
 * REDUCED MOTION is honoured. Some panels are in clinics and waiting rooms.
 */

const config = require('../config');

// Palette mirrors frontend/css/variables.css so a widget on screen belongs to the same product
// as the dashboard that scheduled it.
const PALETTE = {
  bg: '#06111E',
  surface: '#0B1927',
  brand: '#20DF91',
  brandDim: '#0E9C61',
  text: '#F8FAFC',
  textDim: '#94A3B8',
  textMute: '#64748B',
};

/*
 * The <head> every widget shares: reset, scale unit, palette, and the motion keyframes.
 *
 * `scale` multiplies --u so a widget dropped into a small layout ZONE (rather than fullscreen)
 * can be tuned down without every size being re-authored. Default 1.
 */
function baseHead({ background, scale = 1, accent } = {}) {
  const bg = background || PALETTE.bg;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *,*::before,*::after { margin:0; padding:0; box-sizing:border-box; }
  :root {
    /* 1% of the SHORTER screen edge. Every size downstream is a multiple of this, which is what
       makes one widget legible on a phone preview and on a 4K wall without being re-tuned. */
    --u: calc(1vmin * ${Number(scale) || 1});
    --brand: ${PALETTE.brand};
    --brand-dim: ${PALETTE.brandDim};
    --accent: ${accent || PALETTE.brand};
    --text: ${PALETTE.text};
    --text-dim: ${PALETTE.textDim};
    --text-mute: ${PALETTE.textMute};
    --surface: ${PALETTE.surface};

    /* THE ORIENTATION KNOB. --u is vmin, so on a landscape panel 92u is 92% of the HEIGHT — about
       half the width, which is why a widget that filled a portrait totem occupied a quarter of a
       16:9 TV. --stage is the stage width in --u and is the one number that has to change: the
       rest of every widget is already expressed against it. Content reflows instead of shrinking. */
    --stage: 92;
  }
  @media (orientation: landscape) { :root { --stage: 158; } }

  html, body { height:100%; overflow:hidden; }
  body {
    background:${bg};
    color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    font-size:calc(var(--u) * 4);
    display:flex; align-items:center; justify-content:center;
    /* Panels are often over-scanned or mounted behind a bezel; keep content off the very edge. */
    padding:calc(var(--u) * 4);
    -webkit-font-smoothing:antialiased;
  }
  .w-stage { width:100%; max-width:calc(var(--u) * var(--stage)); text-align:center; }

  /* ── shell ────────────────────────────────────────────────────────────────
     Header band, themed backdrop, content, footer signature. Every widget that
     opts in gets the same chrome, which is what makes a rotating playlist read
     as ONE product rather than four unrelated pages. Opt-in: a widget that just
     wants a stage keeps working exactly as before. */
  body.w-shell { display:block; padding:0; }
  .w-frame { position:relative; height:100%; display:flex; flex-direction:column; }

  /* The backdrop is painted ONCE and never animated. These panels run on Raspberry Pis and
     cheap Android sticks; a moving gradient underneath live content is how a widget starts
     dropping frames on the hardware that actually hangs on the wall. */
  .w-bg { position:absolute; inset:0; z-index:0; }

  .w-head { position:relative; z-index:2; flex:0 0 auto; height:calc(var(--u) * 8.5); }
  /* Band and rule share a clip-path, so the bright edge stays exactly parallel to the cut. */
  .w-head-rule, .w-head-band {
    position:absolute; left:0; right:0; top:0;
    clip-path:polygon(0 0, 100% 0, 100% 72%, 0 100%);
  }
  .w-head-rule { height:100%; background:var(--accent); }
  .w-head-band {
    height:calc(100% - var(--u) * .65);
    background:linear-gradient(100deg,
      color-mix(in srgb, var(--accent) 26%, #05070C) 0%,
      #05070C 55%,
      color-mix(in srgb, var(--accent) 14%, #05070C) 100%);
  }
  .w-head-title {
    position:absolute; inset:0; z-index:1;
    display:flex; align-items:center; justify-content:center;
    padding:0 calc(var(--u) * 5) calc(var(--u) * 1.2);
    font-size:calc(var(--u) * 3.4); font-weight:800; letter-spacing:.14em;
    text-transform:uppercase; color:var(--text);
    text-shadow:0 0 calc(var(--u) * 2) color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .w-body {
    position:relative; z-index:1; flex:1 1 auto; min-height:0;
    display:flex; align-items:center; justify-content:center;
    padding:calc(var(--u) * 4);
  }
  .w-foot {
    position:relative; z-index:2; flex:0 0 auto;
    padding:0 calc(var(--u) * 5) calc(var(--u) * 3);
    text-align:right; font-size:calc(var(--u) * 2.6); font-weight:700;
    letter-spacing:.12em; text-transform:uppercase; color:var(--accent);
  }
  .w-foot:empty { display:none; }

  /* ── entrance ─────────────────────────────────────────────────────────────
     Staggered rise. --d is the per-element delay, set inline so a widget can
     order its own elements without new keyframes. */
  @keyframes wRise {
    from { opacity:0; transform:translateY(calc(var(--u) * 2.5)); }
    to   { opacity:1; transform:none; }
  }
  .w-rise { animation: wRise 620ms cubic-bezier(.22,1,.36,1) both; animation-delay: var(--d, 0ms); }

  /* ── data change ──────────────────────────────────────────────────────────
     Applied by script when a VALUE changes, then removed. Not a loop: motion
     that never stops is what makes a screen tiring to sit beside. */
  @keyframes wPop {
    0%   { transform:scale(1); }
    45%  { transform:scale(1.08); }
    100% { transform:scale(1); }
  }
  .w-pop { animation: wPop 520ms cubic-bezier(.34,1.56,.64,1); }

  @keyframes wFlipIn {
    from { opacity:0; transform:rotateX(-70deg); }
    to   { opacity:1; transform:none; }
  }
  .w-flip { animation: wFlipIn 480ms cubic-bezier(.22,1,.36,1) both; animation-delay: var(--d, 0ms); }

  /* Soft brand glow behind a focal element. Sized in --u so it scales with everything else. */
  .w-glow { position:relative; }
  .w-glow::after {
    content:''; position:absolute; inset:-18%; z-index:-1; border-radius:50%;
    background:radial-gradient(circle, ${PALETTE.brand}22 0%, transparent 70%);
  }

  /* ── waiting for first data ───────────────────────────────────────────── */
  @keyframes wPulse { 0%,100% { opacity:.35; } 50% { opacity:.75; } }
  .w-loading { animation: wPulse 1.6s ease-in-out infinite; color:var(--text-mute); }

  /* Waiting rooms, clinics, hospitals. Respect the setting rather than assume nobody minds. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration:1ms !important; animation-iteration-count:1 !important;
      transition-duration:1ms !important;
    }
  }
</style>`;
}

/*
 * Themed backdrops, built from gradients rather than photographs.
 *
 * The look being matched uses licensed stock art — a stadium at night, out-of-focus lottery
 * balls, a printed ticket. Shipping someone else's artwork is not an option, and bundling
 * photography of our own would put megabytes on a player that may be on a 3G modem. These are
 * a few hundred bytes of CSS, scale to any resolution without a second asset, and take the
 * widget's accent colour so one definition serves all ten lottery games.
 *
 * They are STATIC. See .w-bg above for why nothing here animates.
 */
const BACKDROPS = {
  lottery: `
  .w-bg {
    background:
      radial-gradient(circle at 18% 26%, rgba(255,255,255,.055) 0 6%, transparent 6.4%),
      radial-gradient(circle at 79% 15%, rgba(255,255,255,.040) 0 4.5%, transparent 4.9%),
      radial-gradient(circle at 66% 61%, rgba(255,255,255,.050) 0 7%, transparent 7.4%),
      radial-gradient(circle at 25% 79%, rgba(255,255,255,.035) 0 5%, transparent 5.4%),
      radial-gradient(circle at 89% 84%, rgba(255,255,255,.045) 0 6.5%, transparent 6.9%),
      radial-gradient(ellipse 80% 40% at 50% 0%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 62%),
      linear-gradient(180deg, #120A24 0%, #07040F 62%, #05030B 100%);
  }`,
  football: `
  .w-bg {
    background:
      radial-gradient(ellipse 34% 20% at 11% 6%, rgba(255,255,255,.11), transparent 72%),
      radial-gradient(ellipse 34% 20% at 89% 6%, rgba(255,255,255,.11), transparent 72%),
      radial-gradient(ellipse 95% 42% at 50% 110%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 72%),
      linear-gradient(180deg, #05070A 0%, #040A08 56%, #02060B 100%);
  }`,
  clock: `
  .w-bg {
    background:
      repeating-linear-gradient(90deg, rgba(255,255,255,.022) 0 1px, transparent 1px calc(var(--u) * 9)),
      repeating-linear-gradient(0deg, rgba(255,255,255,.022) 0 1px, transparent 1px calc(var(--u) * 9)),
      radial-gradient(ellipse 80% 40% at 50% 0%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 60%),
      linear-gradient(180deg, #0A1626 0%, #060E1A 70%, #040A14 100%);
  }`,
  news: `
  .w-bg {
    background:
      linear-gradient(115deg, rgba(255,255,255,.055) 0%, transparent 42%),
      radial-gradient(ellipse 80% 40% at 50% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%),
      linear-gradient(180deg, #0B0507 0%, #060305 62%, #040203 100%);
  }`,
  weather: `
  .w-bg {
    background:
      radial-gradient(circle at 74% 18%, rgba(255,255,255,.07) 0 9%, transparent 9.5%),
      radial-gradient(ellipse 80% 44% at 50% 0%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 64%),
      linear-gradient(180deg, #0A1B2E 0%, #071322 60%, #050D18 100%);
  }`,
};

// A vignette over whatever the theme painted. Panels are bright and often glare-lit; darkening
// the corners is what keeps the centred content the thing the eye lands on.
const VIGNETTE = `
  .w-bg::after {
    content:''; position:absolute; inset:0;
    box-shadow:inset 0 0 calc(var(--u) * 34) rgba(0,0,0,.62);
  }`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* The CSS for a backdrop theme. Widgets include only the one they use. */
function backdrop(theme) {
  return (BACKDROPS[theme] || BACKDROPS.clock) + VIGNETTE;
}

/*
 * The shell markup: backdrop, header band, content, footer signature.
 *
 * `content` is the widget's own markup and is inserted verbatim — it is authored here in the
 * server, never taken from a request. `title` and `footer` ARE escaped: a footer can carry
 * upstream text such as a competition round.
 */
function shell({ title, footer = '', content = '' } = {}) {
  return `<div class="w-frame">
  <div class="w-bg"></div>
  <header class="w-head">
    <div class="w-head-rule"></div>
    <div class="w-head-band"></div>
    <div class="w-head-title">${esc(title)}</div>
  </header>
  <main class="w-body">${content}</main>
  <footer class="w-foot" id="wFoot">${esc(footer)}</footer>
</div>`;
}

/*
 * Client-side helpers injected into every widget.
 *
 * wPoll keeps its LAST GOOD render on a failed fetch instead of clearing the screen — the same
 * contract the server-side caches follow. A blank panel in a shop reads as a broken product; a
 * slightly stale one reads as normal.
 */
function baseScript() {
  return `
  function wSet(el, value, animate) {
    if (!el) return;
    var next = String(value == null ? '' : value);
    if (el.textContent === next) return;      // no change -> no motion
    el.textContent = next;
    if (animate !== false) { el.classList.remove('w-pop'); void el.offsetWidth; el.classList.add('w-pop'); }
  }
  function wPoll(url, onData, everyMs) {
    var tries = 0;
    function go() {
      fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) { tries = 0; onData(d); } })
        .catch(function () { tries++; });   // keep whatever is on screen
    }
    go();
    setInterval(go, everyMs || 600000);
  }
  function wStagger(sel, step) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) els[i].style.setProperty('--d', (i * (step || 90)) + 'ms');
  }`;
}

/*
 * Weather icons as inline SVG.
 *
 * The old widget used emoji, which are rendered by the PLATFORM: the same forecast looked like a
 * different product on an Android panel, a Tizen TV and a BrightSign, and some players have no
 * colour emoji font at all and drew a hollow box. Inline SVG is identical everywhere and takes
 * the brand colour.
 */
const ICONS = {
  sun: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><circle cx="32" cy="32" r="12" fill="currentColor" stroke="none"/><g><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13 13l6 6M45 45l6 6M51 13l-6 6M19 45l-6 6"/></g></svg>`,
  cloud: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M46 46H20a12 12 0 1 1 3-23.6A16 16 0 0 1 52 28a9 9 0 0 1-6 18Z" fill="currentColor" fill-opacity=".14"/></svg>`,
  partly: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="22" cy="21" r="8" fill="currentColor" stroke="none"/><path d="M22 5v5M6 21h5M11 10l3 3M33 10l-3 3"/><path d="M50 48H26a10 10 0 1 1 2.6-19.7A13 13 0 0 1 54 33a7.5 7.5 0 0 1-4 15Z" fill="currentColor" fill-opacity=".14"/></svg>`,
  rain: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M46 38H20a12 12 0 1 1 3-23.6A16 16 0 0 1 52 20a9 9 0 0 1-6 18Z" fill="currentColor" fill-opacity=".14"/><path d="M22 46l-3 8M33 46l-3 8M44 46l-3 8"/></svg>`,
  storm: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M46 36H20a12 12 0 1 1 3-23.6A16 16 0 0 1 52 18a9 9 0 0 1-6 18Z" fill="currentColor" fill-opacity=".14"/><path d="M34 42l-8 10h8l-4 10" /></svg>`,
  snow: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M46 36H20a12 12 0 1 1 3-23.6A16 16 0 0 1 52 18a9 9 0 0 1-6 18Z" fill="currentColor" fill-opacity=".14"/><path d="M24 46v8M20 50h8M40 46v8M36 50h8"/></svg>`,
  mist: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M10 24h44M6 34h52M14 44h36M20 54h24"/></svg>`,
};

/*
 * wttr.in weather codes -> icon key. The full table is long and mostly redundant; these are the
 * ranges that matter, and anything unmatched falls back to a cloud rather than to nothing.
 */
function iconForCode(code) {
  const n = parseInt(code, 10);
  if (n === 113) return 'sun';
  if (n === 116) return 'partly';
  if (n === 119 || n === 122) return 'cloud';
  if ([143, 248, 260].includes(n)) return 'mist';
  if ([200, 386, 389, 392, 395].includes(n)) return 'storm';
  if (n >= 179 && n <= 230) return 'snow';
  if ([227, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377].includes(n)) return 'snow';
  if (n >= 176) return 'rain';
  return 'cloud';
}

module.exports = { baseHead, baseScript, backdrop, shell, esc, ICONS, iconForCode, PALETTE };
