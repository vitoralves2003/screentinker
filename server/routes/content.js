const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const upload = require('../middleware/upload');
const config = require('../config');
const { checkStorageLimit, checkRemoteUrl } = require('../middleware/subscription');
const { sanitizeString } = require('../middleware/sanitize');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2b: workspace-aware access. Mirrors the pattern from devices.js.
const { accessContext } = require('../lib/tenancy');
const { compileRules, validateRules } = require('../lib/schedule-compile');
const { deriveScheduleState, badgeFor } = require('../lib/schedule-state');

/*
 * The ceiling on what one file's schedule may expand to. "The 1st of the month" is ~19 blocks over
 * the 18-month horizon; picking twenty days of the month is ~380, and it multiplies by every
 * distinct hour window. The limit is generous for anything a person means and firm enough that a
 * playlist snapshot cannot grow until it fails to deliver.
 */
const MAX_COMPILED_BLOCKS = 500;
// #73: the upload ingest (processing + insert) is now shared with the agency router.
const { ingestUploadedFile, deriveMediaMetadata } = require('../lib/content-ingest');
const { finalizeUpload, INLINE_SAFE_EXTS } = require('../lib/upload-sniff');

// Multer captures file.originalname directly from the multipart filename header,
// bypassing sanitizeBody. Apply the same HTML-escape here so a filename like
// `"><img src=x onerror=alert(1)>.jpg` is stored as `&quot;&gt;&lt;img...` and
// renders as text in every UI sink. Umlauts, spaces, dots, and other unicode are
// preserved - sanitizeString only touches `& < > " '`.
//
// .normalize('NFC') first: macOS clients send NFD-decomposed filenames (an
// umlaut like "u" + combining diaeresis U+0308 instead of the precomposed
// "u-umlaut" U+00FC). Linux + most renderers expect NFC; without this, names
// like "Begrussungsscreens.jpg" arrive with the combining char floating and
// display as mojibake. Single-point fix - every user-facing filename storage
// site (POST /, POST /remote, POST /embed, PUT /:id rename) flows through
// safeFilename, so normalizing here covers all paths.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

// SSRF gate for remote_url. Returns null if valid, else { status, error }.
// Used by both POST /remote and PUT /:id so a user can't bypass the check by
// uploading a benign URL and then PUT-updating it to file:///etc/passwd.
function validateRemoteUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { status: 400, error: 'URL must use http or https' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isPrivate = hostname === 'localhost' || hostname === '0.0.0.0' ||
    hostname.startsWith('127.') || hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') || hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname.startsWith('fc') || hostname.startsWith('fd') || hostname === '::1' ||
    hostname.endsWith('.local') || hostname.endsWith('.internal');
  if (isPrivate) return { status: 400, error: 'Internal URLs are not allowed' };
  return null;
}

// List content in the caller's current workspace, plus any platform-template
// rows (workspace_id IS NULL) that are shared with all workspaces.
// Phase 2.2b: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list filter.
// folder_id filter: omit for everything; "root" or "" for root-level only; <uuid> for that folder.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folder = req.query.folder;
  const folderId = req.query.folder_id;
  let sql = 'SELECT * FROM content WHERE (workspace_id = ? OR workspace_id IS NULL)';
  const params = [req.workspaceId];
  // #157: by default hide expired/deactivated content (the "live" set). ?include_expired=1
  // returns everything so the library's "Show expired" view can surface + restore them.
  if (req.query.include_expired !== '1' && req.query.include_expired !== 'true') {
    sql += " AND is_active = 1 AND (expires_at IS NULL OR expires_at > strftime('%s','now'))";
  }
  if (folder) { sql += ' AND folder = ?'; params.push(folder); }
  // #214: a text search (?q=) spans the whole workspace, not just the open folder —
  // "searching for a logo on page 1 shouldn't miss logos in another folder". When q is
  // absent we keep the folder-scoped browse behaviour.
  const q = (req.query.q || '').trim();
  if (!q && folderId !== undefined) {
    if (folderId === 'root' || folderId === '') {
      sql += ' AND folder_id IS NULL';
    } else {
      sql += ' AND folder_id = ?';
      params.push(folderId);
    }
  }
  /*
   * ?contrato_id= — "mostre tudo deste contrato".
   *
   * A aba Mídias do contrato lê por aqui, e a página de Arquivos usa o mesmo filtro quando se
   * chega nela por um contrato. Uma rota separada para "os arquivos do contrato" seria o começo
   * de um segundo depósito: o contrato é um ATRIBUTO do arquivo, e a biblioteca é uma só.
   *
   * Convive com a busca e com o tipo de propósito — "os vídeos deste contrato" é uma pergunta
   * legítima, e seria estranho que escolher um contrato desligasse os outros filtros.
   */
  const contratoId = (req.query.contrato_id || '').trim();
  if (contratoId) {
    sql += ' AND contrato_id = ?';
    params.push(contratoId.slice(0, 64));
  }

  if (q) {
    // Leading-wildcard LIKE (no index) — fine for the library's scale. Escape the LIKE
    // metacharacters so a filename with % or _ is matched literally.
    const esc = q.replace(/[\\%_]/g, (m) => '\\' + m);
    sql += " AND filename LIKE ? ESCAPE '\\'";
    params.push('%' + esc + '%');
  }
  // #214: type filter. youtube (video/youtube) and web (any other remote_url) are split
  // out from plain uploaded video/image so the UI's four buckets map cleanly.
  switch (req.query.type) {
    case 'image':   sql += " AND mime_type LIKE 'image/%'"; break;
    case 'video':   sql += " AND mime_type LIKE 'video/%' AND mime_type != 'video/youtube'"; break;
    case 'youtube': sql += " AND mime_type = 'video/youtube'"; break;
    case 'web':     sql += " AND remote_url IS NOT NULL AND mime_type != 'video/youtube'"; break;
    // default / 'all' / unknown: no type constraint
  }
  // #214: whitelisted sort (never interpolate user input into ORDER BY). Default keeps the
  // legacy newest-first ordering.
  const SORTS = {
    date_desc: 'created_at DESC',
    date_asc:  'created_at ASC',
    name:      'filename COLLATE NOCASE ASC',
    size:      'file_size DESC',
  };
  sql += ' ORDER BY ' + (SORTS[req.query.sort] || SORTS.date_desc) + ' LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(req.query.limit) || 100, 500), parseInt(req.query.offset) || 0);
  const content = db.prepare(sql).all(...params);
  res.json(withScheduleState(content, req.query.tz));
});

/*
 * Stamp each row with the clock the library list shows: on air, waiting, or done.
 *
 * ONE query for the whole page rather than one per file — the list returns up to 500 rows, and a
 * per-row lookup here is the kind of thing that is invisible on a library of twelve and makes the
 * page unusable on a library of five hundred.
 *
 * `tz` is the operator's own IANA zone, sent by the panel. A file can be on air in Manaus and not
 * in Recife; the clock on the reader's wall is the honest answer for a list they are reading, and
 * the device still decides for itself.
 */
/*
 * A zone Intl will actually accept, or null.
 *
 * The query string is caller-controlled and Intl.DateTimeFormat THROWS on a zone it does not know,
 * inside the evaluator, with nothing catching it — so "?tz=Foo/Bar" would take out the whole
 * library listing rather than degrade one badge. A pattern match is not enough here because a
 * well-formed name can still be a zone that does not exist; only Intl knows.
 */
function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (e) {
    return null;
  }
}

function withScheduleState(rows, tz) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const byContent = new Map();
  for (const r of db.prepare(
    `SELECT content_id, type, params FROM content_schedule_rules
      WHERE content_id IN (${ph}) ORDER BY sort_order ASC, created_at ASC`).all(...ids)) {
    let p = {};
    try { p = JSON.parse(r.params); } catch (e) { /* a corrupt row degrades to its type alone */ }
    if (!byContent.has(r.content_id)) byContent.set(r.content_id, []);
    byContent.get(r.content_id).push({ type: r.type, ...p });
  }
  const now = Date.now();
  const zone = validTz(tz);
  return rows.map((r) => {
    const state = deriveScheduleState({ rules: byContent.get(r.id) || [], expiresAt: r.expires_at, now, tz: zone });
    return { ...r, schedule_state: badgeFor(state), schedule_state_raw: state };
  });
}

// Get folders list for the caller's current workspace.
router.get('/folders', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folders = db.prepare(
    'SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL AND (workspace_id = ? OR workspace_id IS NULL) GROUP BY folder ORDER BY folder'
  ).all(req.workspaceId);
  res.json(folders);
});

// Upload content
// #212: multi-file upload. Accept the new `files` field (up to 20) and keep the legacy
// single `file` field so older clients / API callers / the replace flow are unaffected.
const uploadContentFiles = upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file', maxCount: 1 },
]);
router.post('/', checkStorageLimit, uploadContentFiles, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
    const files = [...((req.files && req.files.files) || []), ...((req.files && req.files.file) || [])];
    if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    // #73: shared ingest - identical processing + insert for dashboard and agency uploads.
    const folderId = req.body.folder_id || null;
    const results = [];
    for (const file of files) {
      results.push(await ingestUploadedFile({ file, userId: req.user.id, workspaceId: req.workspaceId, folderId }));
    }
    // Backward-compatible shape: a single upload still returns the content object (what
    // every existing caller reads); a multi-file upload returns the array of them.
    res.status(201).json(results.length === 1 ? results[0] : results);
  } catch (err) {
    if (err && err.name === 'UnsupportedUploadError') return res.status(400).json({ error: err.message });
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Add remote URL content
router.post('/remote', checkRemoteUrl, (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding remote content.' });
    const { url, name, mime_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const urlErr = validateRemoteUrl(url);
    if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    const mimeType = mime_type || (url.match(/\.(mp4|webm|mkv|avi|mov)/i) ? 'video/mp4' : 'image/jpeg');

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), mimeType, url);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('Remote URL add error:', err);
    res.status(500).json({ error: 'Failed to add remote URL' });
  }
});

// Add YouTube content (available to all plans - no storage used)
router.post('/youtube', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding YouTube content.' });
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Extract YouTube video ID from various URL formats
    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // Fetch title + aspect from YouTube oEmbed, queried with the ORIGINAL url so a
    // /shorts/ link reports its true vertical dimensions. A Short is detected from
    // the /shorts/ URL form OR portrait oEmbed dims (height > width). We persist that
    // as st_aspect=vertical on the embed URL so every player can render it 9:16
    // without re-querying oEmbed on each loop (remote_url is the only signal players
    // get; the /shorts/ origin is otherwise lost after ingest). YouTube ignores the
    // unknown param, and players read the video id — not the full URL — for the embed.
    let filename = name;
    let isVertical = /\/shorts\//i.test(url);
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (!filename) filename = oembed.title;
        if (oembed.height && oembed.width && Number(oembed.height) > Number(oembed.width)) isVertical = true;
      }
    } catch {}
    if (!filename) filename = `YouTube: ${videoId}`;

    const id = uuidv4();
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=${videoId}&enablejsapi=1${isVertical ? '&st_aspect=vertical' : ''}`;
    // thumbnail_path is a REMOTE URL here; the /api/content/:id/thumbnail route proxies
    // remote thumbnails server-side (so this isn't a local-file path). Future option for
    // CDN independence: download the thumbnail at ingest into contentDir + backfill
    // existing rows, then this would store a local filename like image uploads do.
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path)
      VALUES (?, ?, ?, ?, '', 'video/youtube', 0, ?, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), embedUrl, thumbnailUrl);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('YouTube add error:', err);
    res.status(500).json({ error: 'Failed to add YouTube video' });
  }
});

function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // bare video ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Phase 2.2b: workspace-aware access. Mirrors the device check pattern.
// Platform-template content (workspace_id IS NULL) is readable by anyone
// and writable only by platform_admin.
function checkContentRead(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: readable by anyone authenticated.
  if (!content.workspace_id) return content;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

function checkContentWrite(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: only platform_admin may write.
  if (!content.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared content' }); return null;
    }
    return content;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  // Workspace_viewer is read-only; acting-as (platform_admin or org owner/admin) and editor/admin pass.
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return content;
}

// #213: boolean form of checkContentWrite for batch paths (no res side effects). True if
// req.user may modify this content row. Mirrors checkContentWrite's authorization exactly.
function contentWritable(req, content) {
  if (!content) return false;
  if (!content.workspace_id) return PLATFORM_ROLES.includes(req.user.role);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return false;
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return false;
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #213: shared single-row teardown used by DELETE /:id and POST /batch/delete. Removes the
// row's files, scrubs it from published snapshots in its workspace, deletes the row (cascades
// playlist_items). Returns the device ids whose playlists referenced it so the caller can push
// updates. Pure DB+FS, no HTTP. `content.id` MUST be a validated UUID (LIKE scrub) and the
// caller MUST have authorized the write. File unlinks are wrapped so they never throw.
function purgeContentRow(content) {
  const id = content.id;
  const unlink = (rel) => {
    if (!rel) return;
    const p = path.join(config.contentDir, path.basename(rel));
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { /* best-effort */ } }
  };
  unlink(content.filepath);
  unlink(content.thumbnail_path);
  unlink(content.subtitle_url); // #216 sidecar (undefined on pre-#216 rows — no-op)

  const affected = db.prepare(`
    SELECT DISTINCT d.id as device_id FROM devices d
    JOIN playlists p ON d.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(id).map(r => r.device_id);

  const snapshotPlaylists = db.prepare(
    "SELECT id, published_snapshot FROM playlists WHERE workspace_id = ? AND published_snapshot LIKE ?"
  ).all(content.workspace_id, `%${id}%`);
  for (const pl of snapshotPlaylists) {
    try {
      const items = JSON.parse(pl.published_snapshot);
      const filtered = items.filter(item => item.content_id !== id);
      if (filtered.length !== items.length) {
        db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(filtered), pl.id);
      }
    } catch (e) { /* corrupt snapshot, skip */ }
  }

  db.prepare('DELETE FROM content WHERE id = ?').run(id);
  return affected;
}

// #213: push a playlist refresh to a set of device ids (deduped). Silent on any failure.
function pushContentUpdates(req, deviceIds) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    for (const id of new Set(deviceIds)) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

// #213: batch delete. Validates + authorizes EVERY id first (atomic — the whole batch is
// rejected if any id is malformed/missing/forbidden), then deletes in one transaction.
router.post('/batch/delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many items (max 500 per batch)' });

  const rows = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: `Invalid content ID: ${id}` });
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    if (!content) return res.status(404).json({ error: `Content not found: ${id}` });
    if (!contentWritable(req, content)) return res.status(403).json({ error: `Access denied for content: ${id}` });
    rows.push(content);
  }

  const affected = new Set();
  db.transaction(() => {
    for (const content of rows) for (const d of purgeContentRow(content)) affected.add(d);
  })();
  pushContentUpdates(req, affected);
  res.json({ success: true, deleted: rows.length, affectedDevices: [...affected] });
});

// #213: batch move. Reassigns folder_id for many items at once. Folder is organizational only
// (not in the published snapshot), so no device push is needed. Same atomic validate-all-first.
router.post('/batch/move', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  const folderId = req.body.folder_id || null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many items (max 500 per batch)' });

  const rows = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: `Invalid content ID: ${id}` });
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    if (!content) return res.status(404).json({ error: `Content not found: ${id}` });
    if (!contentWritable(req, content)) return res.status(403).json({ error: `Access denied for content: ${id}` });
    rows.push(content);
  }
  // Target folder (if any) must exist and share the workspace of every moved item.
  if (folderId) {
    const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folderId);
    if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
    for (const content of rows) {
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
  }

  db.transaction(() => {
    const stmt = db.prepare('UPDATE content SET folder_id = ? WHERE id = ?');
    for (const content of rows) stmt.run(folderId, content.id);
  })();
  res.json({ success: true, moved: rows.length, folder_id: folderId });
});

// Get content metadata
router.get('/:id', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  res.json(content);
});

// Update content metadata
router.put('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;

  const { filename, mime_type, remote_url, folder, folder_id, expires_at, unstable_connection,
          captions_enabled, captions_lang, subtitle_url, subtitle_lang, contrato_id } = req.body;
  const updates = [];
  const values = [];
  if (filename !== undefined) { updates.push('filename = ?'); values.push(safeFilename(filename)); }
  if (mime_type !== undefined) { updates.push('mime_type = ?'); values.push(mime_type); }
  if (remote_url !== undefined) {
    if (remote_url) {
      const urlErr = validateRemoteUrl(remote_url);
      if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
    }
    updates.push('remote_url = ?');
    values.push(remote_url || null);
  }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }
  if (folder_id !== undefined) {
    // Phase 2.2c: target folder must live in the same workspace as the
    // content row being modified. Strict same-workspace check - no
    // platform_admin override, because cross-workspace folder references
    // break the isolation model. To move content across workspaces, switch
    // workspace first.
    if (folder_id) {
      const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folder_id);
      if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
    updates.push('folder_id = ?');
    values.push(folder_id || null);
  }
  // #157: set/clear expiry (epoch seconds, or null = never). Whenever expiry changes we
  // reset is_active=1 — the expiry sweep's once-only marker. That means: clearing/extending
  // to a future time reactivates the item immediately; setting a PAST time leaves it "active"
  // for the sweep to flip to 0 AND republish the playlists that carried it (the immediate-
  // expiry path). Publish-time filtering already excludes past-expiry items regardless.
  if (expires_at !== undefined) {
    let val = null;
    if (expires_at !== null && expires_at !== '') {
      val = Number(expires_at);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ error: 'expires_at must be epoch seconds (positive integer) or null' });
      }
      val = Math.floor(val);
    }
    updates.push('expires_at = ?'); values.push(val);
    updates.push('is_active = 1');
  }
  // #217: force a lower YouTube quality ceiling for weak/unstable WiFi. Stored 0/1;
  // accepts booleans or 0/1 from the client and coerces to an integer.
  if (unstable_connection !== undefined) {
    updates.push('unstable_connection = ?');
    values.push(unstable_connection ? 1 : 0);
  }
  // #216: caption/subtitle metadata. The subtitle FILE is uploaded via POST /:id/subtitle;
  // these fields toggle YouTube captions, set languages, or clear a subtitle (subtitle_url=null).
  if (captions_enabled !== undefined) {
    updates.push('captions_enabled = ?'); values.push(captions_enabled ? 1 : 0);
  }
  if (captions_lang !== undefined) {
    updates.push('captions_lang = ?'); values.push(captions_lang ? String(captions_lang).slice(0, 10) : null);
  }
  if (subtitle_url !== undefined) {
    // Only null (clear) is accepted here — a real subtitle_url is set by the upload endpoint.
    updates.push('subtitle_url = ?'); values.push(subtitle_url ? String(subtitle_url).slice(0, 255) : null);
  }
  if (subtitle_lang !== undefined) {
    updates.push('subtitle_lang = ?'); values.push(subtitle_lang ? String(subtitle_lang).slice(0, 10) : null);
  }
  /*
   * DE QUAL CONTRATO ESTE ARQUIVO E (Etapa 6). String vazia e null significam a mesma coisa --
   * "de nenhum" -- porque um campo de formulario esvaziado chega como '' e ninguem deveria
   * precisar saber disso.
   *
   * O id nao e verificavel daqui: ele vive no Postgres da Gestao. Esta rota guarda o que recebe;
   * quem garante que ele existe e a tela, que oferece uma LISTA em vez de um campo de digitar.
   * Um id errado nao daria erro nenhum -- o arquivo apenas nunca seria suspenso -- e uma defesa
   * que este banco nao tem como fazer nao e defesa.
   */
  const mudouContrato = contrato_id !== undefined
    && (contrato_id || null) !== (content.contrato_id || null);

  /*
   * O LIMITE DE MÍDIAS DO CONTRATO — a trava, e ela é do lado do servidor de propósito.
   *
   * O limite vem espelhado da Gestão (contratos_limites) e FALHA ABERTO: contrato sem linha
   * não tem limite. Ausência lida como zero pararia todo contrato que a Operação ainda não
   * conhece, que hoje são todos.
   *
   * Conta o que está ATIVO e não vencido, com o mesmo critério da listagem: contar uploads
   * faria "substituir" custar uma vaga, e trocar a peça de setembro pela de outubro seria
   * recusado por causa de um arquivo que ninguém mais vê.
   *
   * Só na ENTRADA. Sair de um contrato nunca é recusado — recusar a saída prenderia o arquivo
   * no contrato errado.
   */
  if (mudouContrato && contrato_id) {
    const limite = db.prepare(
      'SELECT max_midias FROM contratos_limites WHERE contrato_id = ? AND workspace_id = ?',
    ).get(String(contrato_id).slice(0, 64), req.workspaceId);

    if (limite && limite.max_midias) {
      const emUso = db.prepare(`
        SELECT COUNT(*) c FROM content
         WHERE contrato_id = ? AND workspace_id = ? AND id != ?
           AND is_active = 1 AND (expires_at IS NULL OR expires_at > strftime('%s','now'))
      `).get(String(contrato_id).slice(0, 64), req.workspaceId, req.params.id).c;

      if (emUso >= limite.max_midias) {
        /*
         * A recusa DIZ O NÚMERO e o que fazer. "Limite atingido" sozinho manda a pessoa
         * procurar onde o limite mora, e ela não vai achar — ele está noutro sistema.
         */
        return res.status(409).json({
          error: `Este contrato permite ${limite.max_midias} ${limite.max_midias === 1 ? 'mídia' : 'mídias'} e já tem ${emUso}. `
            + 'Desative uma das atuais, ou aumente o limite na aba Mídias do contrato.',
          codigo: 'limite_de_midias',
          max_midias: limite.max_midias,
          em_uso: emUso,
        });
      }
    }
  }

  if (contrato_id !== undefined) {
    updates.push('contrato_id = ?');
    values.push(contrato_id ? String(contrato_id).slice(0, 64) : null);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /*
   * TROCAR DE CONTRATO PODE MUDAR O QUE A TELA EXIBE -- e a mesma armadilha da suspensao: a
   * marca certa no banco e o snapshot velho na parede.
   *
   * Sair de um contrato suspenso para um em dia tem de devolver o arquivo ao ar; entrar num
   * suspenso tem de tira-lo. Sem republicar, as duas coisas ficam certas no banco e invisiveis
   * onde importa.
   */
  if (mudouContrato) {
    const listas = db.prepare(`
      SELECT DISTINCT p.id FROM playlists p
        JOIN playlist_items pi ON pi.playlist_id = p.id
       WHERE pi.content_id = ? AND p.status = 'published'
    `).all(req.params.id);
    const { publishPlaylist } = require('./playlists');
    for (const l of listas) publishPlaylist(l.id, req);
  }

  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Replace content file
router.put('/:id/replace', upload.single('file'), async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  // Delete old file
  if (content.filepath) {
    const oldPath = path.join(config.contentDir, content.filepath);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  // Delete old thumbnail
  if (content.thumbnail_path) {
    const oldThumb = path.join(config.contentDir, content.thumbnail_path);
    if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
  }

  // Same content-derived naming as the main ingest path (lib/upload-sniff) — the caller
  // does not choose the extension here either. A non-media upload 400s.
  let filepath, mime;
  try { ({ filepath, mime } = finalizeUpload(req.file)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  // Re-derive EVERYTHING the bytes decide, through the SAME function the upload path uses.
  // This route used to carry a shorter copy that handled images only, and got three things
  // wrong that an upload gets right:
  //   - a replaced VIDEO lost its duration (the row kept the OLD clip's length, so #237's
  //     "default an item to the clip's own length" then handed out the wrong number), its
  //     dimensions, and its thumbnail;
  //   - a replaced IMAGE was measured with raw sharp metadata instead of imageDisplayDims and
  //     thumbnailed without .rotate(), re-introducing the EXIF-orientation bug (#170) that
  //     ingest fixes — a portrait photo came back landscape with blue bars;
  //   - both left width/height NULL for video, which is what the orientation-aware paths read.
  const { width, height, durationSec, thumbnailPath } = await deriveMediaMetadata(req.file.path, filepath, mime);

  // Bump the revision: this is the ONLY operation in the product that changes an asset's bytes
  // without changing its id, so it is the only thing that can make a player's cached copy wrong.
  // Players key their media cache on the revision, so this is what evicts it.
  //
  // strftime seconds can collide with the previous value if a replace lands inside the same second
  // as the upload (a small file, a scripted replace) — and a revision that does not change is a
  // cache that never updates. MAX(now, previous + 1) guarantees it moves.
  // duration_sec comes from the NEW bytes. COALESCE-to-NULL rather than keeping the old value:
  // a replace that turns a video into an image genuinely has no duration, and a stale one would
  // silently become the default for every later playlist add (lib/item-duration.js).
  db.prepare(`UPDATE content
                 SET filepath = ?, mime_type = ?, file_size = ?, thumbnail_path = ?, width = ?, height = ?,
                     duration_sec = ?,
                     updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at, 0), created_at) + 1)
               WHERE id = ?`)
    .run(filepath, mime, req.file.size, thumbnailPath, width, height, durationSec, req.params.id);

  // ...and tell the panels, which the old code did not. Without this the new bytes reached a screen
  // only when something else happened to trigger a playlist refresh — an operator replacing a video
  // watched the dashboard update and the screen keep playing the old one.
  const affected = db.prepare(`
    SELECT DISTINCT d.id as device_id FROM devices d
    JOIN playlists p ON d.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(req.params.id).map((r) => r.device_id);
  pushContentUpdates(req, affected);

  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// #216: upload a WebVTT subtitle track for an uploaded video. Stores the .vtt in the
// content dir (served at /uploads/content/<file>) and records its filename + language on
// the content row. Replaces any existing subtitle (old file removed).
router.post('/:id/subtitle', upload.subtitleUpload.single('subtitle'), async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) {
    // checkContentWrite already sent the response; clean up the orphaned upload.
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return;
  }
  if (!req.file) return res.status(400).json({ error: 'No subtitle file provided' });

  // Remove the previous subtitle file if there was one.
  if (content.subtitle_url) {
    const old = path.join(config.contentDir, path.basename(content.subtitle_url));
    if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
  }
  const lang = req.body.subtitle_lang ? String(req.body.subtitle_lang).slice(0, 10) : (content.subtitle_lang || null);
  db.prepare('UPDATE content SET subtitle_url = ?, subtitle_lang = ? WHERE id = ?')
    .run(req.file.filename, lang, req.params.id);
  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Uploads share the dashboard origin — see server.js hardenUploadResponse. Same rule
// applied here so these routes are safe on their own merits, not because another mount
// happens to be registered first.
function hardenUploadResponse(res, filename) {
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!INLINE_SAFE_EXTS.has(path.extname(String(filename || '')).toLowerCase())) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
  }
}

// Serve content file
router.get('/:id/file', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  hardenUploadResponse(res, content.filepath);
  res.sendFile(safePath);
});

// Serve thumbnail
router.get('/:id/thumbnail', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  hardenUploadResponse(res, content.thumbnail_path);
  res.sendFile(safePath);
});

// Delete content
router.delete('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  // Validate UUID format to prevent LIKE wildcard injection in the snapshot scrub.
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid content ID format' });

  // #213: shared teardown (file removal + snapshot scrub + row delete). Returns the affected
  // device ids so we can push a refresh.
  const affectedDevices = purgeContentRow(content);
  pushContentUpdates(req, affectedDevices);
  res.json({ success: true, affectedDevices });
});

/*
 * WHEN THIS FILE MAY PLAY.
 *
 * The rule belongs to the file, not to each list entry. Whoever uploads the December campaign
 * knows it runs to the 24th; whoever assembles a playlist often does not, and the same file in
 * three lists used to need the same rule entered three times — with nothing stopping the three
 * from disagreeing.
 *
 * Blocks are OR: the file plays if ANY of them matches. That is the same shape the player has
 * always evaluated, so this reaches the fleet with no app change; only the source of the blocks
 * moved. Validation mirrors the client and the agency route — days 0-6, HH:MM (or the 24:00
 * end-of-day sentinel), ISO dates — because a bad block does not fail loudly on a panel, it just
 * silently never matches.
 */
const SCHED_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHED_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readBlocks(contentId) {
  return db.prepare(
    'SELECT active_days, start_time, end_time, start_date, end_date FROM content_schedules WHERE content_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(contentId).map((r) => ({
    days: String(r.active_days || '').split(',').filter((x) => x !== '').map(Number),
    start: r.start_time,
    end: r.end_time,
    start_date: r.start_date || null,
    end_date: r.end_date || null,
  }));
}

router.get('/:id/schedules', (req, res) => {
  const item = checkContentRead(req, res);
  if (!item) return;
  res.json(readBlocks(req.params.id));
});

router.put('/:id/schedules', (req, res) => {
  const item = checkContentWrite(req, res);
  if (!item) return;

  const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : null;
  if (!blocks) return res.status(400).json({ error: 'blocks array required' });

  const rows = [];
  for (const b of blocks) {
    const days = Array.isArray(b?.days) ? b.days.map(Number) : [];
    if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return res.status(400).json({ error: 'days must be a non-empty list of integers 0-6' });
    }
    const start = b.start || '00:00';
    const end = b.end || '24:00';
    if (!SCHED_TIME.test(start)) return res.status(400).json({ error: 'start must be HH:MM' });
    if (!(SCHED_TIME.test(end) || end === '24:00')) return res.status(400).json({ error: 'end must be HH:MM or 24:00' });
    for (const [k, v] of [['start_date', b.start_date], ['end_date', b.end_date]]) {
      if (v && !SCHED_DATE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD` });
    }
    rows.push({
      days: [...new Set(days)].sort((x, y) => x - y).join(','),
      start, end, start_date: b.start_date || null, end_date: b.end_date || null,
    });
  }

  const save = db.transaction(() => {
    db.prepare('DELETE FROM content_schedules WHERE content_id = ?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO content_schedules (id, content_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    rows.forEach((r, i) => ins.run(uuidv4(), req.params.id, r.days, r.start, r.end, r.start_date, r.end_date, i));
  });
  save();

  /*
   * Every published playlist holding this file is now out of date, because the blocks are baked
   * into the snapshot at publish time. Marking them draft is deliberate rather than
   * republishing behind the operator's back: a playlist may be mid-edit, and pushing someone
   * else's unfinished list to a wall because a schedule changed is a worse surprise than a
   * "republish" badge.
   */
  const affected = db.prepare(`
    SELECT DISTINCT p.id FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
     WHERE pi.content_id = ? AND p.status = 'published'`).all(req.params.id);
  for (const pl of affected) {
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(pl.id);
  }

  res.json({ blocks: readBlocks(req.params.id), playlists_to_republish: affected.length });
});

/*
 * The typed rules — the shape the operator actually works in.
 *
 * "Every Monday", "the 1st of the month", "January" are all one rule each here. The block routes
 * above stay because the agency booking path and anything written before this existed still speak
 * blocks; lib/schedule-compile.js turns rules into blocks on the way to a player, and
 * routes/playlists.js unions the two sources.
 */
function readRules(contentId) {
  return db.prepare(
    'SELECT type, params FROM content_schedule_rules WHERE content_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(contentId).map((r) => {
    let params = {};
    try { params = JSON.parse(r.params); } catch (e) { /* a corrupt row degrades to its type alone */ }
    return { type: r.type, ...params };
  });
}

router.get('/:id/schedule-rules', (req, res) => {
  const item = checkContentRead(req, res);
  if (!item) return;
  const rules = readRules(req.params.id);
  res.json({ rules, blocks: compileRules(rules) });
});

router.put('/:id/schedule-rules', (req, res) => {
  const item = checkContentWrite(req, res);
  if (!item) return;

  const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!rules) return res.status(400).json({ error: 'rules array required' });

  const invalid = validateRules(rules);
  if (invalid) return res.status(400).json({ error: invalid });

  /*
   * Refuse a rule set that expands past what is reasonable to push, rather than quietly truncating
   * it. Twenty days of the month over the horizon is hundreds of blocks in every playlist snapshot
   * holding the file, and a snapshot too big to deliver is a black screen, not a slow one.
   */
  const blocks = compileRules(rules);
  if (blocks.length > MAX_COMPILED_BLOCKS) {
    return res.status(400).json({
      error: 'schedule too broad',
      detail: `expands to ${blocks.length} blocks (limit ${MAX_COMPILED_BLOCKS})`,
      blocks: blocks.length,
      limit: MAX_COMPILED_BLOCKS,
    });
  }

  const save = db.transaction(() => {
    db.prepare('DELETE FROM content_schedule_rules WHERE content_id = ?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO content_schedule_rules (id, content_id, type, params, sort_order) VALUES (?,?,?,?,?)');
    rules.forEach((r, i) => {
      const { type, ...params } = r;
      ins.run(uuidv4(), req.params.id, type, JSON.stringify(params), i);
    });
  });
  save();

  // Same reasoning as the block route: the snapshot is stale, but republishing is the operator's call.
  const affected = db.prepare(`
    SELECT DISTINCT p.id FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
     WHERE pi.content_id = ? AND p.status = 'published'`).all(req.params.id);
  for (const pl of affected) {
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(pl.id);
  }

  res.json({ rules: readRules(req.params.id), blocks: blocks.length, playlists_to_republish: affected.length });
});

module.exports = router;
