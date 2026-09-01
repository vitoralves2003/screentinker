const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
// Phase 2.2k: workspace-aware access. requirePlaylistOwnership is replaced
// by read/write helpers gated on the playlist's workspace_id.
const { accessContext } = require('../lib/tenancy');
const { resolveItemDuration } = require('../lib/item-duration');
const { compileRules } = require('../lib/schedule-compile');
// Loop OS sub-lists: validation for the one-of-three / one-level-deep invariants, plus the
// publish-time expansion that turns rotating slots into a plain flat playlist.
const { SubListError, requireSingleTarget, validateSubList, expandSnapshot } = require('../lib/sublists');
const { checkSublistsEnabled } = require('../middleware/subscription');

// Re-probe video duration with ffprobe if content.duration_sec is missing
async function probeAndUpdateDuration(content) {
  if (content.duration_sec) return content.duration_sec;
  if (!content.mime_type || !content.mime_type.startsWith('video/')) return null;
  if (!content.filepath) return null;
  try {
    const { execFile } = require('child_process');
    const fullPath = path.join(config.contentDir, content.filepath);
    const probe = await new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', fullPath
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const info = JSON.parse(probe);
    if (info.format?.duration) {
      const dur = parseFloat(info.format.duration);
      db.prepare('UPDATE content SET duration_sec = ? WHERE id = ?').run(dur, content.id);
      return dur;
    }
  } catch (e) {
    console.warn('ffprobe re-probe failed for', content.id, e.message);
  }
  return null;
}

// Phase 2.2k: workspace-aware playlist access. Returns the playlist row (with
// req.playlistCtx populated) or sends 403/404. requireWrite=false for reads.
function loadPlaylistAccess(req, res, requireWrite) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) { res.status(404).json({ error: 'playlist not found' }); return null; }
  if (!playlist.workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(playlist.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.playlist = playlist;
  req.playlistCtx = ctx;
  return playlist;
}

function requirePlaylistRead(req, res, next) {
  if (!loadPlaylistAccess(req, res, false)) return;
  next();
}

function requirePlaylistWrite(req, res, next) {
  if (!loadPlaylistAccess(req, res, true)) return;
  next();
}

/*
 * The same access rules as above for a playlist named in the BODY rather than the path — the
 * batch add writes to several at once. Returns the playlist, or an { status, error } to send.
 */
function playlistWritableBy(req, playlistId) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) return { status: 404, error: `playlist not found: ${playlistId}` };
  if (!playlist.workspace_id) return { status: 403, error: 'Playlist not assigned to a workspace' };
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(playlist.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return { status: 403, error: 'Access denied' };
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return { status: 403, error: 'Read-only access' };
  return { playlist };
}

// Build the snapshot item list for a playlist (denormalized for device payload)
function buildSnapshotItems(playlistId) {
  const items = db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.sub_playlist_id, pi.sub_order, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
           COALESCE(c.filename, w.name, sp.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url, c.unstable_connection,
           c.captions_enabled, c.captions_lang, c.subtitle_url, c.subtitle_lang,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
      -- #157: a content-backed item is dropped from the snapshot once it's deactivated
      -- (is_active=0) or past its expiry (expires_at<=now). Widget items (content_id NULL)
      -- and dangling content (deleted row -> c.* NULL) are unaffected via COALESCE. This is
      -- the LIVE check so a publish between expiry and the next sweep tick already excludes it.
      AND (
        pi.content_id IS NULL
        OR (COALESCE(c.is_active, 1) = 1 AND (c.expires_at IS NULL OR c.expires_at > strftime('%s','now')))
      )
      /*
       * ETAPA 6: o contrato suspenso para de exibir, onde quer que a midia dele esteja.
       *
       * Terceira forma da mesma frase acima -- "este arquivo nao deve aparecer agora" -- e por
       * isso mora no mesmo lugar. Um filtro proprio, aplicado depois, seria um segundo lugar
       * decidindo o que a tela exibe, e o segundo lugar e sempre o que alguem esquece.
       *
       * A autoridade e o ARQUIVO -- a coluna contrato_id dele -- e nao a lista onde ele esta. Um arquivo do
       * contrato posto SOLTO numa tela para junto, que e o ponto inteiro -- se so a lista do
       * contrato parasse, esse arquivo seguiria no ar e o inadimplente teria veiculacao de graca.
       *
       * NOT EXISTS e nao um JOIN: contrato suspenso e a excecao, e a maioria dos arquivos nem tem
       * contrato. Arquivo sem contrato (coluna NULL) passa sem tocar na tabela.
       */
      AND (
        c.contrato_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM contratos_suspensos cs WHERE cs.contrato_id = c.contrato_id)
      )
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
  // #74/#75: attach per-item schedule blocks (the player honours these in its own
  // local time via the shared evaluator). An item with zero blocks gets no
  // `schedules` field -> always on. Additive: old players ignore the field. _iid is
  // only used here to fetch blocks and is then dropped (snapshot stays id-free).
  for (const it of items) {
    const blocks = schedulesFor(it._iid, it.content_id, it.widget_id);
    if (blocks.length) it.schedules = blocks;
    delete it._iid;
  }
  return items;
}

// #104: a playlist isn't bound to a device, so it has no intrinsic layout. Derive
// one from the playlist's own zone-bound items via the FK chain
// playlist_items.zone_id -> layout_zones.id -> layout_zones.layout_id. 0 zoned items
// -> fullscreen (null); 1 distinct layout -> use it; >1 (rare/legacy: zones from
// different layouts) -> the layout covering the MOST items, flagged ambiguous so the
// dashboard can caption it. Never throws.
function derivePreviewLayout(assignments) {
  const zoneIds = [...new Set((assignments || []).map(a => a && a.zone_id).filter(Boolean))];
  if (zoneIds.length === 0) return null;
  const ph = zoneIds.map(() => '?').join(',');
  const zoneRows = db.prepare(`SELECT id, layout_id FROM layout_zones WHERE id IN (${ph})`).all(...zoneIds);
  if (zoneRows.length === 0) return null; // dangling zone_ids -> fullscreen
  const layoutIds = [...new Set(zoneRows.map(r => r.layout_id))];
  let layoutId = layoutIds[0];
  let ambiguous = false;
  if (layoutIds.length > 1) {
    ambiguous = true;
    const z2l = new Map(zoneRows.map(r => [r.id, r.layout_id]));
    const tally = {};
    for (const a of assignments) { const l = z2l.get(a && a.zone_id); if (l) tally[l] = (tally[l] || 0) + 1; }
    layoutId = Object.entries(tally).sort((x, y) => y[1] - x[1])[0][0];
  }
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!layout) return null;
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
  if (ambiguous) layout._preview_ambiguous = true;
  return layout;
}

// Map schedule rows into the evaluator's block shape. Shared by both tables below — they have
// the same columns because the second was modelled on the first.
function toBlocks(rows) {
  return rows.map(r => ({
    days: String(r.active_days || '').split(',').filter(s => s !== '').map(Number),
    start: r.start_time,
    end: r.end_time,
    start_date: r.start_date || null,
    end_date: r.end_date || null,
  }));
}

const _itemBlocks = db.prepare(
  'SELECT active_days, start_time, end_time, start_date, end_date FROM playlist_item_schedules WHERE playlist_item_id = ? ORDER BY sort_order ASC, created_at ASC'
);
const _assetBlocks = db.prepare(`
  SELECT active_days, start_time, end_time, start_date, end_date FROM content_schedules
   WHERE (content_id IS NOT NULL AND content_id = @content_id)
      OR (widget_id  IS NOT NULL AND widget_id  = @widget_id)
   ORDER BY sort_order ASC, created_at ASC`);

/*
 * When may this item play?
 *
 * The rule normally belongs to the FILE — the person who uploads the December campaign is the
 * one who knows it runs to the 24th, and the same file in three lists should not have to be
 * configured three times and be allowed to disagree with itself.
 *
 * THE ITEM STILL WINS WHEN IT HAS ONE, and that is not a leftover. The agency API creates an
 * item together with its own window: that is a BOOKING, not a property of the file, and two
 * agencies booking the same clip for different fortnights is the ordinary case. Collapsing the
 * two would quietly redefine what a booking means.
 *
 * Most specific wins, rather than an intersection of the two. Intersecting is defensible and
 * more powerful, but the hard limit an operator actually reaches for — "stop showing this after
 * the 24th" — is content.expires_at, which is enforced independently in the WHERE clause above
 * and cannot be widened by anything here. So the extra machinery would buy very little and
 * would be hard to explain in a UI.
 */
function schedulesFor(itemId, contentId, widgetId) {
  const own = toBlocks(_itemBlocks.all(itemId));
  if (own.length) return own;
  if (!contentId && !widgetId) return [];

  /*
   * The file's own schedule, from both sources, unioned.
   *
   * TYPED RULES are how it is written now — "the 1st of the month", "January" — and they are
   * COMPILED here, on the way out, into the blocks a player understands. Compiling on read rather
   * than at save time is what keeps the expansion's horizon fresh: every push carries a window
   * measured from today, so there is no stored expansion to go stale.
   *
   * BLOCKS in content_schedules are what the file dialog wrote before rules existed. Reading both
   * costs one query and means an older schedule keeps playing instead of quietly evaporating.
   *
   * Blocks OR, so a union is the correct join between the two.
   */
  const legacy = toBlocks(_assetBlocks.all({ content_id: contentId || null, widget_id: widgetId || null }));
  const compiled = compileRules(readAssetRules(contentId, widgetId));
  return legacy.concat(compiled);
}

const _assetRules = db.prepare(`
  SELECT type, params FROM content_schedule_rules
   WHERE (content_id IS NOT NULL AND content_id = @content_id)
      OR (widget_id  IS NOT NULL AND widget_id  = @widget_id)
   ORDER BY sort_order ASC, created_at ASC`);

function readAssetRules(contentId, widgetId) {
  return _assetRules.all({ content_id: contentId || null, widget_id: widgetId || null }).map((r) => {
    let params = {};
    try { params = JSON.parse(r.params); } catch (e) { /* a corrupt row degrades to its type alone */ }
    return { type: r.type, ...params };
  });
}

// Kept for callers that only ever meant the item's own blocks (the per-item editor endpoints).
function schedulesForItem(itemId) {
  return toBlocks(_itemBlocks.all(itemId));
}

/*
 * O QUE VOCÊ SALVA, VAI PARA O AR.
 *
 * Isto era `markDraft`: mexer nos itens deixava a lista em rascunho, e nada chegava às telas até
 * alguém apertar "Publicar". Decisão do Vitor em 31/08 — "tudo já deveria ficar salvo e não ser
 * preciso clicar em salvar ou publicar".
 *
 * O CUSTO FOI APRESENTADO ANTES DE SER DECIDIDO, e fica registrado: uma lista que roda em várias
 * telas passa a mandar cada estado intermediário para todas elas, e quem for interrompido no meio
 * de uma edição deixa a lista pela metade na parede. Hoje isso não custa nada — nenhuma lista
 * está em mais de um lugar. No dia em que custar, o conserto é uma confirmação ("esta lista está
 * em 3 telas, aplicar?"), e não o rascunho de volta: um estado se esquece, um momento não.
 *
 * A publicação continua sendo o único caminho até o player. O que mudou foi QUANDO, não o
 * mecanismo — e o filtro que ela carrega vale igual: item inativo, expirado ou de contrato
 * suspenso segue fora do snapshot.
 */
function aplicarNaLista(playlistId, req) {
  publishPlaylist(playlistId, req || null);
}

// Push playlist update to all devices using this playlist. Accepts either an Express `req`
// (route path) or a raw Socket.IO `io` (background sweep path — #157 has no request).
function pushToDevices(playlistId, reqOrIo) {
  try {
    const io = reqOrIo && reqOrIo.app ? reqOrIo.app.get('io') : reqOrIo;
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    const devices = db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(playlistId);
    for (const d of devices) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

// #73: the shared publish path - snapshot current items into published_snapshot (what
// devices actually consume) + push to devices. POST /:id/publish AND the agency
// auto-publish path both call this, so they can never drift (a "published" playlist that
// wasn't snapshotted would be live-on-no-screen).
function publishPlaylist(playlistId, reqOrIo) {
  // Loop OS: sub-list slots are resolved HERE, by flattening N future passes into the ordinary
  // flat array published_snapshot has always been. The rotation therefore never reaches the
  // player as logic — it arrives as a longer plain playlist, which is why every player already
  // in the field plays sub-lists without a client update. No-op for a playlist with none.
  const draftItems = buildSnapshotItems(playlistId);
  const snapshotItems = expandSnapshot(draftItems, {
    rounds: config.sublists.rounds,
    maxItems: config.sublists.maxSnapshotItems,
  });
  // Both are stored: the expanded one is what devices play, the un-expanded one is what discard
  // rebuilds the editor from. Written in the same statement so they can never disagree.
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, published_draft = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(snapshotItems), JSON.stringify(draftItems), playlistId);
  pushToDevices(playlistId, reqOrIo);
}

// Phase 2.2k: list scoped to caller's current workspace. No platform_admin
// bypass - cross-workspace view comes from switch-workspace, matching the
// precedent established across all other migrated routes.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const playlists = db.prepare(`
    SELECT p.*, COUNT(DISTINCT pi.id) as item_count, COUNT(DISTINCT d.id) as display_count,
           EXISTS(SELECT 1 FROM playlist_items z WHERE z.playlist_id = p.id AND z.zone_id IS NOT NULL) as zoned,
           /*
            * SUBQUERIES, not more JOINs. This statement already joins playlist_items AND devices,
            * so every item row is repeated once per device — COUNT survives that with DISTINCT,
            * but a SUM would silently multiply the playlist's length by the number of screens
            * running it. A wrong duration that looks plausible is worse than none.
            */
           (SELECT COALESCE(SUM(si.duration_sec), 0) FROM playlist_items si WHERE si.playlist_id = p.id) as total_duration,
           /*
            * WHICH screens run this list, not just how many — as JSON rather than a delimited
            * string. A screen is named by a human and can contain any punctuation a human types,
            * so no comma, pipe or control character is a safe delimiter; json_group_array escapes
            * whatever the name happens to be and the client parses it instead of splitting it.
            */
           (SELECT json_group_array(json_object('name', sd.name, 'status', COALESCE(sd.status, 'offline')))
              FROM devices sd WHERE sd.playlist_id = p.id) as screen_list
    FROM playlists p
    LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
    LEFT JOIN devices d ON d.playlist_id = p.id
    WHERE p.workspace_id = ?
    GROUP BY p.id
    ORDER BY p.name ASC
  `).all(req.workspaceId);
  res.json(playlists);
});

// Phase 2.2k: create stamps workspace_id from req.workspaceId. Viewer-deny
// gate so workspace_viewers cannot create playlists in their workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name.trim(), (description || '').trim());
  res.status(201).json(db.prepare(`
    SELECT p.*, 0 as item_count, 0 as display_count FROM playlists p WHERE p.id = ?
  `).get(id));
});

// Get single playlist with items
/*
 * Add the library's selected files to one or more playlists.
 *
 * DECLARED BEFORE THE /:id ROUTES. "batch" is a literal first segment and nothing matches it
 * today, but Express takes the first pattern that fits, and a later /:id/:action would swallow
 * this silently — the same way GET /devices/overview once became a 404 by sitting after /:id.
 *
 * A loop of single adds from the panel would be one request per file per list, each able to shell
 * out to ffprobe, and it fails partway: some land, the rest do not, and the operator is left
 * reading lists to work out which. Everything here happens in ONE transaction.
 *
 * DUPLICATES ARE SKIPPED, not appended. The same clip twice in a rotation is legitimate, but that
 * is arranged in the playlist editor where the order is visible; from the library the sentence is
 * "put these in those lists", and the likelier cause of a repeat is a second click. The response
 * reports the skips per list so the toast can say so rather than quietly doing less than asked.
 */
router.post('/batch/add-items', async (req, res) => {
  try {
    const playlistIds = Array.isArray(req.body?.playlist_ids) ? [...new Set(req.body.playlist_ids)] : null;
    const contentIds = Array.isArray(req.body?.content_ids) ? [...new Set(req.body.content_ids)] : null;
    if (!playlistIds || !playlistIds.length) return res.status(400).json({ error: 'playlist_ids array required' });
    if (!contentIds || !contentIds.length) return res.status(400).json({ error: 'content_ids array required' });
    if (playlistIds.length > 50) return res.status(400).json({ error: 'too many playlists in one batch (max 50)' });
    if (contentIds.length > 200) return res.status(400).json({ error: 'too many files in one batch (max 200)' });

    /*
     * Everything is checked before anything is written. A batch that validates as it goes leaves
     * the first two lists changed and the third refused, which is the state nobody can undo.
     */
    const playlists = [];
    for (const id of playlistIds) {
      const r = playlistWritableBy(req, id);
      if (r.error) return res.status(r.status).json({ error: r.error });
      playlists.push(r.playlist);
    }

    const ph = contentIds.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id, workspace_id, duration_sec, mime_type, filepath FROM content WHERE id IN (${ph})`).all(...contentIds);
    const byId = new Map(found.map((c) => [c.id, c]));
    for (const id of contentIds) {
      const c = byId.get(id);
      if (!c) return res.status(404).json({ error: `Content not found: ${id}` });
      for (const pl of playlists) {
        if (c.workspace_id && c.workspace_id !== pl.workspace_id) {
          return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
        }
      }
    }

    /*
     * Probe BEFORE the transaction. better-sqlite3 transactions are synchronous — an await inside
     * one does not pause it, it commits while the probe is still pending.
     */
    const durations = new Map();
    for (const id of contentIds) {
      const c = byId.get(id);
      durations.set(id, resolveItemDuration(undefined, { ...c, duration_sec: await probeAndUpdateDuration(c) }));
    }

    const existing = db.prepare(
      'SELECT content_id FROM playlist_items WHERE playlist_id = ? AND content_id IS NOT NULL');
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?');
    const ins = db.prepare(
      'INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,?,?)');

    const results = [];
    db.transaction(() => {
      for (const pl of playlists) {
        const already = new Set(existing.all(pl.id).map((r) => r.content_id));
        const toAdd = contentIds.filter((id) => !already.has(id));
        let order = (maxOrder.get(pl.id).m || 0) + 1;
        for (const id of toAdd) ins.run(pl.id, id, order++, durations.get(id));
        results.push({ playlist_id: pl.id, name: pl.name, added: toAdd.length, skipped: contentIds.length - toAdd.length });
      }
    })();

    // Fora da transação: aplicarNaLista também escreve, e aninhar seria um segundo caminho de escrita
    // inside a committed one for no benefit.
    for (const r of results) if (r.added) aplicarNaLista(r.playlist_id, req);

    res.status(201).json({
      results,
      added: results.reduce((n, r) => n + r.added, 0),
      skipped: results.reduce((n, r) => n + r.skipped, 0),
    });
  } catch (err) {
    console.error('Failed to batch-add playlist items:', err);
    res.status(500).json({ error: 'Failed to add items' });
  }
});

router.get('/:id', requirePlaylistRead, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  const displayCount = db.prepare('SELECT COUNT(*) as count FROM devices WHERE playlist_id = ?').get(req.params.id).count;
  for (const it of items) it.schedules = schedulesForItem(it.id); // #156: editor read-path needs the blocks (mirror :351)
  // #104's layout derivation, reused so the editor can SHOW where each item lands. A playlist
  // has no intrinsic layout — it is inferred from its own zone-bound items — so without this
  // the page lists a zone NAME with no sense of where that zone sits on the screen. Null (no
  // zoned items) means fullscreen, which the UI draws as a single frame.
  let layout = null;
  try { layout = derivePreviewLayout(items); } catch (e) { layout = null; }
  res.json({ ...req.playlist, items, item_count: items.length, display_count: displayCount, layout });
});

// #104: device-free draft preview payload. Same shape the device player consumes
// (via assemblePayload, so it can't drift), but built from LIVE items (draft-aware,
// not published_snapshot) with a layout derived from the playlist's own zones. JWT-
// gated + workspace-scoped by requirePlaylistRead. The dashboard iframes /player
// with ?preview=1&playlist=:id and renders this with the unmodified player renderer.
const PREVIEW_ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);
router.get('/:id/preview-payload', requirePlaylistRead, (req, res) => {
  const { assemblePayload } = require('../ws/deviceSocket');
  const assignments = buildSnapshotItems(req.params.id);
  const layout = derivePreviewLayout(assignments);
  const orientation = PREVIEW_ORIENTATIONS.has(req.query.orientation) ? req.query.orientation : 'landscape';
  res.json(assemblePayload({ assignments, layout, orientation, wall_config: null, timezone: null }));
});

// Update playlist
router.put('/:id', requirePlaylistWrite, (req, res) => {
  const { name, description } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?');
    values.push(name.trim());
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description.trim());
  }
  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id));
});

// Publish playlist — snapshot current items and push to devices
router.post('/:id/publish', requirePlaylistWrite, (req, res) => {
  // Snapshot shape (no pi.id) is intentional — published_snapshot is consumed
  // by devices and stored as JSON; row IDs there would be misleading.
  publishPlaylist(req.params.id, req);
  // UI response shape must include pi.id so the post-publish render can wire
  // per-row delete/duration listeners. TODO: refactor to share this SELECT
  // with GET /:id (also duplicated in /discard and POST /:id/items/reorder).
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
});

// Discard draft — revert playlist_items to match published_snapshot
router.post('/:id/discard', requirePlaylistWrite, (req, res) => {
  const playlist = req.playlist;
  if (!playlist.published_snapshot) {
    return res.status(400).json({ error: 'No published version to revert to' });
  }
  if (playlist.status === 'published') {
    return res.status(400).json({ error: 'Playlist has no unpublished changes' });
  }

  // Rebuild from published_draft — the UN-expanded list, one entry per editor row.
  // published_snapshot holds N flattened sub-list passes, so reverting from it would turn a
  // 40-item playlist into 400 duplicated rows. Playlists published before published_draft
  // existed fall back to the snapshot, which is correct for them: they predate sub-lists, so
  // their snapshot was never expanded and the two are identical.
  let publishedItems;
  try { publishedItems = JSON.parse(playlist.published_draft || playlist.published_snapshot); } catch (e) {
    return res.status(500).json({ error: 'Corrupt published snapshot' });
  }

  const transaction = db.transaction(() => {
    // Clear current draft items
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(req.params.id);
    // Re-insert from snapshot, skipping items whose content/widget/sub-playlist was deleted
    const insert = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, sub_playlist_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const item of publishedItems) {
      try {
        insert.run(req.params.id, item.content_id || null, item.widget_id || null, item.sub_playlist_id || null, item.zone_id || null, item.sort_order, item.duration_sec);
      } catch (e) {
        if (e.message.includes('FOREIGN KEY')) {
          console.warn(`Discard: skipping snapshot item (content_id=${item.content_id}, widget_id=${item.widget_id}, sub_playlist_id=${item.sub_playlist_id}) — referenced entity was deleted`);
          continue;
        }
        throw e;
      }
    }
    db.prepare("UPDATE playlists SET status = 'published', updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  });
  transaction();

  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
});


/*
 * Copy a playlist, items and all.
 *
 * THE COPY IS ALWAYS A DRAFT, and that is the whole safety of the feature. A published playlist is
 * one with a snapshot devices can fetch; copying that snapshot across would produce a second list
 * claiming to be live, and the first thing anyone does with a copy is edit it. Neither
 * published_snapshot nor published_draft comes along.
 *
 * DEVICE ASSIGNMENTS DO NOT COME ALONG EITHER. Copying devices.playlist_id would put the new list
 * on real screens the instant it was created — the opposite of what "duplicate" means to the
 * person clicking it, and something they would have to notice before they could undo it.
 *
 * A sub-list item copies the REFERENCE, not the sub-list. Sub-lists are shared things; deep-copying
 * one would silently create a second rotation nobody asked for, and the original was already valid
 * one level deep so the copy is too.
 */
router.post('/:id/duplicate', requirePlaylistWrite, (req, res) => {
  try {
    const src = req.playlist;
    const newId = uuidv4();

    const copy = db.transaction(() => {
      db.prepare(`
        INSERT INTO playlists (id, user_id, workspace_id, name, description, status)
        VALUES (?, ?, ?, ?, ?, 'draft')
      `).run(newId, req.user.id, src.workspace_id, copyName(src.name, src.workspace_id), src.description);

      /*
       * muted and zone_id are easy to leave out of a copy and impossible to notice afterwards: the
       * duplicate plays at full volume in the wrong zone and looks like a player bug.
       */
      const items = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC').all(src.id);
      const insItem = db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, widget_id, sub_playlist_id, zone_id, sort_order, duration_sec, muted, sub_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const readSched = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?');
      const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');

      for (const it of items) {
        const r = insItem.run(newId, it.content_id, it.widget_id, it.sub_playlist_id, it.zone_id, it.sort_order, it.duration_sec, it.muted, it.sub_order || 'sequence');
        // Per-item schedules are a BOOKING on that row, so they belong to the copy too; the
        // file-level rules need nothing here because they live on the content, not the item.
        for (const s of readSched.all(it.id)) {
          insSched.run(uuidv4(), r.lastInsertRowid, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
        }
      }
      return items.length;
    });

    const itemCount = copy();

    /*
     * A COPIA JA NASCE NO AR, como tudo o mais desde 31/08.
     *
     * Ela era criada em 'draft', e isso fazia sentido enquanto publicar era um passo: uma copia
     * nao esta em tela nenhuma, entao o rascunho nao custava nada. Agora custa: mandar a copia
     * para uma tela nao exibiria nada, porque o snapshot dela estaria vazio -- e o sintoma seria
     * "dupliquei e a tela ficou preta", que ninguem liga a um status.
     */
    aplicarNaLista(newId, req);

    const created = db.prepare('SELECT * FROM playlists WHERE id = ?').get(newId);
    res.status(201).json({ ...created, item_count: itemCount });
  } catch (err) {
    console.error('Failed to duplicate playlist:', err);
    res.status(500).json({ error: 'Failed to duplicate playlist' });
  }
});

/*
 * "Lista" -> "Lista (cópia)" -> "Lista (cópia 2)".
 *
 * Names are not unique in the schema, so this is for the reader rather than the database: three
 * rows all called "Lista" in the index is a list nobody can act on. Scoped to the workspace,
 * because that is the only place the collision is visible.
 */
function copyName(name, workspaceId) {
  const taken = new Set(db.prepare('SELECT name FROM playlists WHERE workspace_id = ?').all(workspaceId).map((r) => r.name));
  const base = `${name} (cópia)`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (cópia ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological only. A timestamp beats failing the copy or overwriting a name.
  return `${name} (cópia ${Date.now()})`;
}

// Delete playlist
router.delete('/:id', requirePlaylistWrite, (req, res) => {
  // Which screens are about to lose their playlist — read BEFORE the delete, because
  // devices.playlist_id is ON DELETE SET NULL and the association is gone immediately after.
  const affected = db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(req.params.id);

  // Which OTHER playlists used this one as a sub-list. Read before the delete, and re-published
  // after, so their screens stop playing a rotation whose source no longer exists.
  const parents = db.prepare(
    'SELECT DISTINCT playlist_id FROM playlist_items WHERE sub_playlist_id = ? AND playlist_id != ?'
  ).all(req.params.id, req.params.id).map((r) => r.playlist_id);

  // Drop the slots that pointed here. schema.sql declares ON DELETE CASCADE for fresh installs,
  // but SQLite cannot retrofit a foreign key onto an existing table — on a MIGRATED database
  // sub_playlist_id is plain TEXT with no referential action, so without this the rows would
  // survive as slots resolving to a playlist that is gone.
  db.prepare('DELETE FROM playlist_items WHERE sub_playlist_id = ?').run(req.params.id);

  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);

  // Re-publish the parents so their snapshots stop containing the removed rotation. Only the
  // ones that were already published — a draft is left for its author to publish themselves.
  for (const pid of parents) {
    const p = db.prepare('SELECT status FROM playlists WHERE id = ?').get(pid);
    if (p && p.status === 'published') publishPlaylist(pid, req);
  }

  // Tell them. The database detaches correctly, but nothing was emitted — so a screen kept showing
  // the deleted playlist until it happened to reconnect or was restarted. You delete a playlist to
  // take content off the wall; the wall carried on regardless. Every sibling mutation here already
  // pushes (publish, assign), and DELETE /devices/:id/playlist was given a push for exactly this
  // reason: "so the screen stops, rather than leaving the old content up".
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      for (const d of affected) {
        commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), d.id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }

  res.json({ success: true });
});

// --- Playlist Items ---

// List items
router.get('/:id/items', requirePlaylistRead, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  for (const it of items) it.schedules = schedulesForItem(it.id); // #74/#75: editor needs the blocks
  res.json(items);
});

// --- Per-item schedule blocks (#74 dayparting + #75 expiry) ---
// Same permission as editing items (requirePlaylistWrite). Block shape mirrors the
// evaluator: { days:[0-6], start:"HH:MM", end:"HH:MM"|"24:00", start_date, end_date }.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return 'each block must be an object';
    if (!Array.isArray(b.days) || b.days.length === 0 || !b.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return 'days must be a non-empty array of integers 0-6';
    if (!TIME_RE.test(b.start)) return 'start must be HH:MM (00:00-23:59)';
    if (!(TIME_RE.test(b.end) || b.end === '24:00')) return 'end must be HH:MM or 24:00';
    for (const k of ['start_date', 'end_date']) if (b[k] != null && !DATE_RE.test(b[k])) return `${k} must be YYYY-MM-DD or null`;
  }
  return null;
}
function itemInPlaylist(itemId, playlistId) {
  return db.prepare('SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?').get(itemId, playlistId);
}

router.get('/:id/items/:itemId/schedules', requirePlaylistRead, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(schedulesForItem(item.id));
});

// Replace an item's schedule blocks wholesale ([] = no schedule = always on).
router.put('/:id/items/:itemId/schedules', requirePlaylistWrite, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const blocks = req.body.blocks;
  const err = validateBlocks(blocks);
  if (err) return res.status(400).json({ error: err });
  const ins = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(item.id);
    blocks.forEach((b, i) => ins.run(uuidv4(), item.id, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i));
  })();
  aplicarNaLista(req.params.id, req); // uma mudança de horário muda o que toca, e vai ao ar junto
  res.json(schedulesForItem(item.id));
});

// Phase 2.2k: add item closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who owns content in another workspace could push it into a playlist
//      in this workspace. Now: content must be in playlist's workspace (or
//      be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to a playlist they could reach. Now: widget must be in
//      playlist's workspace (or be a platform-template).
// Loop OS: sub-lists are a paid feature (plans.sublists_enabled). The gate runs only when the
// request actually asks for one, so adding ordinary content/widget items is untouched on every
// plan — a blanket middleware here would have locked the whole editor behind the upgrade.
/*
 * How a sub-list slot plays: in order, or shuffled. Validated against this list rather than
 * accepted as free text — an unknown value would silently fall through to sequential in
 * lib/sublists.js, and "I set it to random and it plays in order" is a bug nobody can see.
 */
const SUB_ORDERS = ['sequence', 'random'];

function gateSubListAdd(req, res, next) {
  if (!req.body || !req.body.sub_playlist_id) return next();
  return checkSublistsEnabled(req, res, next);
}


router.post('/:id/items', requirePlaylistWrite, gateSubListAdd, async (req, res) => {
  try {
    const { content_id, widget_id, sub_playlist_id, sort_order, zone_id, sub_order } = req.body;
    let { duration_sec } = req.body;

    // Exactly one of the three targets. Rejecting the "more than one" case explicitly matters:
    // the row would otherwise be ambiguous and the snapshot would silently pick whichever the
    // query's COALESCE happened to reach first.
    try { requireSingleTarget({ content_id, widget_id, sub_playlist_id }); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    if (duration_sec !== undefined && duration_sec !== null && (typeof duration_sec !== 'number' || duration_sec < 1)) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }
    if (sub_order !== undefined && !SUB_ORDERS.includes(sub_order)) {
      return res.status(400).json({ error: `sub_order must be one of: ${SUB_ORDERS.join(', ')}` });
    }

    if (sub_playlist_id) {
      try { validateSubList(req.params.id, sub_playlist_id, req.playlist.workspace_id); }
      catch (e) {
        if (e instanceof SubListError) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    }

    let content = null;
    if (content_id) {
      content = db.prepare('SELECT id, workspace_id, duration_sec, mime_type, filepath FROM content WHERE id = ?').get(content_id);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
      }
      // Rows ingested before the probe existed (or while ffprobe was missing) have no stored
      // duration; re-probe once so this add still gets the clip's length, and backfill the row.
      if (duration_sec === undefined || duration_sec === null) {
        content.duration_sec = await probeAndUpdateDuration(content);
      }
    }
    duration_sec = resolveItemDuration(duration_sec, content);
    if (widget_id) {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
    }

    // #public-api: optional multi-zone placement. Validate the zone belongs to a
    // template or a layout in this playlist's workspace (the agency portal needs this).
    if (zone_id) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }

    // Auto-increment sort_order if not specified
    let order = sort_order;
    if (order === undefined || order === null) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      order = (max.max_order || 0) + 1;
    }

    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, sub_playlist_id, zone_id, sort_order, duration_sec, sub_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, content_id || null, widget_id || null, sub_playlist_id || null, zone_id || null, order, duration_sec,
      sub_playlist_id ? (sub_order || 'sequence') : 'sequence');

    // Mark as draft (items changed since last publish)
    aplicarNaLista(req.params.id, req);

    const item = db.prepare(`
      SELECT pi.*,
             COALESCE(c.filename, w.name, sp.name) as filename,
             c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.file_size, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev,
             sp.name as sub_playlist_name,
             (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
      WHERE pi.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(item);
  } catch (err) {
    console.error('Failed to add playlist item:', err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Update item
router.put('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const { sort_order, duration_sec, zone_id, sub_order } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (sub_order !== undefined) {
    if (!SUB_ORDERS.includes(sub_order)) {
      return res.status(400).json({ error: `sub_order must be one of: ${SUB_ORDERS.join(', ')}` });
    }
    // Only meaningful on a sub-list slot; setting it on a file would be a value nothing reads.
    if (!item.sub_playlist_id) return res.status(400).json({ error: 'sub_order only applies to a sub-list item' });
    updates.push('sub_order = ?'); values.push(sub_order);
  }
  // #public-api: multi-zone placement (zone_id null clears it). Undefined = no change.
  if (zone_id !== undefined) {
    if (zone_id !== null) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }
    updates.push('zone_id = ?'); values.push(zone_id || null);
  }
  if (duration_sec !== undefined) {
    if (typeof duration_sec !== 'number' || duration_sec < 1) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }
    updates.push('duration_sec = ?');
    values.push(duration_sec);
  }

  // #105 replace: swap the item's content/widget in place while preserving zone_id,
  // duration, sort_order and schedule rows. playlist_items is normalized (no
  // type-specific columns — mime_type/remote_url/filepath/widget_type are JOINed at
  // read time), so this is a clean FK swap across ANY content type (image<->video<->
  // youtube<->widget). Exactly one of content_id/widget_id ends up set; the other is
  // nulled. Only acts when the request explicitly carries content_id or widget_id, so
  // partial PUTs (duration/zone/sort) are unaffected.
  const replacingContent = Object.prototype.hasOwnProperty.call(req.body, 'content_id');
  const replacingWidget = Object.prototype.hasOwnProperty.call(req.body, 'widget_id');
  if (replacingContent || replacingWidget) {
    const newContentId = replacingContent ? req.body.content_id : null;
    const newWidgetId = replacingWidget ? req.body.widget_id : null;
    if (!newContentId && !newWidgetId) return res.status(400).json({ error: 'content_id or widget_id required to replace' });
    if (newContentId && newWidgetId) return res.status(400).json({ error: 'provide only one of content_id / widget_id' });
    if (newContentId) {
      const content = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(newContentId);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
      }
    } else {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(newWidgetId);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
    }
    updates.push('content_id = ?'); values.push(newContentId || null);
    updates.push('widget_id = ?'); values.push(newWidgetId || null);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.itemId);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    aplicarNaLista(req.params.id, req);
  }

  const updated = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.id = ?
  `).get(req.params.itemId);
  res.json(updated);
});

// Delete item
router.delete('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.itemId);
  aplicarNaLista(req.params.id, req);
  res.json({ success: true });
});

// #105 duplicate: append a copy of an item (same content/widget + zone + duration)
// plus its schedule rows (new ids). One transaction so a half-copied item can't exist.
router.post('/:id/items/:itemId/duplicate', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const copy = db.transaction(() => {
    const max = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
    const order = (max.m || 0) + 1;
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, sub_playlist_id, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, item.content_id, item.widget_id, item.sub_playlist_id, item.zone_id, order, item.duration_sec);
    const newId = result.lastInsertRowid;
    const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?').all(req.params.itemId);
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    for (const s of scheds) insSched.run(uuidv4(), newId, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
    return newId;
  });
  const newId = copy();
  aplicarNaLista(req.params.id, req);

  const newItem = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.id = ?
  `).get(newId);
  res.status(201).json(newItem);
});

// Reorder items
router.post('/:id/items/reorder', requirePlaylistWrite, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, req.params.id);
    });
  });
  transaction();

  aplicarNaLista(req.params.id, req);

  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name, sp.name) as filename,
           sp.name as sub_playlist_name,
           (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json(items);
});

// Assign playlist to a device. Phase 2.2k: closes a pre-existing cross-tenant
// leak. Today checks device.user_id only; a caller with reach into a foreign
// workspace could assign their own playlist to a device in that workspace
// (or vice versa). Now: device must be in the playlist's workspace.
router.post('/:id/assign', requirePlaylistWrite, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.workspace_id !== req.playlist.workspace_id) {
    return res.status(403).json({ error: 'Device is not in this playlist\'s workspace' });
  }

  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(req.params.id, device_id);

  // Push update to device
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), device_id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }

  res.json({ success: true });
});

/*
 * ONDE ESTA LISTA ESTÁ TOCANDO — as duas portas.
 *
 * Rota própria, e não um campo a mais em GET /playlists: aquela consulta já tem cinco
 * subconsultas e é lida a cada abertura da página de listas. Esta é perguntada uma vez, quando
 * alguém abre a aba Mídias de um contrato.
 *
 * ── AS DUAS PORTAS, E POR QUE A SEGUNDA É A QUE IMPORTA ───────────────────────────────
 * PRINCIPAL: devices.playlist_id aponta para ela.
 * DENTRO: ela é um item (sub_playlist_id) da lista que a tela exibe — que é como a lista de um
 * contrato chega numa tela, pelo caminho que a página da tela oferece.
 *
 * Contar só a primeira diria "0 telas" com a lista tocando em cinco. E ninguém duvidaria: é um
 * número, parece medido.
 */
/*
 * O MESMO GUARDA DAS ROTAS IRMÃS, e não uma checagem própria de workspace. Ele passa pelo
 * accessContext, que sabe de papel e de acesso de suporte — coisas que uma comparação de
 * workspace_id escrita à mão aqui não saberia. Duas regras de acesso para a mesma coisa não
 * divergem no dia em que nascem; divergem no dia em que UMA delas é consertada.
 */
router.get('/:id/telas', requirePlaylistRead, (req, res) => {

  /*
   * UNION e não UNION ALL: uma tela cuja lista principal É esta e que também a tem como item
   * dentro apareceria duas vezes, e "está em 6 telas" com 5 nomes na lista é o tipo de número
   * que destrói a confiança no resto da tela.
   *
   * E as duas metades devolvem AS MESMAS COLUNAS, sem um campo dizendo por qual caminho a
   * lista chegou. A primeira versão tinha esse campo, e era ele que quebrava a deduplicação:
   * as duas linhas da mesma tela ficavam diferentes, e o UNION as mantinha. Ninguém pediu a
   * informação, e ela custou o número certo.
   */
  const telas = db.prepare(`
    SELECT d.id, d.name, COALESCE(d.status, 'offline') AS status
      FROM devices d
     WHERE d.workspace_id = ? AND d.playlist_id = ?

    UNION

    SELECT d.id, d.name, COALESCE(d.status, 'offline') AS status
      FROM devices d
      JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
     WHERE d.workspace_id = ? AND pi.sub_playlist_id = ?

     ORDER BY name COLLATE NOCASE
  `).all(req.workspaceId, req.params.id, req.workspaceId, req.params.id);
  res.json(telas);
});

module.exports = router;
module.exports.publishPlaylist = publishPlaylist; // #73: shared with the agency auto-publish path
// Test-only: the snapshot builder is where the schedule blocks are resolved onto each item, and
// that resolution is not reachable through an HTTP route without publishing a playlist first.
module.exports.__test = { buildSnapshotItems, schedulesFor };
