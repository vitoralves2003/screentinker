'use strict';

// Retroactive media compression, for the library that already exists.
//
// Ingest compresses what it receives from now on (images inline, video queued), but everything
// uploaded before this feature — and everything uploaded while ffmpeg was missing — is still
// sitting at its original size. This sweep finds those rows and puts them through the same paths.
//
// Modelled on lib/thumbnail-backfill.js and for the same reasons: one file at a time, paced with
// a pause between files, because the point is to heal the library eventually rather than to win a
// race against playback serving on the same box. It runs once per boot, well after listen.
//
// IDEMPOTENCY is the part that differs. A thumbnail has an obvious marker (thumbnail_path filled),
// but "already compressed" has none — re-running would re-encode the whole library every boot,
// each pass shaving a little more quality off. So the candidate query is deliberately narrow and
// self-limiting:
//
//   images  only rows whose stored pixels EXCEED the target box. Compressing one downscales it,
//           so it stops matching and is never picked up again. An oversized-but-tiny file is
//           left alone (below MIN_BYTES) — there is nothing to win.
//   video   only rows that are BOTH oversized-on-disk and not already at/below our dimensions.
//           lib/video-compress refuses to keep a result that is not smaller, and renames the
//           output to `.loop.mp4`, which is the marker the query then excludes.
//
// Nothing here deletes or rewrites anything itself: images go through deriveMediaMetadata (which
// promotes and cleans up), video through the compressor's own queue. Both keep the original when
// they cannot do better.

const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const config = require('../config');
const { deriveMediaMetadata } = require('./content-ingest');
const { mediaToolStatus } = require('./media-tools');
const videoCompress = require('./video-compress');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Below this an asset is not worth an encode regardless of its dimensions — the decode costs more
// than the bytes it could save, and re-encoding tiny images is how you lose quality for nothing.
const MIN_BYTES = 256 * 1024;

// Same reasoning as thumbnail-backfill's cap: a library full of undecodable files must not turn
// every boot into an hour of doomed work.
const FAILURE_CAP = 25;

async function backfillCompression({ delayMs = 1000, limit = 500 } = {}) {
  const stats = { scanned: 0, images: 0, videosQueued: 0, skipped: 0, failed: 0, savedBytes: 0, aborted: false };
  if (!config.mediaCompression.enabled) return { ...stats, disabled: true };

  const { maxWidth, maxHeight } = config.mediaCompression;
  const tools = await mediaToolStatus();

  // Local bytes only (filepath set, no remote_url), and only rows whose recorded dimensions say
  // they are bigger than a 1080p panel can show. Rows with NULL dimensions are skipped rather
  // than probed: thumbnail-backfill is what fills those in, and it runs on the same boot.
  const rows = db.prepare(`
    SELECT id, filepath, mime_type, width, height, file_size FROM content
    WHERE filepath != ''
      AND (remote_url IS NULL OR remote_url = '')
      AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')
      AND mime_type != 'image/svg+xml'
      AND width IS NOT NULL AND height IS NOT NULL
      AND (width > ? OR height > ?)
      AND file_size >= ?
      AND processing_status = 'done'
      AND filepath NOT LIKE '%.loop.mp4'
    ORDER BY file_size DESC
    LIMIT ?
  `).all(maxWidth, maxHeight, MIN_BYTES, limit);

  stats.scanned = rows.length;

  for (const row of rows) {
    if (stats.failed >= FAILURE_CAP) {
      stats.aborted = true;
      console.warn(`[MEDIA] compression backfill: stopping after ${stats.failed} failures — will retry next boot`);
      break;
    }

    const storedName = path.basename(row.filepath);
    const sourcePath = path.join(config.contentDir, storedName);
    if (!fs.existsSync(sourcePath)) { stats.skipped++; continue; }

    if (row.mime_type.startsWith('video/')) {
      // Hand it to the compressor's queue rather than transcoding here: that module owns the
      // one-at-a-time discipline, the row updates and the player cache-bust.
      if (!tools.ffmpeg || !tools.ffprobe) { stats.skipped++; continue; }
      videoCompress.enqueue(row.id);
      stats.videosQueued++;
      continue;   // no sleep: enqueueing is instant, and the queue paces itself
    }

    try {
      const before = row.file_size || fs.statSync(sourcePath).size;
      const { width, height, thumbnailPath, compressed } =
        await deriveMediaMetadata(sourcePath, storedName, row.mime_type, { compressImage: true });

      if (compressed) {
        // Same byte-change discipline as PUT /:id/replace and the video compressor: the bytes
        // behind a live id just changed, so the revision MUST move or every player cache keeps
        // serving the old file forever. The WHERE re-checks filepath so a row replaced while we
        // were encoding is not clobbered.
        const res = db.prepare(`
          UPDATE content
             SET filepath = ?, mime_type = ?, file_size = ?, width = ?, height = ?,
                 thumbnail_path = COALESCE(?, thumbnail_path),
                 updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at, 0), created_at) + 1)
           WHERE id = ? AND filepath = ?
        `).run(compressed.filepath, compressed.mime, compressed.bytes, width, height, thumbnailPath, row.id, row.filepath);

        if (res.changes === 0) {
          // Row deleted or replaced mid-encode. contentDir has no garbage collector.
          try { fs.unlinkSync(path.join(config.contentDir, compressed.filepath)); } catch { /* best-effort */ }
          stats.skipped++;
        } else {
          stats.images++;
          stats.savedBytes += Math.max(0, before - compressed.bytes);
        }
      } else {
        // Nothing to win on this one (already efficient, or a format we refuse to re-encode).
        stats.skipped++;
      }
    } catch (e) {
      stats.failed++;
      console.warn(`[MEDIA] compression backfill failed for ${row.id}: ${e.message}`);
    }

    await sleep(delayMs);
  }

  return stats;
}

module.exports = { backfillCompression, MIN_BYTES };
