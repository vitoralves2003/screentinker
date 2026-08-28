#!/usr/bin/env node
'use strict';

/*
 * WHICH FILES THE LANDSCAPE BOX ALREADY DESTROYED.
 *
 * The compression box used to be a flat 1920x1080, so a portrait video of 1080x1920 was fitted
 * into it height-first and came out 608x1080 — 56% of the width it arrived with. The original was
 * overwritten, so nothing here can repair them. What this can do is say exactly WHICH ones, so
 * they can be uploaded again rather than the whole library being re-sent on suspicion.
 *
 *   node server/scripts/squashed-media.js
 *
 * Read-only. It changes nothing and is safe to run against production.
 *
 * ── HOW A SQUASHED FILE IS RECOGNISED ────────────────────────────────────────────────────────
 * A portrait asset whose SHORT side is smaller than the short side of its proper box. A file that
 * was genuinely shot at 608x1080 is indistinguishable from a squashed one — nothing recorded the
 * original dimensions — so this reports SUSPECTS and says so. The give-away is the ratio: fitting
 * 1080x1920 into a 1920x1080 box lands on 608x1080 exactly, and a camera almost never does.
 */

const path = require('path');
process.env.DATA_DIR = process.env.DATA_DIR || '/data';

const { db } = require(path.join(__dirname, '..', 'db', 'database'));
const config = require(path.join(__dirname, '..', 'config'));
const { boxFor } = require(path.join(__dirname, '..', 'lib', 'media-box'));

const maxLong = Math.max(config.mediaCompression.maxWidth, config.mediaCompression.maxHeight);
const maxShort = Math.min(config.mediaCompression.maxWidth, config.mediaCompression.maxHeight);

const rows = db.prepare(`
  SELECT c.id, c.filename, c.width, c.height, c.file_size, c.workspace_id, w.name AS workspace
    FROM content c
    LEFT JOIN workspaces w ON w.id = c.workspace_id
   WHERE c.width > 0 AND c.height > 0
   ORDER BY w.name, c.filename`).all();

const suspects = [];
for (const r of rows) {
  if (r.height <= r.width) continue;                       // landscape or square: never squashed this way
  const box = boxFor(r.width, r.height, maxLong, maxShort);

  /*
   * The short side should be either the box's short side (it was reduced) or the source's own (it
   * fitted). Anything BELOW the box's short side means the fit was computed against the wrong
   * axis — which is the bug.
   */
  if (r.width < box.w) {
    // What it most likely was: undo the landscape fit and see if it lands on a round number.
    const impliedH = Math.round((r.height * r.height) / r.width);
    suspects.push({ ...r, was: `${r.height}x${impliedH}`, now: `${r.width}x${r.height}`, box });
  }
}

if (!rows.length) {
  console.log('Nenhuma mídia com dimensões conhecidas.');
} else if (!suspects.length) {
  console.log(`${rows.length} arquivo(s) verificados. Nenhum parece ter sido esmagado.`);
} else {
  console.log(`${suspects.length} de ${rows.length} arquivo(s) provavelmente esmagados pela caixa deitada.`);
  console.log('Reenvie estes: o original foi substituído e não há como recuperá-lo daqui.\n');

  let lastWs = null;
  for (const s of suspects) {
    if (s.workspace !== lastWs) { console.log(`  ${s.workspace || '(sem cliente)'}`); lastWs = s.workspace; }
    const lost = Math.round(100 - (s.width / s.box.w) * 100);
    console.log(`    ${s.now.padEnd(11)} deveria ser ~${s.was.padEnd(11)} (-${lost}% de largura)  ${s.filename}`);
  }
  console.log('\nSuspeita, não certeza: nada registrou as dimensões originais, e um arquivo');
  console.log('genuinamente feito nesse tamanho ficaria idêntico a um esmagado.');
}
