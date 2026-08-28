'use strict';

/*
 * HOW BIG A STORED ASSET IS ALLOWED TO BE — and when to leave it completely alone.
 *
 * ── THE INCIDENT THIS IS THE RECORD OF ───────────────────────────────────────────────────────
 * The compression box was a LANDSCAPE 1920x1080, applied to everything. A portrait video of
 * 1080x1920 has its height clamped at 1080, and fitting inside that box takes the width down with
 * it: 1080 becomes 608. Twelve of a customer's seventeen videos were stored at 608x1080 — 56% of
 * the width they arrived with — and then stretched back up to 1080 on the portrait screens they
 * were made for. It looked exactly like what it was: a picture enlarged from something smaller.
 *
 * The originals were replaced, so nothing recovers them; they have to be uploaded again.
 *
 * Vertical is not an edge case here. Portrait screens are the common shape in Brazilian retail
 * signage, which means the default box was wrong for most of what this product carries.
 *
 * ── AND WHEN NOT TO TOUCH IT AT ALL ──────────────────────────────────────────────────────────
 * A file that already fits is only ever made worse by a re-encode. There is no resolution to
 * reclaim, and every pass through H.264 or JPEG spends quality it cannot get back.
 *
 * The one reason to re-encode a right-sized file is SIZE: a 1080p clip at 50 Mbps is a 400 MB
 * download over a shop's wifi. So a bitrate ceiling stays, deliberately generous, and when it
 * fires the file is re-encoded WITHOUT changing its dimensions — the bytes come down, the picture
 * does not.
 */

/*
 * The box for a given source, oriented like the source.
 *
 * long/short rather than width/height is the whole fix: the limit is "1920 on the long edge, 1080
 * on the short", and which of those is the width depends on the file, not on an assumption made
 * once in a config file.
 *
 * A square source gets the SHORT limit on both edges. Giving it the long one would let a
 * 1920x1920 asset through at four times the pixels of a 1080p frame, on panels chosen to play
 * 1080p.
 */
function boxFor(srcW, srcH, maxLong, maxShort) {
  const long = Math.max(maxLong, maxShort);
  const short = Math.min(maxLong, maxShort);
  if (!(srcW > 0) || !(srcH > 0)) return { w: long, h: short };      // unknown: the old behaviour
  if (srcW > srcH) return { w: long, h: short };                      // landscape
  if (srcH > srcW) return { w: short, h: long };                      // portrait
  return { w: short, h: short };                                      // square
}

/* Does this source already fit inside its own box? */
function fitsInBox(srcW, srcH, maxLong, maxShort) {
  if (!(srcW > 0) || !(srcH > 0)) return false;                       // unknown: do not assume
  const box = boxFor(srcW, srcH, maxLong, maxShort);
  return srcW <= box.w && srcH <= box.h;
}

/*
 * The decision, in one place, for one file.
 *
 * Three outcomes rather than a boolean, because "re-encode" and "re-encode without resizing" are
 * genuinely different jobs and a caller that could not tell them apart would either resize a file
 * that did not need it or leave a 400 MB download alone.
 *
 * @returns {{action:'skip'|'shrink'|'requantise', reason:string, box:{w:number,h:number}}}
 */
function planFor({ width, height, sizeBytes, durationSec }, cfg) {
  const maxLong = Math.max(cfg.maxWidth, cfg.maxHeight);
  const maxShort = Math.min(cfg.maxWidth, cfg.maxHeight);
  const box = boxFor(width, height, maxLong, maxShort);

  if (!fitsInBox(width, height, maxLong, maxShort)) {
    return { action: 'shrink', reason: `${width}x${height} excede ${box.w}x${box.h}`, box };
  }

  /*
   * It fits. The only remaining reason to touch it is weight — and the ceiling is set at a
   * MULTIPLE of the target so it catches the genuinely wild file and nothing else. A clip already
   * near the target bitrate is left alone: re-encoding it would spend real quality to save a few
   * percent of bytes.
   */
  const ceilingKbps = (cfg.videoBitrateKbps || 0) * (cfg.bitrateCeilingFactor || 2);
  if (ceilingKbps > 0 && durationSec > 0 && sizeBytes > 0) {
    const actualKbps = (sizeBytes * 8) / 1000 / durationSec;
    if (actualKbps > ceilingKbps) {
      return {
        action: 'requantise',
        reason: `${Math.round(actualKbps)} kbps acima do teto de ${Math.round(ceilingKbps)} kbps`,
        box: { w: width, h: height },      // dimensions untouched: only the bitrate comes down
      };
    }
  }

  return { action: 'skip', reason: `${width}x${height} já cabe em ${box.w}x${box.h}`, box };
}

module.exports = { boxFor, fitsInBox, planFor };
