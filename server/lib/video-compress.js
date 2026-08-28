'use strict';

/*
 * Loop OS video compression — H.264 / 1080p / AAC, off the upload path.
 *
 * WHY IT IS A QUEUE AND NOT INLINE: transcoding a clip takes seconds to minutes. Doing it inside
 * POST /api/content would hold the request open for the whole encode and time out any reverse
 * proxy in front of us. So ingest stores the original, marks the row 'pending', and returns; this
 * module picks it up afterwards and swaps the bytes underneath when it succeeds.
 *
 * ONE AT A TIME, for the same reason lib/image-ops serialises its decodes: ffmpeg will happily
 * saturate every core it is given, and this server shares its box with the panels' websockets and
 * heartbeats. A single encode at 'faster' leaves the loop responsive; three do not.
 *
 * BEST-EFFORT BY CONTRACT, like every other derived artefact in the ingest path. If ffmpeg is
 * missing, times out, or produces something bigger than what it started with, the ORIGINAL file
 * stays exactly where it was and the row is still playable. Compression is an optimisation; the
 * upload is the product.
 *
 * THE BYTES CHANGE UNDERNEATH A LIVE ASSET. An id whose bytes change without its updated_at
 * moving is the one way a player's offline cache can be permanently wrong (see the note on
 * content.updated_at in schema.sql), so a successful swap bumps the revision and pushes a
 * playlist update to every screen showing it — the same discipline PUT /:id/replace follows.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { db } = require('../db/database');
const config = require('../config');
const { mediaToolStatus } = require('./media-tools');

let io = null;               // set by start(); background services get it the same way as services/scheduler.js
const queue = [];            // content ids awaiting a transcode
const queued = new Set();    // membership test, so the same id is never enqueued twice
let running = false;
let toolsOk = null;          // null = not probed yet

// Reset to 'pending' rather than left as 'processing' if we are torn down mid-encode; a row stuck
// on 'processing' would show "Processando" in the library forever with nothing working on it.
function markPending(id) {
  db.prepare("UPDATE content SET processing_status = 'pending' WHERE id = ?").run(id);
}

/*
 * The filter chain, in two steps and in this order:
 *   1. scale ... force_original_aspect_ratio=decrease — fit INSIDE the box, aspect preserved.
 *      min(iw,W)/min(ih,H) is what makes it never upscale: a 1280x720 clip asks to be at most
 *      1280x720, so the scale is a no-op rather than a blur.
 *   2. trunc(iw/2)*2 — H.264 4:2:0 cannot encode odd dimensions, and step 1 can easily land on
 *      one. Without this, ffmpeg fails with "width not divisible by 2".
 *
 * ── THE BOX MUST ARRIVE ALREADY ORIENTED ─────────────────────────────────────────────────────
 * This function is not the bug and never was; what it was HANDED was. It used to receive a flat
 * 1920x1080 for everything, so a portrait 1080x1920 clip had its height clamped to 1080 and the
 * width came down with it: 1080 became 608. Twelve of one customer's seventeen videos were stored
 * at 608x1080 — 56% of the width they arrived with — and then stretched back to 1080 on the
 * portrait screens they were made for.
 *
 * lib/media-box.js now decides the box from the SOURCE's own orientation, so a portrait clip is
 * measured against 1080x1920. Callers must pass that, never the raw config.
 */
function videoFilter(maxW, maxH) {
  return `scale='min(iw,${maxW})':'min(ih,${maxH})':force_original_aspect_ratio=decrease,` +
         'scale=trunc(iw/2)*2:trunc(ih/2)*2';
}

function ffmpegArgs(src, dest, box) {
  const c = config.mediaCompression;
  const kbps = c.videoBitrateKbps;
  // The box is the source's own, from lib/media-box.js. Falling back to the raw config would
  // reintroduce the landscape-box bug for any caller that forgot to pass one, so it is required
  // in practice and merely defended here.
  const b = box || { w: c.maxWidth, h: c.maxHeight };
  return [
    '-y', '-i', src,
    '-vf', videoFilter(b.w, b.h),
    '-c:v', 'libx264',
    // High profile: better compression than Main at the same quality, and universally decoded by
    // the Android/Tizen/webOS/BrightSign players this project targets.
    '-profile:v', 'high', '-level', '4.1',
    '-preset', c.videoPreset,
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${c.videoAudioBitrateKbps}k`,
    // A clip with no audio track must not fail the encode.
    '-movflags', '+faststart',
    dest,
  ];
}

// Every device currently showing this asset — the ones whose cached copy just went stale.
function devicesShowing(contentId) {
  return db.prepare(`
    SELECT DISTINCT d.id AS device_id FROM devices d
    JOIN playlists p ON d.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(contentId).map((r) => r.device_id);
}

function pushToPlayers(contentId) {
  if (!io) return;
  try {
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('./command-queue');
    const deviceNs = io.of('/device');
    for (const id of new Set(devicesShowing(contentId))) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, id, buildPlaylistPayload);
    }
  } catch { /* best-effort: a failed push self-heals on the next playlist refresh */ }
}

/*
 * Transcode one content row. Returns a short reason string for logging.
 *
 * The encode writes to a sibling temp file and only replaces the original once it is known to be
 * both valid and smaller — so an interrupted or failed encode can never leave a truncated file
 * where a playable one used to be.
 */
async function compressOne(contentId) {
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!row) return 'row gone';
  if (!row.filepath || row.remote_url) return 'nothing local to compress';

  const stored = path.basename(row.filepath);
  const src = path.join(config.contentDir, stored);
  if (!fs.existsSync(src)) return 'file missing';

  const originalBytes = fs.statSync(src).size;

  /*
   * DECIDE BEFORE ENCODING, because the cheapest encode is the one that does not happen.
   *
   * A file already inside its own box has no resolution to reclaim, and every pass through H.264
   * spends quality it cannot get back. The only reason left to touch such a file is weight, and
   * that path re-encodes WITHOUT resizing.
   */
  const mediaBox = require('./media-box');
  const plan = mediaBox.planFor({
    width: row.width, height: row.height,
    sizeBytes: originalBytes, durationSec: row.duration_sec,
  }, config.mediaCompression);

  if (plan.action === 'skip') {
    db.prepare("UPDATE content SET processing_status = 'done' WHERE id = ?").run(contentId);
    console.log(`[MEDIA] ${row.filename}: mantido como está — ${plan.reason}`);
    return 'already within box';
  }
  console.log(`[MEDIA] ${row.filename}: ${plan.action} — ${plan.reason}`);
  // .mp4 regardless of what came in: the output IS an MP4 (H.264 + AAC + faststart), and leaving
  // a .mkv/.avi name on it would misdescribe the bytes to players that sniff by extension.
  const outName = `${stored.replace(/\.[^.]+$/, '')}.loop.mp4`;
  const tmp = path.join(config.contentDir, `.tmp_${outName}`);

  db.prepare("UPDATE content SET processing_status = 'processing' WHERE id = ?").run(contentId);

  try {
    await execFileAsync('ffmpeg', ffmpegArgs(src, tmp, plan.box), { timeout: config.mediaCompression.videoTimeoutMs });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    db.prepare("UPDATE content SET processing_status = 'failed' WHERE id = ?").run(contentId);
    // Truncated because ffmpeg's stderr is the whole encode log and the tail is the useful part.
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-2).join(' ');
    console.warn(`[MEDIA] compression failed for ${contentId} (${row.filename}): ${detail.slice(0, 300)}`);
    return 'ffmpeg failed';
  }

  const newBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  // A zero-byte or larger result is not worth taking. The second case is real: a clip already
  // encoded below our target bitrate gets BIGGER when re-encoded at it.
  if (!newBytes || newBytes >= originalBytes) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    db.prepare("UPDATE content SET processing_status = 'done' WHERE id = ?").run(contentId);
    return newBytes ? `kept original (${newBytes} >= ${originalBytes})` : 'empty output';
  }

  // Re-probe the OUTPUT: its duration/dimensions are what the row must now describe, and the
  // probe doubles as a validity check on the file we are about to promote.
  let width = row.width, height = row.height, durationSec = row.duration_sec;
  try {
    const { stdout } = await execFileAsync('ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tmp], { timeout: 15000 });
    const info = JSON.parse(stdout);
    const v = info.streams?.find((s) => s.codec_type === 'video');
    if (!v) throw new Error('no video stream in output');
    const { videoDisplayDims } = require('./media-orientation');
    ({ width, height } = videoDisplayDims(v));
    if (info.format?.duration) durationSec = parseFloat(info.format.duration);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    db.prepare("UPDATE content SET processing_status = 'failed' WHERE id = ?").run(contentId);
    console.warn(`[MEDIA] compressed output rejected for ${contentId}: ${err.message}`);
    return 'output failed probe';
  }

  const finalPath = path.join(config.contentDir, outName);
  try {
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    db.prepare("UPDATE content SET processing_status = 'failed' WHERE id = ?").run(contentId);
    console.warn(`[MEDIA] could not promote compressed file for ${contentId}: ${err.message}`);
    return 'rename failed';
  }

  // Point the row at the new bytes. updated_at uses the same MAX(now, previous+1) guard as
  // PUT /:id/replace: a revision that does not move is a player cache that never updates, and
  // seconds-resolution timestamps collide easily when a small file is compressed right after
  // upload. Row-not-found / replaced-meanwhile is handled by the WHERE clause.
  const res = db.prepare(`
    UPDATE content
       SET filepath = ?, mime_type = 'video/mp4', file_size = ?, width = ?, height = ?,
           duration_sec = ?, processing_status = 'done',
           updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at, 0), created_at) + 1)
     WHERE id = ? AND filepath = ?
  `).run(outName, newBytes, width, height, durationSec, contentId, row.filepath);

  if (res.changes === 0) {
    // The row was deleted or replaced while ffmpeg ran. contentDir has no garbage collector, so
    // the file we just promoted has to go — same rule thumbnail-backfill follows.
    try { fs.unlinkSync(finalPath); } catch { /* best-effort */ }
    return 'row changed during encode';
  }

  // Original superseded. Only now, once the row points somewhere else, is it safe to delete.
  try { fs.unlinkSync(src); } catch (err) { console.warn(`[MEDIA] could not remove original ${stored}: ${err.message}`); }

  pushToPlayers(contentId);

  const pct = Math.round((1 - newBytes / originalBytes) * 100);
  return `${(originalBytes / 1048576).toFixed(1)}MB -> ${(newBytes / 1048576).toFixed(1)}MB (-${pct}%)`;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      queued.delete(id);
      try {
        const outcome = await compressOne(id);
        console.log(`[MEDIA] compressed ${id}: ${outcome}`);
      } catch (err) {
        // compressOne handles its own failures; this catches anything genuinely unexpected so one
        // bad row cannot kill the drain loop and strand everything queued behind it.
        console.error(`[MEDIA] compression crashed for ${id}: ${err.message}`);
        try { db.prepare("UPDATE content SET processing_status = 'failed' WHERE id = ?").run(id); } catch { /* db may be closing */ }
      }
    }
  } finally {
    running = false;
  }
}

/*
 * Queue a video for compression. Safe to call from a request handler: it marks the row and
 * returns immediately, and the drain runs on a later tick.
 *
 * Silently does nothing when compression is off or ffmpeg is absent — in both cases the row keeps
 * its 'done' status, because there is no work outstanding, only work that will never happen.
 */
function enqueue(contentId) {
  if (!config.mediaCompression.enabled) return false;
  if (queued.has(contentId)) return true;

  queued.add(contentId);
  queue.push(contentId);
  markPending(contentId);

  setImmediate(async () => {
    if (toolsOk === null) {
      const t = await mediaToolStatus();
      toolsOk = !!(t.ffmpeg && t.ffprobe);
      if (!toolsOk) console.warn('[MEDIA] ffmpeg/ffprobe missing — video compression disabled, originals kept as-is');
    }
    if (!toolsOk) {
      // Nothing will ever process these. Clear the queue and put the rows back to a resting
      // state, so the library does not show "Processando" forever on a host without ffmpeg.
      while (queue.length) {
        const id = queue.shift();
        queued.delete(id);
        try { db.prepare("UPDATE content SET processing_status = 'done' WHERE id = ?").run(id); } catch { /* db may be closing */ }
      }
      return;
    }
    drain();
  });
  return true;
}

/* Called from server.js after the socket server exists, so a swap can notify live panels. */
function start(socketIo) {
  io = socketIo;
  // Anything left mid-flight by a restart. 'processing' means a previous run died holding it.
  try {
    const stuck = db.prepare("SELECT id FROM content WHERE processing_status IN ('pending','processing')").all();
    for (const r of stuck) { if (!queued.has(r.id)) { queued.add(r.id); queue.push(r.id); } }
    if (stuck.length) {
      console.log(`[MEDIA] re-queued ${stuck.length} video(s) interrupted by a restart`);
      setImmediate(() => enqueue(stuck[0].id));   // primes the ffmpeg probe, then drains the rest
    }
  } catch (e) {
    console.warn(`[MEDIA] could not re-queue interrupted compressions: ${e.message}`);
  }
}

module.exports = { start, enqueue, compressOne, videoFilter, ffmpegArgs, pendingCount: () => queue.length };
