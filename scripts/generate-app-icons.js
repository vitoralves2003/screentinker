#!/usr/bin/env node
'use strict';

/*
 * Every Loop Player icon, generated from the one piece of brand art.
 *
 * The source is frontend/assets/loop-player-icon.png — the loop mark, brand green on transparent,
 * 180x180 with the mark itself occupying a 180x95 band. Everything below is derived from it, so
 * the app icon, the launcher icon, the TV banner, the store icon and the dashboard's home-screen
 * icon cannot drift apart: change the art, run this, commit what it writes.
 *
 *     node scripts/generate-app-icons.js
 *
 * WHY A SCRIPT AND NOT A DESIGN EXPORT: there are 24 files across five Android densities, two
 * launcher shapes, a monochrome layer and three store sizes. Hand-exporting that once is tedious;
 * hand-exporting it again when the mark is tweaked is how a fleet ends up with three slightly
 * different icons.
 *
 * ALPHA CRISPENING: the master is 180px and some targets are larger, so a plain upscale leaves a
 * soft edge that reads as cheap at icon sizes. The mark is a flat two-tone shape, so after the
 * resample the alpha channel is pushed back through a steep curve around 50%: the geometry is
 * preserved, the edge returns to roughly one pixel, and the antialiasing survives. A true vector
 * master would be better still — if the designer's original ever turns up, point SRC at it and
 * drop CRISPEN to 1.
 */

const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'frontend', 'assets', 'loop-player-icon.png');
const WORDMARK = path.join(ROOT, 'frontend', 'assets', 'loop-player-logo.png');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// The mark's own green, sampled from the art — not the panel's --sidebar-brand, which is a
// slightly different green used for UI accents.
const GREEN = { r: 36, g: 217, b: 74 };
const WHITE = { r: 255, g: 255, b: 255 };
// The product's ink. Same --bg-primary the dashboard paints, so the icon and the app it opens
// are the same colour.
const INK = '#06111E';

// The mark inside the 180x180 source, measured rather than guessed.
const MARK = { left: 0, top: 42, width: 180, height: 95 };
const ASPECT = MARK.height / MARK.width;
const CRISPEN = 3;

const written = [];

/* The mark at a given pixel width, recoloured, as raw RGBA. */
async function mark(width, rgb) {
  const height = Math.round(width * ASPECT);
  const { data, info } = await sharp(SRC)
    .ensureAlpha()
    .extract(MARK)
    .resize({ width, height, kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    const crisp = Math.min(1, Math.max(0, (a - 0.5) * CRISPEN + 0.5));
    data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b;
    data[i + 3] = Math.round(crisp * 255);
  }
  return { buf: data, width: info.width, height: info.height };
}

async function write(file, image) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await image.png({ compressionLevel: 9 }).toFile(file);
  written.push(path.relative(ROOT, file));
}

/* Mark centred on a canvas, over an optional background SVG. */
async function compose(file, canvas, markWidth, { rgb = GREEN, background = null } = {}) {
  const m = await mark(markWidth, rgb);
  const layers = [];
  if (background) layers.push({ input: Buffer.from(background) });
  layers.push({
    input: m.buf,
    raw: { width: m.width, height: m.height, channels: 4 },
    left: Math.round((canvas - m.width) / 2),
    top: Math.round((canvas - m.height) / 2),
  });
  await write(file, sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers));
}

const squareBg = (size) =>
  `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="${INK}"/></svg>`;
const circleBg = (size) =>
  `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${INK}"/></svg>`;
const flatBg = (size) =>
  `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${INK}"/></svg>`;

// Android densities, as multiples of the baseline.
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];

(async () => {
  for (const [density, scale] of DENSITIES) {
    const dir = path.join(RES, `mipmap-${density}`);

    /*
     * Adaptive icon foreground: a 108dp canvas of which the centre 66dp is guaranteed visible
     * under every launcher mask. The mark's widest points sit on its horizontal centre line,
     * exactly where a circular mask is widest, so 64dp of width clears every shape with room.
     */
    const fg = Math.round(108 * scale);
    await compose(path.join(dir, 'ic_launcher_foreground.png'), fg, Math.round(64 * scale));
    // Themed icons (Android 13+): the same shape, flat white, tinted by the system.
    await compose(path.join(dir, 'ic_launcher_monochrome.png'), fg, Math.round(64 * scale), { rgb: WHITE });

    // Legacy launcher icons, for the Android 7 and 8.0 panels that predate adaptive icons.
    const legacy = Math.round(48 * scale);
    await compose(path.join(dir, 'ic_launcher.png'), legacy, Math.round(legacy * 0.72), { background: squareBg(legacy) });
    await compose(path.join(dir, 'ic_launcher_round.png'), legacy, Math.round(legacy * 0.66), { background: circleBg(legacy) });
  }

  /*
   * TV banner: the launcher tile on Android TV and Fire TV, and it is a wide branding surface
   * rather than an icon — so it carries the wordmark, which is what a viewer sitting three metres
   * away can actually read.
   */
  const BANNER = { w: 320, h: 180 };
  const logo = await sharp(WORDMARK).resize({ width: 214, kernel: 'lanczos3' }).png().toBuffer();
  const logoMeta = await sharp(logo).metadata();
  await write(path.join(RES, 'drawable-xhdpi', 'banner.png'), sharp({
    create: { width: BANNER.w, height: BANNER.h, channels: 4, background: { r: 6, g: 17, b: 30, alpha: 1 } },
  }).composite([{
    input: logo,
    left: Math.round((BANNER.w - logoMeta.width) / 2),
    top: Math.round((BANNER.h - logoMeta.height) / 2),
  }]));

  // The dashboard's own home-screen icons. These were still the upstream product's blue television.
  await compose(path.join(ROOT, 'frontend', 'assets', 'icon-192.png'), 192, 138, { background: squareBg(192) });
  await compose(path.join(ROOT, 'frontend', 'assets', 'icon-512.png'), 512, 368, { background: squareBg(512) });

  /*
   * Store listing icon. Google Play and Amazon both round it themselves and neither accepts
   * transparency, so this one is a flat square — no corner radius of our own to fight theirs.
   */
  await compose(path.join(ROOT, 'android', 'store', 'icon-512.png'), 512, 330, { background: flatBg(512) });

  console.log(`${written.length} files written:`);
  for (const f of written) console.log('  ' + f);
})();
