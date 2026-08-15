'use strict';

// Loop OS media compression (lib/image-ops-core.ingestImage, lib/video-compress,
// lib/compression-backfill). The cases that matter are the ones where "just re-encode it"
// silently destroys something:
//   - an oversized photo shrinks and is downscaled to fit 1080p
//   - an image already inside the box keeps its ORIGINAL bytes (a re-encode that grows the
//     file is not compression)
//   - a transparent PNG stays a PNG — JPEG would give a logo an opaque black background
//   - the ffmpeg filter never upscales, and asks for the codecs the players actually decode
//   - with ffmpeg absent, a queued video does NOT strand the row on 'pending' (which the
//     library renders as "Processando…" forever)

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-compress-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const core = require('../lib/image-ops-core');

// sharp is a devDependency used ONLY to author fixtures, exactly as the other media tests use
// it. Nothing in the shipped compression path touches it — the runtime is jimp + @jsquash,
// because sharp is native and is not installed by the production `npm ci --omit=dev`.
const sharp = require('sharp');

const tmpFile = (name) => path.join(config.contentDir, name);

function ensureDir() { fs.mkdirSync(config.contentDir, { recursive: true }); }

async function compress(src, name) {
  return core.ingestImage(src, {
    thumbDest: tmpFile(`thumb_${name}.jpg`), thumbWidth: 320, thumbQuality: 70,
    compressDest: tmpFile(`c_${name}`),
    maxWidth: config.mediaCompression.maxWidth,
    maxHeight: config.mediaCompression.maxHeight,
    quality: config.mediaCompression.imageQuality,
  });
}

test('an oversized photo is downscaled into the 1080p box and gets much smaller', async () => {
  ensureDir();
  // Noise, so the fixture does not compress to nothing and the size comparison means something.
  const raw = Buffer.alloc(4000 * 3000 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.sin(i / 7) * 127 + 128) | 0;
  const src = tmpFile('big.jpg');
  await sharp(raw, { raw: { width: 4000, height: 3000, channels: 3 } }).jpeg({ quality: 95 }).toFile(src);
  const before = fs.statSync(src).size;

  const r = await compress(src, 'big.jpg');

  assert.equal(r.compressed, true, 'a 4000x3000 photo must compress');
  assert.equal(r.compressedMime, 'image/jpeg');
  // Fits INSIDE the box with aspect preserved: 4:3 capped by height -> 1440x1080.
  assert.equal(r.height, 1080);
  assert.equal(r.width, 1440);
  assert.ok(r.compressedBytes < before, `expected < ${before}, got ${r.compressedBytes}`);
  assert.equal(r.thumbnailWritten, true, 'the thumbnail still rides along with the same decode');
});

test('an image already inside the box keeps its original bytes', async () => {
  ensureDir();
  const src = tmpFile('small.jpg');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 90, b: 200 } } })
    .jpeg().toFile(src);
  const before = fs.statSync(src).size;

  const r = await compress(src, 'small.jpg');

  assert.equal(r.compressed, false, 're-encoding a small flat image makes it BIGGER — must be refused');
  assert.match(r.compressionSkipped, /larger/);
  assert.equal(r.width, 800, 'dimensions still describe the file that is actually on disk');
  assert.equal(r.height, 600);
  assert.equal(fs.statSync(src).size, before, 'the original must be untouched');
  assert.equal(fs.existsSync(tmpFile('c_small.jpg')), false, 'and no compressed file left behind');
});

test('a transparent PNG stays a PNG — alpha is never flattened to black', async () => {
  ensureDir();
  const src = tmpFile('alpha.png');
  await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.4 } } })
    .png().toFile(src);

  const r = await compress(src, 'alpha.png');

  assert.equal(r.compressed, true, 'it is oversized, so it should still be downscaled');
  assert.equal(r.compressedMime, 'image/png', 'transparency forces PNG output');
  assert.equal(r.compressedExt, '.png');

  const meta = await sharp(tmpFile('c_alpha.png')).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.hasAlpha, true, 'the alpha channel must survive compression');
});

test('an opaque PNG is allowed to become a JPEG', async () => {
  ensureDir();
  const src = tmpFile('opaque.png');
  await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png().toFile(src);

  const r = await compress(src, 'opaque.png');

  assert.equal(r.compressed, true);
  assert.equal(r.compressedMime, 'image/jpeg', 'no transparency to preserve, so JPEG is the smaller choice');
});

test('the ffmpeg command never upscales and targets the codecs players decode', () => {
  const { videoFilter, ffmpegArgs } = require('../lib/video-compress');

  // min(iw,W) is what makes a 1280x720 source stay 1280x720 instead of being blown up to 1080p.
  const filter = videoFilter(1920, 1080);
  assert.match(filter, /min\(iw,1920\)/);
  assert.match(filter, /min\(ih,1080\)/);
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  // H.264 4:2:0 cannot encode odd dimensions — without this, portrait clips fail to encode.
  assert.match(filter, /trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);

  const args = ffmpegArgs('/in.mov', '/out.mp4');
  const joined = args.join(' ');
  assert.match(joined, /-c:v libx264/);
  assert.match(joined, /-profile:v high/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-pix_fmt yuv420p/);
  assert.equal(args[args.length - 1], '/out.mp4', 'output path must be last');
  // The configured bitrate lands in the 4-8 Mbps band the spec asks for.
  const bitrate = config.mediaCompression.videoBitrateKbps;
  assert.ok(bitrate >= 4000 && bitrate <= 8000, `bitrate ${bitrate}kbps outside the 4-8Mbps band`);
});

test('with ffmpeg missing, a queued video is not stranded on "Processando"', async () => {
  const { db } = require('../db/database');
  const videoCompress = require('../lib/video-compress');

  db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, file_size, processing_status)
              VALUES ('vid-1','clip.mp4','clip.mp4','video/mp4',1000,'done')`).run();

  videoCompress.enqueue('vid-1');
  // enqueue() marks it immediately so the UI reflects the intent...
  assert.equal(db.prepare("SELECT processing_status AS s FROM content WHERE id = 'vid-1'").get().s, 'pending');

  // ...and the deferred tool probe resolves it either way. On a host WITH ffmpeg the row is
  // picked up and processed (file is absent here, so it settles); on a host WITHOUT, the queue
  // is drained back to 'done'. Both must leave a terminal status — never 'pending' forever.
  await new Promise((r) => setTimeout(r, 1500));

  const status = db.prepare("SELECT processing_status AS s FROM content WHERE id = 'vid-1'").get().s;
  assert.notEqual(status, 'pending', 'a row left on pending shows "Processando…" in the library forever');
  assert.ok(['done', 'failed'].includes(status), `expected a terminal status, got ${status}`);
});

test.after(async () => {
  await require('../lib/image-ops').shutdown();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows file locks */ }
});
