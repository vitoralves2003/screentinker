const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const appConfig = require('../config');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2d: workspace-aware access. Same pattern as devices.js / content.js.
const { accessContext } = require('../lib/tenancy');
// Loop OS: widgets are a paid feature (plans.widgets_enabled).
const { checkWidgetsEnabled } = require('../middleware/subscription');
// Shared widget base: screen-relative scale, motion, palette and SVG icons. See lib/widget-kit.js
// for why every size is a multiple of --u rather than a pixel count.
const kit = require('../lib/widget-kit');
const { findCity, cityLabel } = require('../lib/cities-br');

// For preview only: inline /api/content/:id/file and /thumbnail URLs as data URIs,
// scoped to the caller's current workspace. Lets the srcdoc preview iframe show
// logos/bg images before the widget is saved (post-save they're reachable via
// the widget-reference gate).
const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10MB cap — base64 expands ~1.33x
const MIME_RE = /^image\/[a-zA-Z0-9.+-]+$/;
function inlineUserContent(html, workspaceId) {
  if (!workspaceId) return html;
  return html.replace(/\/api\/content\/([a-f0-9-]+)\/(file|thumbnail)/gi, (match, id, kind) => {
    const c = db.prepare('SELECT filepath, thumbnail_path, mime_type, workspace_id FROM content WHERE id = ?').get(id);
    // Inline content only when it lives in the caller's workspace, or is a
    // platform-template row (workspace_id IS NULL) shared with everyone.
    if (!c) return match;
    if (c.workspace_id && c.workspace_id !== workspaceId) return match;
    const filename = kind === 'thumbnail' ? c.thumbnail_path : c.filepath;
    if (!filename) return match;
    // YouTube (and other remote-sourced) content stores thumbnail_path as a remote
    // http(s) URL, not a local file. Don't try to read it from disk (would ENOENT the
    // same way the serving route did) — leave the /api/content/:id/thumbnail reference
    // in place; the thumbnail route proxies it same-origin and CSP img-src allows https:.
    if (/^https?:\/\//i.test(filename)) return match;
    const mime = kind === 'thumbnail' ? 'image/jpeg' : c.mime_type;
    if (!mime || !MIME_RE.test(mime)) return match;
    const safe = path.resolve(appConfig.contentDir, path.basename(filename));
    if (!safe.startsWith(path.resolve(appConfig.contentDir))) return match;
    try {
      const st = fs.statSync(safe);
      if (!st.isFile() || st.size > MAX_INLINE_BYTES) return match;
      const buf = fs.readFileSync(safe);
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { return match; }
  });
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/*
 * Validate timezone format (e.g. America/New_York, UTC, Etc/GMT+5).
 *
 * Returns NULL when none is configured, and null means "use the device's own clock" — the caller
 * passes undefined to Intl, which then reads the panel's zone.
 *
 * It used to default to 'UTC', which is the wrong default for a product whose screens are all in
 * Brazil: a clock with no timezone set showed UTC, three hours ahead of the wall it was hanging
 * on. A signage clock has no business being right about a zone nobody in the room is in — the
 * device already knows where it is.
 */
function safeTimezone(tz) {
  if (!tz) return null;
  return /^[A-Za-z_\-\/+0-9]+$/.test(tz) ? tz : null;
}

// Validate ISO date string format
function safeDateString(d) {
  if (!d) return '';
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(d) ? d : '';
}

// Validate URL is http/https
function safeUrl(url) {
  if (!url) return 'about:blank';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : 'about:blank';
  } catch { return 'about:blank'; }
}

// Security: widget render output is public and CSP-exempt, so config values that
// get inlined into <style>/CSS must not be able to break out (a config field set
// via the API could otherwise carry `}</style><script>...`). safeCss allows
// colors/gradients but rejects breakout/exfil constructs; safeNumber coerces to
// a finite number (so e.g. font_size can't smuggle markup).
function safeCss(v, fallback) {
  if (typeof v !== 'string') return fallback;
  if (/[<>{}\\;]/.test(v) || /url\s*\(/i.test(v) || /@import/i.test(v) || /expression/i.test(v) || /javascript:/i.test(v)) return fallback;
  return v.trim().slice(0, 200);
}
function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// List widgets accessible to the caller's current workspace, plus any
// platform-template rows (workspace_id IS NULL) shared with all workspaces.
// Phase 2.2d: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list branch.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const widgets = db.prepare(
    'SELECT * FROM widgets WHERE (workspace_id = ? OR workspace_id IS NULL) ORDER BY created_at DESC'
  ).all(req.workspaceId);
  res.json(widgets);
});

// Create widget in the caller's current workspace.
router.post('/', checkWidgetsEnabled, (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating widgets.' });
  const { widget_type, name, config } = req.body;
  if (!widget_type || !name) return res.status(400).json({ error: 'widget_type and name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, widget_type, name, JSON.stringify(config || {}));

  res.status(201).json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
});

// Phase 2.2d: workspace-aware access. Mirrors the device/content pattern.
// Platform-template widgets (workspace_id IS NULL) are readable by anyone
// authenticated and writable only by platform_admin.
function checkWidgetRead(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  if (!widget.workspace_id) return widget;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(widget.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return widget;
}

function checkWidgetWrite(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  if (!widget.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared widgets' }); return null;
    }
    return widget;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(widget.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return widget;
}

// Get widget
router.get('/:id', (req, res) => {
  const widget = checkWidgetRead(req, res);
  if (!widget) return;
  res.json(widget);
});

// Update widget
router.put('/:id', checkWidgetsEnabled, (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;

  const { name, config } = req.body;
  if (name) db.prepare('UPDATE widgets SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
  if (config) db.prepare('UPDATE widgets SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(JSON.stringify(config), req.params.id);

  // Push the change to any display currently showing this widget. Editing a widget used to
  // notify nothing at all: the render endpoint serves live config, but a player that already has
  // the widget on screen keeps its WebView (deliberately — re-navigating a widget every duration
  // is a visible flash and destroys widget state). With no push and no change to the URL, an edit
  // reached the screen only when the app was restarted. Reported on #234: "I changed the text and
  // the new text did not appear on the screen. I had to close the app and then open again."
  //
  // The push is what makes it prompt; the rev in the payload is what makes the player reload.
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      const affected = db.prepare(`
        SELECT DISTINCT d.id FROM devices d
        JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
        WHERE pi.widget_id = ?
      `).all(req.params.id);
      for (const d of affected) {
        commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), d.id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }

  res.json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id));
});

// Delete widget
router.delete('/:id', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 'lottery' is Loop OS's Mega-Sena widget. Unlike clock/weather it does NOT fetch from the
// device — see lib/lottery.js — it reads this server's cached copy from /:id/data.json.
//
// NOTE 'diag-smoothness' stays in this set because the type is still renderable for internal
// frame-rate diagnostics, but it is deliberately absent from the tenant-facing catalogue in the
// playlist editor: customers must never see it offered as a widget.
const KNOWN_WIDGET_TYPES = new Set(['clock','weather','rss','text','webpage','social','directory-board','directory-search','diag-smoothness','lottery','football']);
function renderWidgetHtml(type, config, opts = {}) {
  const iframeSandbox = opts.iframeSandbox || 'allow-scripts';
  config = config || {};
  switch (type) {
    case 'clock': return renderClock(config);
    case 'weather': return renderWeather(config);
    case 'rss': return renderRSS(config);
    case 'text': return renderText(config, iframeSandbox);
    case 'webpage': return renderWebpage(config, iframeSandbox);
    case 'social': return renderSocial(config);
    case 'directory-board': return renderDirectoryBoard(config);
    case 'directory-search': return renderDirectorySearch(config);
    case 'diag-smoothness': return renderDiagSmoothness(config);
    case 'lottery': return renderLottery(config);
    case 'football': return renderFootball(config);
    default: return '<html><body style="color:white;background:black;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>Unknown widget</h1></body></html>';
  }
}

// The widget editor's Preview is framed by the DASHBOARD, from the dashboard's own
// origin, and the dashboard keeps its session JWT in localStorage. So preview HTML is
// pinned to the isolating sandbox and never consults the org setting: otherwise anyone
// who can author a widget (workspace_editor and up) could run script in the dashboard
// origin and lift the session of whichever admin clicked Preview.
//
// The org setting exists so PLAYERS can embed origin-strict third-party sites. A player
// runs on a kiosk with a device token, which is the risk the confirmation modal
// describes; an admin's dashboard session is not.
const PREVIEW_IFRAME_SANDBOX = 'allow-scripts';

function widgetIframeSandboxForWorkspace(workspaceId) {
  if (!workspaceId) return 'allow-scripts';
  try {
    const row = db.prepare(`
      SELECT COALESCE(o.widget_sandbox_isolation_disabled, 0) AS disabled
      FROM workspaces ws
      LEFT JOIN organizations o ON o.id = ws.organization_id
      WHERE ws.id = ?
    `).get(workspaceId);
    return Number(row?.disabled || 0) === 1
      ? 'allow-scripts allow-same-origin'
      : 'allow-scripts';
  } catch (_) {
    return 'allow-scripts';
  }
}

// Render widget as HTML page
router.get('/:id/render', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');
  const config = JSON.parse(widget.config || '{}');
  const iframeSandbox = widgetIframeSandboxForWorkspace(widget.workspace_id);
  // This page is DESIGNED to be embedded by the player, which frames it in a
  // sandboxed (allow-scripts, no allow-same-origin) iframe = a null origin. The
  // global helmet X-Frame-Options: SAMEORIGIN refuses that (null != same), so
  // widgets render blank in the web player. Drop it here; the sandbox - not
  // X-Frame-Options - is what isolates the widget (it can't read the dashboard JWT).
  res.removeHeader('X-Frame-Options');
  // Caching is keyed on whether the caller pinned a revision.
  //
  // A URL carrying ?rev=<widget.updated_at> is content-addressed: those exact bytes cannot change
  // without the rev changing, so it is safe to cache hard — and it NEEDS to be, because a player
  // that loses its network must still be able to render its widgets. Offline resilience is the
  // point of the player's cache, and no-store made widgets the one thing it could never keep.
  //
  // A URL with no rev is the old shape and stays uncacheable: nothing distinguishes one render
  // from the next, so a cached copy could serve content the operator has already changed.
  if (req.query.rev) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(renderWidgetHtml(widget.widget_type, config, { iframeSandbox }));
});

// Public JSON feed of a directory board's entries. A directory-search page polls
// this to reflect board edits without a reload. It exposes only the same data
// already public via /render, and is CORS-open so a null-origin sandboxed widget
// iframe can read it. 404 (not empty) on a missing/wrong-type source so the
// polling page keeps its last-good data instead of blanking on a transient miss.
// The curated city list for the weather widget's picker (lib/cities-br.js). Declared BEFORE
// '/:id/...' so Express does not match "weather" as a widget id, and outside any other handler —
// a router.get() nested inside a request handler registers a fresh route on every call.
router.get('/weather/cities', (req, res) => {
  const { CITIES } = require('../lib/cities-br');
  res.json(CITIES.map((c) => ({ id: c.id, label: c.label, uf: c.uf })));
});

/*
 * Club crests for the football widget, mirrored from ESPN by lib/football.js.
 *
 * Declared before '/:id/...' for the same reason as the city list above. Public and CORS-open like
 * data.json — the crest is already visible to anyone who can see the rendered widget, and a
 * sandboxed widget iframe has a null origin.
 *
 * The id is the ONLY thing a caller controls, and lib/football.js requires it to be digits before
 * touching the network. There is deliberately no URL parameter: that shape is an open proxy.
 */
router.get('/crest/:id.png', async (req, res) => {
  const file = await require('../lib/football').crestFile(req.params.id);
  if (!file) return res.status(404).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  /*
   * CORP must be relaxed or the crest never paints on a real screen.
   *
   * The player frames a widget in <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin, so
   * the widget document has a NULL origin. An <img> is a no-cors request, and helmet's default
   * Cross-Origin-Resource-Policy: same-origin makes the browser fetch the bytes, get a 200, and
   * then throw the response away — the tag fires `error` and nothing is drawn. The server log
   * shows a perfectly good 200, which is exactly why this looked like a network fault for days.
   * data.json was unaffected because fetch() is CORS mode and CORP does not apply to it.
   *
   * Nothing is granted here that was not already public: this endpoint is unauthenticated and
   * already answers Access-Control-Allow-Origin: *.
   */
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Crests do not change. Caching hard is what keeps a wall of panels from asking again.
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.type('png');
  return res.sendFile(file);
});

/*
 * The photograph for item N of a news widget's own feed, mirrored by lib/news.js.
 *
 * BY INDEX, NEVER BY URL. An endpoint taking the image URL would be an open proxy — and the SSRF
 * guard would not save it, since that stops private addresses rather than the use of this server
 * as an anonymous fetcher for the whole public internet. The index is resolved against the feed
 * THIS widget is configured with, so nothing outside a feed the customer chose is reachable.
 */
router.get('/:id/newsimg/:n', async (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget || widget.widget_type !== 'rss') return res.status(404).end();
  let cfg = {};
  try { cfg = JSON.parse(widget.config || '{}'); } catch { cfg = {}; }

  const file = await require('../lib/news').imageFor(cfg.feed_url, req.params.n);
  if (!file) return res.status(404).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Same reason as the crest route: the widget runs at a null origin inside the player's sandboxed
  // iframe, and the default same-origin CORP silently discards a 200 image.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Short: the item at a given index changes as the feed moves on, unlike a club crest.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('jpeg');
  return res.sendFile(file);
});

router.get('/:id/data.json', async (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);

  // Weather and football are served the same way as the lottery below: from a shared server-side
  // cache, so a hundred panels asking at once is still ONE upstream request, the payload arrives
  // in Portuguese, and a panel with no route to the public internet still renders.
  if (widget && (widget.widget_type === 'weather' || widget.widget_type === 'football')) {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    let cfg = {};
    try { cfg = JSON.parse(widget.config || '{}'); } catch { cfg = {}; }

    let data = null;
    try {
      data = widget.widget_type === 'weather'
        ? await require('../lib/weather').getWeather(cfg.city_id)
        : await require('../lib/football').get(cfg.view === 'table' ? 'table' : 'matches');
    } catch (e) {
      console.warn(`[${widget.widget_type}] data.json failed: ${e.message}`);
    }
    // 404 rather than an empty object when there is genuinely nothing yet: the polling widget
    // keeps its last-good render instead of clearing itself on a transient miss.
    if (!data) return res.status(404).json({ error: 'No data available yet' });
    return res.json(data);
  }

  /*
   * News: parsed and cached by lib/news.js. The widget used to call api.rss2json.com from the
   * player once per panel — a third-party quota between a customer and their own headlines, and
   * dead on any screen without a route to the public internet.
   *
   * Image URLs are deliberately NOT in this payload. The widget asks for /newsimg/<index> and the
   * server resolves the index against its own cache, so the only images that can ever be fetched
   * are ones already in a feed the customer configured. See lib/news.js imageFor().
   */
  if (widget && widget.widget_type === 'rss') {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    let rssCfg = {};
    try { rssCfg = JSON.parse(widget.config || '{}'); } catch { rssCfg = {}; }
    let data = null;
    try { data = await require('../lib/news').get(rssCfg.feed_url); } catch (e) {
      console.warn(`[news] data.json failed: ${e.message}`);
    }
    if (!data) return res.status(404).json({ error: 'No data available yet' });
    return res.json({
      source: data.source,
      stale: !!data.stale,
      items: data.items.map((i, n) => ({
        title: i.title,
        date: i.date,
        category: i.category,
        // A flag, not a URL: the index IS the handle.
        image: i.image ? n : null,
      })),
    });
  }

  // Loop OS lottery: served from the server's shared cache, so a hundred panels asking at once
  // is still one upstream request (lib/lottery.js dedupes and keeps the last good result).
  if (widget && widget.widget_type === 'lottery') {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    let lotCfg = {};
    try { lotCfg = JSON.parse(widget.config || '{}'); } catch { lotCfg = {}; }
    let data = null;
    /*
     * A widget may be set to SEVERAL modalities, in which case it cycles through them on screen —
     * one slot in a playlist instead of one widget per game. The single-game shape stays exactly
     * as it was, so every widget created before this keeps working untouched.
     */
    const chosen = Array.isArray(lotCfg.games) ? lotCfg.games : null;
    if (chosen && chosen.length > 1) {
      try {
        const many = await require('../lib/lottery').getMany(chosen);
        if (many) return res.json({ rotation: many });
      } catch (e) {
        console.warn(`[lottery] rotation data.json failed: ${e.message}`);
      }
      return res.status(404).json({ error: 'No data available yet' });
    }
    // Each modality has its own cache entry; an unknown value falls back to Mega-Sena rather
    // than 404ing, so a config typo degrades to the most popular game instead of a blank screen.
    try { data = await require('../lib/lottery').getLatest((chosen && chosen[0]) || lotCfg.game); } catch (e) {
      console.warn(`[lottery] data.json failed: ${e.message}`);
    }
    // 404 rather than an empty object when there is genuinely nothing yet, matching the
    // directory-board contract below: the polling widget keeps its last-good render instead of
    // clearing itself on a transient miss.
    if (!data) return res.status(404).json({ error: 'No lottery result available yet' });
    return res.json(data);
  }

  if (!widget || widget.widget_type !== 'directory-board') return res.status(404).json({ error: 'Not a directory board' });
  let categories = [];
  try {
    const cfg = JSON.parse(widget.config || '{}');
    categories = Array.isArray(cfg.categories) ? cfg.categories : [];
  } catch (e) { categories = []; }
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ categories });
});

// Latest frame-rate telemetry per widget, reported by the diag-smoothness widget running on a device.
// In-memory (diagnostic, not persisted) — a device page reads the snapshot for the widget it plays.
//
// BOUNDED, because the writer is unauthenticated (the widget runs in a null-origin sandboxed
// iframe and cannot carry a session) and the key comes from the request body. An uncapped map
// keyed on caller-supplied values is a remote memory-exhaustion path, and on this product a dead
// server means the whole fleet reconnects at once.
//
// The cap is GLOBAL rather than per-IP on purpose: signage sites egress through one NAT address,
// so a per-IP limit would punish an entire venue for one noisy panel while doing nothing about a
// distributed writer. Same reasoning as lib/ota-download-guard ("NEVER per-IP (SNAT)"). Eviction
// is least-recently-written, and a live panel rewrites its key every 2.5s, so only entries the
// dashboard would already call stale (>15s) are ever eligible.
const widgetTelemetry = require('../lib/bounded-snapshot-store').createStore({ max: 500, ttlMs: 60_000 });
widgetTelemetry.startSweep();
// Public POST from the widget: it runs in a null-origin sandboxed iframe, so this must be no-auth +
// CORS-open. The widget sends text/plain (a "simple" request → no CORS preflight); we JSON.parse it.
router.post('/:id/telemetry', express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let t = {};
  try { t = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) { t = {}; }
  t.receivedAt = Date.now();
  // Key by the reporting device (player passes ?device=<id>) so multiple panels don't collide;
  // fall back to a widget-scoped key for players that don't pass a device id yet.
  const key = (t.device && String(t.device).slice(0, 64)) || ('w:' + req.params.id);
  widgetTelemetry.set(key, t);
  // 204, not res.json(): this is fire-and-forget diagnostic data and the reporting widget ignores
  // the response entirely (routes/widgets.js renderDiagSmoothness -> fetch(...).catch()). It also
  // keeps services/activity.js activityLogger — which wraps res.json — from writing an activity_log
  // row per unauthenticated report, i.e. from letting an anonymous caller grow a DB table.
  res.status(204).end();
});
// Public GET so the dashboard device page can display the snapshot. ?device=<id> reads that panel's
// report; without it (or if that panel hasn't reported) falls back to the widget-scoped snapshot.
router.get('/:id/telemetry', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const dev = req.query.device ? String(req.query.device) : null;
  // Device-scoped request returns ONLY that device's report — NO widget-wide fallback, or one
  // reporting panel's data would show on every other device's page (incl. offline ones). A request
  // with no device id gets the widget-scoped snapshot (raw/debug view only).
  // get() returns null for a missing OR expired entry, so a stale snapshot is never served
  // as live even between sweeps.
  const rec = dev ? widgetTelemetry.get(dev) : widgetTelemetry.get('w:' + req.params.id);
  res.json(rec || null);
});

// Preview unsaved widget from config (used by editor Preview button)
router.post('/preview', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  // Preview renders inside the DASHBOARD origin, so it never opts into same-origin —
  // see PREVIEW_IFRAME_SANDBOX.
  let html = renderWidgetHtml(widget_type, config || {}, { iframeSandbox: PREVIEW_IFRAME_SANDBOX });
  if (req.workspaceId) html = inlineUserContent(html, req.workspaceId);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Preview sessions — ephemeral store so the preview iframe loads via src (not srcdoc)
// and bypasses the dashboard CSP that would block the widget's inline scripts.
const previewStore = new Map();
const PREVIEW_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of previewStore) {
    if (now - entry.created > PREVIEW_TTL) previewStore.delete(key);
  }
}, 60 * 1000).unref();

router.post('/preview-session', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  const id = uuidv4();
  // Same reasoning as /preview — dashboard origin, never same-origin.
  const html = renderWidgetHtml(widget_type, config || {}, { iframeSandbox: PREVIEW_IFRAME_SANDBOX });
  previewStore.set(id, { html, widget_type, created: Date.now() });
  res.json({ id, url: `/api/widgets/preview-session/${id}` });
});

router.get('/preview-session/:id', (req, res) => {
  const entry = previewStore.get(req.params.id);
  if (!entry) return res.status(410).send('Preview expired');
  if (Date.now() - entry.created > PREVIEW_TTL) {
    previewStore.delete(req.params.id);
    return res.status(410).send('Preview expired');
  }
  let html = entry.html;
  if (req.workspaceId) html = inlineUserContent(html, req.workspaceId);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/*
 * Clock. Rewritten for screen scale and pt-BR.
 *
 * It used to hardcode the 'en-US' locale, so a Brazilian panel read "Saturday, August 15, 2026",
 * and it sized itself in fixed pixels, so the time occupied a tenth of a 1080p screen. Both come
 * from the widget kit now: pt-BR by default (still overridable) and every size in --u.
 *
 * The seconds tick in a separate, smaller element rather than inside the main figure. At TV
 * distance the hour and minute are the information; seconds changing under the same weight drag
 * the eye to the least useful digit on the screen.
 */
function renderClock(c) {
  const locale = safeCss(c.locale, 'pt-BR');
  const tz = safeTimezone(c.timezone);
  const showDate = c.show_date !== false;
  // Off unless asked for. Seconds are the least useful digit on a wall clock and the only thing on
  // the widget that moves every second; opting in is the right way round.
  const showSeconds = c.show_seconds === true;
  const label = String(c.label || '').slice(0, 40);
  const accent = safeCss(c.accent, '#4C8FD6');
  return `<!DOCTYPE html><html lang="pt-BR"><head>${kit.baseHead({ background: safeCss(c.background, ''), accent })}
<style>${kit.backdrop('clock')}
  /* One card holding the whole reading, the way a station clock is one panel rather than three
     floating numbers. It grows with the stage, so the same markup fills a portrait totem and a
     landscape TV without a second layout. */
  /* The card takes the height it is given rather than a fixed one, so a totem gets a tall card
     and a TV a wide one from the same rule. The max-height is what stops a portrait screen from
     stretching it edge to edge, which reads as a background rather than as a panel. */
  .w-body { align-items:stretch; }
  .w-stage { display:flex; align-self:stretch; align-items:center; }
  .card {
    position:relative; flex:1 1 auto; height:100%; border-radius:calc(var(--u) * 3.5);
    background:linear-gradient(160deg, #2A3B50 0%, #1E2C3E 55%, #24374B 100%);
    box-shadow:0 calc(var(--u) * 1.5) calc(var(--u) * 5) rgba(0,0,0,.45);
    padding:calc(var(--u) * 5);
    display:flex; flex-direction:column; max-height:calc(var(--u) * 105);
  }
  @media (orientation: landscape) { .card { max-height:calc(var(--u) * 64); } }
  /* A wash across the foot of the card, so the flat fill reads as a surface with light on it. */
  .card::after {
    content:''; position:absolute; left:0; right:0; bottom:0; height:38%;
    border-radius:0 0 calc(var(--u) * 3.5) calc(var(--u) * 3.5);
    background:linear-gradient(180deg, transparent, rgba(255,255,255,.045));
    pointer-events:none;
  }
  #label { text-align:left; font-size:calc(var(--u) * 4.2); color:var(--text); opacity:.92; }
  .mid { flex:1 1 auto; display:flex; align-items:center; justify-content:center; }
  .clock { display:flex; align-items:center; justify-content:center; gap:calc(var(--u) * 1.2); }
  #time, #mins, #secs { font-variant-numeric:tabular-nums; line-height:1; }
  #time, #mins { font-size:calc(var(--u) * 26); font-weight:800; letter-spacing:-0.02em;
                 color:${safeCss(c.color, 'var(--text)')}; }
  @media (orientation: landscape) { #time, #mins { font-size:calc(var(--u) * 30); } }
  /* Two squares rather than a colon: at TV distance a punctuation mark between 26u digits
     disappears, and the blink is what tells a passer-by the clock is live and not a frozen panel. */
  .sep { display:flex; flex-direction:column; justify-content:center;
         gap:calc(var(--u) * 2.6); margin:0 calc(var(--u) * 1.4); animation:sepBlink 2s steps(1,end) infinite; }
  .sep i { display:block; width:calc(var(--u) * 2.2); height:calc(var(--u) * 2.2);
           background:rgba(255,255,255,.28); border-radius:calc(var(--u) * .4); }
  @keyframes sepBlink { 0%,50% { opacity:1; } 50.01%,100% { opacity:.25; } }
  /* Seconds ride as a superscript, not on the baseline: at TV distance a digit changing under the
     same weight as the hour pulls the eye to the least useful number on the screen. */
  #secs { font-size:calc(var(--u) * 7); font-weight:600; color:var(--accent);
          align-self:flex-start; margin-left:calc(var(--u) * 1.4); margin-top:calc(var(--u) * 1.5); }
  /* pt-BR returns "domingo, 16 de agosto de 2026" all lowercase. Using text-transform:capitalize
     would title-case every word - "Domingo, 16 De Agosto De 2026" - which is not how Portuguese
     is written. Only the first letter should rise. */
  #date { text-align:right; font-size:calc(var(--u) * 4.4); color:var(--text); opacity:.92;
          line-height:1.35; }
  #date::first-letter { text-transform:uppercase; }
</style></head><body class="w-shell">
${kit.shell({
    title: String(c.title || 'Hora atual'),
    content: `<div class="w-stage">
    <div class="card w-rise" style="--d:60ms">
      <div id="label">${kit.esc(label)}</div>
      <div class="mid">
        <div class="clock">
          <div id="time">--</div>
          <div class="sep"><i></i><i></i></div>
          <div id="mins">--</div>
          ${showSeconds ? '<div id="secs">--</div>' : ''}
        </div>
      </div>
      ${showDate ? '<div id="date"></div>' : ''}
    </div>
  </div>`,
  })}
<script>${kit.baseScript()}
  // TZ is null unless the widget was given one, and null means "the device's own clock": Intl
  // reads the panel's zone when timeZone is undefined. Passing a zone the operator never chose is
  // how this showed UTC on a wall in Espírito Santo.
  var LOCALE = ${JSON.stringify(locale)}, TZ = ${JSON.stringify(tz)} || undefined;
  var hour12 = ${c.format === '12h'};

  // formatToParts rather than splitting a formatted string: the separator is locale-dependent
  // (and "13:05" vs "1:05 PM" differ in more than the colon), and the two halves are rendered in
  // separate elements so the blinking squares can sit between them.
  var timeFmt = new Intl.DateTimeFormat(LOCALE,
    { hour12: hour12, timeZone: TZ, hour: '2-digit', minute: '2-digit' });

  function update() {
    var now = new Date();
    var parts = timeFmt.formatToParts(now);
    var h = '', m = '', suffix = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'hour') h = parts[i].value;
      else if (parts[i].type === 'minute') m = parts[i].value;
      else if (parts[i].type === 'dayPeriod') suffix = parts[i].value;
    }
    wSet(document.getElementById('time'), h, false);
    wSet(document.getElementById('mins'), m + (suffix ? ' ' + suffix : ''), false);
    ${showSeconds ? `wSet(document.getElementById('secs'),
      now.toLocaleTimeString(LOCALE, { timeZone: TZ, second: '2-digit' }).replace(/\\D/g, '').padStart(2, '0'), false);` : ''}
    ${showDate ? `var day = document.getElementById('date');
    var next = now.toLocaleDateString(LOCALE, { timeZone: TZ, weekday: 'long' })
      + '\\n' + now.toLocaleDateString(LOCALE, { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
    if (day.dataset.v !== next) {
      day.dataset.v = next;
      day.textContent = '';
      next.split('\\n').forEach(function (line) {
        var d = document.createElement('div');
        d.textContent = line;
        day.appendChild(d);
      });
    }` : ''}
  }
  update(); setInterval(update, 1000);
</script></body></html>`;
}

/*
 * Caixa lottery results — all ten modalities.
 *
 * The data comes from THIS server (/api/widgets/:id/data.json), not from the device: see
 * lib/lottery.js for why a fleet of panels must not each poll Caixa directly.
 *
 * ONE RENDERER, FOUR SHAPES. Six of the ten are "a set of drawn numbers" and differ only in how
 * many. The other four are not: Dupla Sena draws twice, +Milionária adds two clovers, Super Sete
 * is seven numbered columns, and Federal has no drawn numbers at all — it is five prize places
 * against ticket numbers. `kind` on the payload selects the block; everything else (chrome,
 * wordmark, contest line, accumulated line) is shared, which is what keeps ten games looking like
 * one widget instead of ten.
 *
 * BALL SIZE AND ROW LENGTH ARE DERIVED. The games draw between 5 and 20 numbers, and the panel is
 * as likely to be a portrait totem as a landscape TV. Both are computed from the count and the
 * current orientation against --stage, so Lotomania's twenty fill a 16:9 screen as ten-and-ten and
 * a totem as four rows of five, from the same markup.
 *
 * Everything reaches the DOM through textContent — the payload is third-party and this widget
 * may run with same-origin privileges depending on the org's sandbox setting.
 */
function renderLottery(c) {
  const { GAMES } = require('../lib/lottery');
  const game = GAMES[c.game] || GAMES.megasena;

  /*
   * Every lottery widget created before this rework carries accent '#00A868', because the old
   * catalogue wrote that constant into the config of every one it made — it was never a choice
   * anybody expressed. Honouring it now would defeat the per-game identity: Lotomania would
   * render in Mega-Sena's green on every widget that already exists.
   *
   * So that ONE legacy value defers to the game's colour, and any other accent still wins, which
   * is what a customer who genuinely picked one would expect.
   */
  const LEGACY_DEFAULT_ACCENT = '#00A868';
  const chosen = String(c.accent || '').toUpperCase() === LEGACY_DEFAULT_ACCENT ? null : c.accent;
  const accent = safeCss(chosen, game.accent);
  return `<!DOCTYPE html><html lang="pt-BR"><head>${kit.baseHead({ background: safeCss(c.background, ''), accent })}
<style>${kit.backdrop('lottery')}
  /* Identity block pinned to the top, result centred in whatever is left. Centring the whole
     column instead leaves a portrait screen with a third of its height empty above the wordmark,
     which reads as a widget that did not know how tall it was. */
  .w-body { align-items:stretch; }
  .w-stage { text-align:left; align-self:stretch; display:flex; flex-direction:column; }
  #result { flex:1 1 auto; display:flex; flex-direction:column; justify-content:center; min-height:0; }
  /* The wordmark carries the game's identity, so it is the one element allowed to be loud: a
     vertical gradient reads as the moulded metallic lettering these brands use in print. */
  .game {
    font-size:calc(var(--u) * 9); font-weight:900; letter-spacing:.01em; line-height:1;
    text-transform:uppercase;
    background:linear-gradient(180deg,
      color-mix(in srgb, var(--accent) 45%, #FFF) 0%,
      var(--accent) 46%,
      color-mix(in srgb, var(--accent) 62%, #000) 100%);
    -webkit-background-clip:text; background-clip:text;
    -webkit-text-fill-color:transparent; color:transparent;
    filter:drop-shadow(0 calc(var(--u) * .4) calc(var(--u) * 1.2) rgba(0,0,0,.55));
  }
  @media (orientation: landscape) { .game { font-size:calc(var(--u) * 11); } }

  .contest-row { display:flex; align-items:baseline; gap:calc(var(--u) * 2.5);
                 margin-top:calc(var(--u) * 2); }
  .contest-lbl { font-size:calc(var(--u) * 3); letter-spacing:.22em; text-transform:uppercase;
                 color:var(--text); opacity:.9; padding-bottom:calc(var(--u) * .8);
                 border-bottom:calc(var(--u) * .28) solid rgba(255,255,255,.75); }
  #contest { font-size:calc(var(--u) * 6.4); font-weight:300; letter-spacing:.02em;
             font-variant-numeric:tabular-nums; }

  .acc { display:flex; align-items:baseline; gap:calc(var(--u) * 3); margin-top:calc(var(--u) * 1.6);
         font-size:calc(var(--u) * 3.4); font-weight:800; letter-spacing:.06em; min-height:1.2em; }
  .acc .tag { color:#FFC53D; text-transform:uppercase; }
  .acc .val { color:var(--brand); font-weight:700; }

  #result { margin-top:calc(var(--u) * 4); }
  .draw-label { font-size:calc(var(--u) * 3); color:var(--text); opacity:.85; letter-spacing:.1em;
                text-transform:uppercase; margin:calc(var(--u) * 2.5) 0 calc(var(--u) * 1.5);
                text-align:center; }
  .draw-label:first-child { margin-top:0; }

  .balls { display:flex; flex-wrap:wrap; gap:var(--gap); justify-content:center;
           margin:0 auto; max-width:var(--rowmax, 100%); }
  .ball {
    width:var(--ball); height:var(--ball); border-radius:50%;
    background:linear-gradient(165deg,
      color-mix(in srgb, var(--accent) 82%, #000) 0%,
      color-mix(in srgb, var(--accent) 52%, #000) 100%);
    /* The ring is what separates one ball from the next when they share a colour and sit on a
       dark ground; without it a row of twenty reads as a single blob from across a room. */
    box-shadow:inset 0 0 0 calc(var(--u) * .35) color-mix(in srgb, var(--accent) 70%, #FFF),
               0 calc(var(--u) * .5) calc(var(--u) * 1.6) rgba(0,0,0,.45);
    color:#FFF; display:flex; align-items:center; justify-content:center;
    font-size:calc(var(--ball) * .42); font-weight:700; font-variant-numeric:tabular-nums;
    text-shadow:0 calc(var(--u) * .2) calc(var(--u) * .6) rgba(0,0,0,.5);
  }

  /* Super Sete: the column number belongs ABOVE its digit, or seven loose digits say nothing. */
  .col { display:flex; flex-direction:column; align-items:center; gap:calc(var(--u) * 1); }
  .col-n { font-size:calc(var(--ball) * .3); font-weight:700; color:var(--accent); }

  /* +Milionária's trevos. Four overlapping circles are a cleaner clover at any resolution than a
     hand-written path, and they take the fill from the same accent as the balls. */
  .clover { position:relative; width:var(--ball); height:var(--ball); }
  .clover svg { position:absolute; inset:0; width:100%; height:100%;
                color:color-mix(in srgb, var(--accent) 62%, #000);
                filter:drop-shadow(0 calc(var(--u) * .5) calc(var(--u) * 1.4) rgba(0,0,0,.45)); }
  .clover span { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                 font-size:calc(var(--ball) * .38); font-weight:700; color:#FFF; }

  /* Federal: a prize table, not a draw. */
  .tickets { width:100%; max-width:calc(var(--u) * 62); margin:0 auto;
             border-collapse:collapse; font-variant-numeric:tabular-nums; }
  .tickets th { font-size:calc(var(--u) * 3); font-weight:600; letter-spacing:.16em;
                text-transform:uppercase; color:var(--text); opacity:.85;
                padding-bottom:calc(var(--u) * 2); }
  /* Sized against the balls the other nine games show: a prize table set two sizes smaller reads
     as a footnote rather than as this game's result. */
  .tickets td { font-size:calc(var(--u) * 7); padding:calc(var(--u) * 1.6) calc(var(--u) * 3); }
  .tickets td.place { text-align:right; width:38%; font-size:calc(var(--u) * 4.6); }
  .tickets td.num { text-align:left; color:var(--brand); font-weight:700;
                    border-left:calc(var(--u) * .25) dashed rgba(255,255,255,.35); }

  .extra { margin-top:calc(var(--u) * 3); text-align:center;
           font-size:calc(var(--u) * 5); font-weight:800; color:var(--accent); }
  .extra span { display:block; font-size:.55em; font-weight:600; letter-spacing:.14em;
                text-transform:uppercase; color:var(--text); opacity:.8;
                margin-bottom:calc(var(--u) * .8); }
  .stale { text-align:center; font-size:calc(var(--u) * 2.4); color:var(--text-mute);
           opacity:.55; margin-top:calc(var(--u) * 2); }

  /* Balls drop rather than fade: it is what a draw looks like, and it costs one keyframe. */
  @keyframes ballDrop {
    0%   { opacity:0; transform:translateY(calc(var(--u) * -6)) scale(.7); }
    60%  { opacity:1; transform:translateY(calc(var(--u) * .8)) scale(1.06); }
    100% { opacity:1; transform:none; }
  }
  .ball, .clover { animation: ballDrop 560ms cubic-bezier(.22,1,.36,1) both;
                   animation-delay: var(--d, 0ms); }
</style></head><body class="w-shell">
${kit.shell({
    title: String(c.title || 'Resultados da loteria'),
    content: `<div class="w-stage">
    <div class="game w-rise" style="--d:40ms" id="game">${kit.esc(game.label)}</div>
    <div class="contest-row w-rise" style="--d:130ms">
      <div class="contest-lbl">Concurso</div>
      <div id="contest">&nbsp;</div>
    </div>
    <div class="acc w-rise" style="--d:200ms" id="acc"></div>
    <div id="result"><div class="w-loading">carregando&hellip;</div></div>
    <div class="extra" id="extra" style="display:none"></div>
    <div class="stale" id="stale"></div>
  </div>`,
  })}
<script>${kit.baseScript()}
  var BRL = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 });
  var last = null;   // whole payload of the last render, so orientation changes can re-lay-out

  // Four overlapping circles are a cleaner clover at any resolution than a hand-written path.
  // Built through the DOM rather than as an innerHTML string: this widget has a hard rule that
  // nothing here assigns innerHTML, and a rule with one audited exception is a rule that gets
  // extended by the next person to touch the file.
  function cloverSvg() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    [[33, 33], [67, 33], [33, 67], [67, 67]].forEach(function (p) {
      var circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', p[0]);
      circle.setAttribute('cy', p[1]);
      circle.setAttribute('r', '25');
      svg.appendChild(circle);
    });
    return svg;
  }

  function isLandscape() { return window.matchMedia('(orientation: landscape)').matches; }

  /*
   * How many items per row, and how big. Portrait keeps rows short so the balls stay large;
   * landscape spends the extra width on longer rows instead of leaving two thirds of a TV empty.
   */
  function perRow(n, kind) {
    var wide = isLandscape();
    if (kind === 'columns') return wide ? n : 4;
    if (n <= 6)  return wide ? n : 3;
    if (n <= 7)  return wide ? n : 4;
    if (n <= 10) return wide ? n : 5;
    if (n <= 15) return wide ? 8 : 5;
    return wide ? 10 : 5;
  }

  function applySizes(n, kind) {
    var per = perRow(n, kind);
    var stage = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stage')) || 92;
    // Gap is a fixed fraction of the ball, so one solve gives both.
    var ball = (stage * 0.94) / (per + 0.22 * (per - 1));
    ball = Math.min(ball, isLandscape() ? 17 : 21);
    var gap = ball * 0.22;
    var root = document.documentElement.style;
    root.setProperty('--ball', 'calc(var(--u) * ' + ball + ')');
    root.setProperty('--gap', 'calc(var(--u) * ' + gap + ')');
    // A hair of slack: sized to the exact sum, subpixel rounding drops the last ball to its own row.
    root.setProperty('--rowmax', 'calc(var(--u) * ' + (per * ball + (per - 1) * gap + 0.4) + ')');
  }

  // Caixa sends dd/mm/yyyy. Compared by DAY, not by instant: a draw happening tonight is still
  // "upcoming" all day today.
  function upcoming(br) {
    // Escapes DOUBLED — this script lives in a template literal, where \\d collapses to d and \\/
    // ends the regex early. Authoring it singly is a syntax error at render time, not at build.
    var m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(String(br || ''));
    if (!m) return false;
    var draw = new Date(+m[3], +m[2] - 1, +m[1]);
    var now = new Date();
    return draw >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function ballEl(text, delayIndex) {
    var b = document.createElement('div');
    b.className = 'ball';
    b.style.setProperty('--d', (delayIndex * 90) + 'ms');
    b.textContent = text;              // textContent, not innerHTML: third-party data
    return b;
  }

  function row(host, numbers, from) {
    var r = document.createElement('div');
    r.className = 'balls';
    numbers.forEach(function (n, i) { r.appendChild(ballEl(n, from + i)); });
    host.appendChild(r);
    return numbers.length;
  }

  function label(host, text) {
    var l = document.createElement('div');
    l.className = 'draw-label';
    l.textContent = text;
    host.appendChild(l);
  }

  function buildResult(d) {
    var host = document.getElementById('result');
    host.textContent = '';
    var i = 0;

    if (d.kind === 'tickets') {
      var t = document.createElement('table');
      t.className = 'tickets';
      var head = t.insertRow();
      ['Prêmio', 'Bilhete'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
      });
      (d.tickets || []).forEach(function (tk) {
        var tr = t.insertRow();
        var a = tr.insertCell(); a.className = 'place'; a.textContent = tk.place + 'º';
        var b = tr.insertCell(); b.className = 'num'; b.textContent = tk.ticket;
      });
      host.appendChild(t);
      return;
    }

    if (d.kind === 'columns') {
      var wrap = document.createElement('div');
      wrap.className = 'balls';
      (d.numbers || []).forEach(function (n, k) {
        var col = document.createElement('div');
        col.className = 'col';
        var cn = document.createElement('div');
        cn.className = 'col-n';
        cn.textContent = String(k + 1);
        col.appendChild(cn);
        col.appendChild(ballEl(n, k));
        wrap.appendChild(col);
      });
      host.appendChild(wrap);
      return;
    }

    // Dupla Sena is the only game that draws twice. Label BOTH draws when it does — a lone
    // "2º sorteio" divider leaves the reader wondering what the row above it was.
    var hasSecond = !!(d.numbers2 && d.numbers2.length);
    if (hasSecond) label(host, '1º sorteio');
    i += row(host, d.numbers || [], i);
    if (hasSecond) {
      label(host, '2º sorteio');
      i += row(host, d.numbers2, i);
    }
    if (d.clovers && d.clovers.length) {
      label(host, 'Trevos');
      var cw = document.createElement('div');
      cw.className = 'balls';
      d.clovers.forEach(function (n, k) {
        var cl = document.createElement('div');
        cl.className = 'clover';
        cl.style.setProperty('--d', ((i + k) * 90) + 'ms');
        cl.appendChild(cloverSvg());
        var s = document.createElement('span');
        s.textContent = n;                           // the value itself stays textContent
        cl.appendChild(s);
        cw.appendChild(cl);
      });
      host.appendChild(cw);
    }
  }

  function render(d) {
    if (!d) return;
    var count = (d.numbers && d.numbers.length) || (d.tickets && d.tickets.length) || 0;
    if (!count) return;
    last = d;

    document.documentElement.style.setProperty('--accent', d.accent || 'var(--brand)');
    applySizes(d.ball_count || count, d.kind);

    wSet(document.getElementById('game'), d.game_label, false);
    wSet(document.getElementById('contest'), d.contest, false);

    // Built as ELEMENTS with textContent, never as an innerHTML string. Every line mixes our own
    // wording with values straight from a third-party API, and this widget can run with
    // same-origin privileges depending on the org's sandbox setting.
    var acc = document.getElementById('acc');
    acc.textContent = '';
    function part(cls, text) {
      var n = document.createElement('span');
      n.className = cls;
      n.textContent = text;
      acc.appendChild(n);
    }
    if (d.accumulated) {
      part('tag', 'Acumulou');
      if (d.nextEstimate) part('val', BRL.format(d.nextEstimate));
    } else if (d.winners) {
      part('tag', d.winners === 1 ? '1 ganhador' : d.winners + ' ganhadores');
      if (d.prize) part('val', BRL.format(d.prize));
    }

    // Only rebuild (and replay the drop) when the DRAW changes. Re-running the animation on
    // every poll would make the balls jump every few minutes for no reason.
    var key = d.game + ':' + d.contest;
    if (key !== render.lastKey) { render.lastKey = key; buildResult(d); }

    var extra = document.getElementById('extra');
    if (d.extra && d.extra_label) {
      extra.textContent = '';
      var cap = document.createElement('span');
      cap.textContent = d.extra_label;
      extra.appendChild(cap);
      extra.appendChild(document.createTextNode(d.extra));
      extra.style.display = '';
    } else {
      extra.style.display = 'none';
    }

    /*
     * Only announce the next draw while it is still ahead. Caixa keeps publishing
     * dataProximoConcurso for a draw that has already been held until it publishes the result, so
     * echoing it verbatim leaves a screen promising a sorteio that happened yesterday — which is
     * what makes a perfectly current result look like stale data.
     */
    wSet(document.getElementById('wFoot'), upcoming(d.nextDate) ? 'Próximo sorteio: ' + d.nextDate : '', false);
    wSet(document.getElementById('stale'), d.stale ? 'resultado em cache' : '', false);
  }

  // A panel can be rotated after it is mounted, and some players report the rotation only once
  // the WebView has already painted. Re-solving the layout is cheap and needs no refetch.
  function relayout() {
    if (!last) return;
    applySizes(last.ball_count || (last.numbers || []).length, last.kind);
  }
  window.addEventListener('resize', relayout);
  window.matchMedia('(orientation: landscape)').addEventListener('change', relayout);

  /*
   * A widget set to several modalities cycles through them, so one playlist slot covers the games
   * the customer cares about. The starting point comes from the clock, not from zero: this page is
   * reloaded every time the playlist comes back round, and starting at the first game each time
   * would mean the last ones in the list were never shown.
   */
  var GAME_MS = ${Math.max(5000, safeNumber(c.game_seconds, 12) * 1000)};
  var rotation = null, rotAt = 0, rotTimer = null;

  function step() {
    render(rotation[rotAt % rotation.length]);
    rotAt++;
    clearTimeout(rotTimer);
    rotTimer = setTimeout(step, GAME_MS);
  }

  function onData(d) {
    if (!d) return;
    if (!d.rotation) { rotation = null; clearTimeout(rotTimer); return render(d); }

    // Only restart the cycle when the SET of games changes; a refresh that returns the same games
    // must not throw away the one currently on screen.
    var key = d.rotation.map(function (g) { return g.game + ':' + g.contest; }).join('|');
    rotation = d.rotation;
    if (key === onData.lastKey) return;
    onData.lastKey = key;
    rotAt = Math.floor(Date.now() / GAME_MS) % rotation.length;
    clearTimeout(rotTimer);
    step();
  }

  wPoll('data.json', onData, 900000);
</script></body></html>`;
}

function renderWeather(c) {
  // Data comes from THIS server (/api/widgets/:id/data.json -> lib/weather.js), never from the
  // panel: one request per city shared by the whole fleet, in Portuguese, and resolved by
  // coordinates so an ambiguous city name cannot silently show the wrong town's weather.
  const city = findCity(c.city_id);
  const label = city ? cityLabel(city) : (c.location || '');
  const showForecast = c.show_forecast !== false;
  const accent = safeCss(c.accent, '#4CC2F1');
  return `<!DOCTYPE html><html lang="pt-BR"><head>${kit.baseHead({ background: safeCss(c.background, ''), accent })}
<style>${kit.backdrop('weather')}
  /* Landscape puts the reading and the forecast side by side instead of stacking them down the
     middle of a screen that is twice as wide as it is tall. */
  .w-stage { display:flex; flex-direction:column; justify-content:center; }
  @media (orientation: landscape) {
    .w-stage { flex-direction:row; align-items:center; gap:calc(var(--u) * 8); }
    /* SHRINK, not 0 0 auto: the reading block is as wide as its longest line ("Chuva Fraca Nas
       Proximidades"), and on a panel narrower than about 1.6:1 that pushed the whole row past the
       stage and cut the city name off the left edge. It gives way to the forecast instead. */
    .now { flex:0 1 auto; min-width:0; text-align:left; }
    .now .top, .now .meta { justify-content:flex-start; }
    .now .city, .now .desc { overflow:hidden; text-overflow:ellipsis; }
    .fc { flex:0 0 auto; margin-top:0 !important; }
  }
  .top { display:flex; align-items:center; justify-content:center; gap:calc(var(--u) * 4); }
  .icon { width:calc(var(--u) * 22); height:calc(var(--u) * 22); color:var(--accent); flex-shrink:0; }
  .icon svg { width:100%; height:100%; }
  .temp { font-size:calc(var(--u) * 24); font-weight:800; line-height:1; letter-spacing:-0.03em;
          font-variant-numeric:tabular-nums; color:${safeCss(c.color, 'var(--text)')}; }
  .temp sup { font-size:.45em; vertical-align:super; font-weight:600; }
  .city { font-size:calc(var(--u) * 6); font-weight:600; margin-top:calc(var(--u) * 2.5); }
  /* First letter only. capitalize title-cases every word — "Chuva Fraca Nas Proximidades" — which
     is not how Portuguese is written. Same fix the clock's date line already carries. */
  .desc { font-size:calc(var(--u) * 4.2); color:var(--text-dim); margin-top:calc(var(--u) * 1); }
  .desc::first-letter { text-transform:uppercase; }
  .meta { display:flex; gap:calc(var(--u) * 5); justify-content:center; margin-top:calc(var(--u) * 3);
          font-size:calc(var(--u) * 3.4); color:var(--text-mute); }
  .fc { display:flex; gap:calc(var(--u) * 3); justify-content:center; margin-top:calc(var(--u) * 5); }
  /* Direct children only. A bare descendant selector also matched the day label and the
     temperature INSIDE each card, so every card drew a box around each of its own two lines. */
  .fc > div { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.09);
              border-radius:calc(var(--u) * 1.6); padding:calc(var(--u) * 2) calc(var(--u) * 3);
              min-width:calc(var(--u) * 20); }
  .fc .d { font-size:calc(var(--u) * 3); color:var(--text-mute); text-transform:capitalize; }
  .fc .t { font-size:calc(var(--u) * 4.4); font-weight:700; margin-top:calc(var(--u) * .6); font-variant-numeric:tabular-nums; }
  .fc .t span { color:var(--text-mute); font-weight:500; }
  .stale { font-size:calc(var(--u) * 2.4); color:var(--text-mute); opacity:.6; margin-top:calc(var(--u) * 2); }
</style></head><body class="w-shell">
${kit.shell({
    title: String(c.title || 'Previsão do tempo'),
    content: `<div class="w-stage">
    <div class="now">
      <div class="top w-rise" style="--d:60ms">
        <div class="icon w-glow" id="icon"></div>
        <div class="temp" id="temp">--<sup>&deg;C</sup></div>
      </div>
      <div class="city w-rise" style="--d:200ms" id="city">${escapeHtml(label)}</div>
      <div class="desc w-rise" style="--d:280ms" id="desc"><span class="w-loading">carregando&hellip;</span></div>
      <div class="meta w-rise" style="--d:360ms"><span id="hum"></span><span id="wind"></span></div>
    </div>
    ${showForecast ? '<div class="fc" id="fc"></div>' : ''}
    <div class="stale" id="stale"></div>
  </div>`,
  })}
<script>${kit.baseScript()}
  var ICONS = ${JSON.stringify(kit.ICONS)};
  var DOW = ['dom','seg','ter','qua','qui','sex','sáb'];
  function iconFor(code) {
    var n = parseInt(code, 10);
    if (n === 113) return 'sun';
    if (n === 116) return 'partly';
    if (n === 119 || n === 122) return 'cloud';
    if ([143,248,260].indexOf(n) >= 0) return 'mist';
    if ([200,386,389,392,395].indexOf(n) >= 0) return 'storm';
    if ([227,320,323,326,329,332,335,338,350,362,365,368,371,374,377].indexOf(n) >= 0) return 'snow';
    if (n >= 176) return 'rain';
    return 'cloud';
  }
  function render(d) {
    document.getElementById('icon').innerHTML = ICONS[iconFor(d.code)] || ICONS.cloud;
    var t = document.getElementById('temp');
    var next = d.temp + '<sup>°C</sup>';
    if (t.innerHTML !== next) {
      t.innerHTML = next;
      t.classList.remove('w-pop'); void t.offsetWidth; t.classList.add('w-pop');
    }
    wSet(document.getElementById('city'), d.city + ' — ' + d.uf, false);
    wSet(document.getElementById('desc'), d.description);
    wSet(document.getElementById('hum'), 'Umidade ' + d.humidity + '%', false);
    wSet(document.getElementById('wind'), 'Vento ' + d.wind_kph + ' km/h', false);
    var fc = document.getElementById('fc');
    if (fc && d.days) {
      fc.innerHTML = d.days.map(function (x, i) {
        var dt = new Date(x.date + 'T12:00:00');
        var name = i === 0 ? 'hoje' : DOW[dt.getDay()];
        return '<div class="w-flip"><div class="d">' + name + '</div><div class="t">' + x.max + '° <span>' + x.min + '°</span></div></div>';
      }).join('');
      wStagger('.fc div', 110);
    }
    // Say so when the reading is not fresh rather than implying it is live. The value is still
    // broadly true - weather moves slowly - so this is a caption, not an error.
    wSet(document.getElementById('stale'), d.stale ? 'atualizado há pouco' : '', false);
  }
  wPoll('data.json', render, 600000);
</script></body></html>`;
}

/*
 * Brasileirão Série A — the round's fixtures/scores, or the table.
 *
 * Data comes from THIS server (lib/football.js), which is what makes a live-score widget viable
 * at all: scores need a short refresh, and a fleet polling ESPN directly every few minutes would
 * be both rude and fragile. One request serves every panel, and the crests are mirrored here too
 * so a screen on a locked-down shop network still shows them.
 *
 * THE FIXTURES VIEW LEADS WITH ONE MATCH. A wall of eight equal rows is a table, not a poster:
 * nobody walking past reads it. The most interesting match — live first, then the next to kick
 * off, then the most recently finished — gets the crests and the full width, and the rest of the
 * round sits underneath in two columns. That is the shape the format has settled on and it is the
 * right one.
 */
function renderFootball(c) {
  const view = c.view === 'table' ? 'table' : 'matches';
  const accent = safeCss(c.accent, '#A3E635');
  return `<!DOCTYPE html><html lang="pt-BR"><head>${kit.baseHead({ background: safeCss(c.background, ''), accent })}
<style>${kit.backdrop('football')}
  .w-body { align-items:stretch; }
  .w-stage { align-self:stretch; display:flex; flex-direction:column; }
  /* A totem can spend a third of its height on the crests; a 16:9 panel has to share that height
     with the names and the rest of the round, so they come down. */
  :root { --crest:calc(var(--u) * 34); --crest-box:calc(var(--u) * 42); }
  @media (orientation: landscape) {
    :root { --crest:calc(var(--u) * 26); --crest-box:calc(var(--u) * 32); }
  }

  /* ── featured match ─────────────────────────────────────────────────────── */
  .feature { flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
             align-items:center; justify-content:center; }
  /* The two crests overlap across a diagonal, the way a fixture graphic is always drawn — it
     reads as "against" in a way two logos side by side never do. */
  .crests { position:relative; display:flex; align-items:center; justify-content:center;
            width:100%; height:var(--crest-box); }
  .crest { width:var(--crest); height:var(--crest); object-fit:contain;
           filter:drop-shadow(0 calc(var(--u) * .8) calc(var(--u) * 2) rgba(0,0,0,.65)); }
  /* They overlap across the divider — enough to read as one graphic, not so much that either
     crest is unrecognisable, which is the whole reason a crest is there. */
  .crest.home { transform:translate(12%, -8%); }
  .crest.away { transform:translate(-12%, 8%); }
  /* The divider sits BEHIND the crests and is sized off the box, so it stays a diagonal at any
     aspect ratio instead of turning into a near-horizontal line on a wide panel. */
  .slash { position:absolute; left:50%; top:-8%; height:116%; width:calc(var(--u) * .3);
           background:linear-gradient(180deg, transparent, rgba(255,255,255,.55), transparent);
           transform:translateX(-50%) rotate(22deg); }

  .pill { display:inline-block; margin-top:calc(var(--u) * 2.5);
          background:color-mix(in srgb, var(--accent) 30%, #0B1A05);
          border:calc(var(--u) * .2) solid color-mix(in srgb, var(--accent) 60%, transparent);
          border-radius:calc(var(--u) * 10); padding:calc(var(--u) * .9) calc(var(--u) * 3);
          font-size:calc(var(--u) * 2.8); font-weight:800; letter-spacing:.12em;
          text-transform:uppercase; color:var(--text); }
  .pill.live { background:#B4152A; border-color:#FF6B7A; animation:livePulse 2s ease-in-out infinite; }
  @keyframes livePulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }

  .sides { width:100%; margin-top:calc(var(--u) * 3); }
  .side { display:flex; align-items:center; gap:calc(var(--u) * 3); }
  .side + .side { margin-top:calc(var(--u) * 1.2); }
  .side .sc { min-width:calc(var(--u) * 6); text-align:center; font-weight:800;
              font-size:calc(var(--u) * 7); color:var(--accent); font-variant-numeric:tabular-nums; }
  .side .nm { font-size:calc(var(--u) * 8); font-weight:300; letter-spacing:.02em;
              text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  @media (orientation: landscape) {
    .side .nm { font-size:calc(var(--u) * 6.5); }
    .side .sc { font-size:calc(var(--u) * 6); }
  }

  .rule { height:calc(var(--u) * .3); background:var(--accent); opacity:.85;
          margin:calc(var(--u) * 3) 0; flex:0 0 auto; }

  /* ── the rest of the round ──────────────────────────────────────────────── */
  .rest { flex:0 0 auto; display:grid; grid-template-columns:1fr 1fr;
          gap:calc(var(--u) * 1.2) calc(var(--u) * 6); }
  @media (orientation: portrait) { .rest { grid-template-columns:1fr; } }
  /*
   * The rest of the round reads as "A 3 x 0 B" on ONE line, the way a scoreboard is written and
   * spoken. Two stacked rows per match is how a results table is printed, not how anyone says it
   * — and it also doubled the height of this block, which is what ran the fixtures view 218px off
   * the bottom of a 16:9 panel.
   *
   * Three columns rather than a sentence, so the scores line up vertically down the list instead
   * of drifting with the length of each club's name.
   */
  .match { display:grid; grid-template-columns:1fr auto 1fr; align-items:baseline;
           gap:0 calc(var(--u) * 1.8); font-size:calc(var(--u) * 4);
           text-transform:uppercase; letter-spacing:.02em; }
  .match .hm { text-align:right; }
  .match .aw { text-align:left; }
  .match .hm, .match .aw { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .match .vs { white-space:nowrap; font-weight:800; color:var(--accent);
               font-variant-numeric:tabular-nums; }
  .match .vs em { font-style:normal; font-weight:600; color:var(--text-dim);
                  padding:0 calc(var(--u) * .8); }

  /* ── table view ─────────────────────────────────────────────────────────── */
  /* Twenty clubs plus a header do not fit the height of a 16:9 panel at a size anyone can read
     from across a room, so a landscape screen splits them into two columns and spends its width
     instead. A totem has the height and keeps one list. */
  #root.two { display:grid; grid-template-columns:1fr 1fr; gap:0 calc(var(--u) * 6); }
  /* Two eight-column tables need about 1.6 screens-worth of width per height. On a 4:3 or 3:2
     panel they do not have it and the last columns ran off the right edge. Wins, draws and losses
     are the ones a passer-by never reads — points, played and goal difference carry the table. */
  @media (orientation: landscape) and (max-aspect-ratio: 8/5) {
    .tbl th:nth-child(n+5):nth-child(-n+7),
    .tbl td:nth-child(n+5):nth-child(-n+7) { display:none; }
  }
  .tbl { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  .tbl th { font-size:calc(var(--u) * 2.4); font-weight:700; letter-spacing:.12em;
            text-transform:uppercase; color:var(--text-dim); text-align:right;
            padding-bottom:calc(var(--u) * 1.5); }
  .tbl th.t, .tbl td.t { text-align:left; }
  .tbl td { font-size:calc(var(--u) * 3.2); padding:calc(var(--u) * .75) calc(var(--u) * 1.2);
            text-align:right; border-top:1px solid rgba(255,255,255,.07); }
  .tbl td.t { display:flex; align-items:center; gap:calc(var(--u) * 1.6); }
  .tbl td.t img { width:calc(var(--u) * 4); height:calc(var(--u) * 4); object-fit:contain; }
  .tbl td.pos { color:var(--text-dim); width:calc(var(--u) * 5); }
  .tbl td.pts { color:var(--accent); font-weight:800; }
  /* Top four go to the Libertadores, bottom four go down. Colouring the edges is the only reason
     anyone reads a league table from across a room. */
  .tbl tr.up td.pos { color:#4ADE80; font-weight:800; }
  .tbl tr.down td.pos { color:#F87171; font-weight:800; }

  .stale { text-align:center; font-size:calc(var(--u) * 2.2); color:var(--text-mute);
           opacity:.55; margin-top:calc(var(--u) * 1.5); }
</style></head><body class="w-shell">
${kit.shell({
    title: String(c.title || 'Campeonato Brasileiro'),
    content: `<div class="w-stage">
    <div id="root"><div class="w-loading">carregando&hellip;</div></div>
    <div class="stale" id="stale"></div>
  </div>`,
  })}
<script>${kit.baseScript()}
  var VIEW = ${JSON.stringify(view)};
  var CRESTS = ${c.crests === false ? 'false' : 'true'};

  var TIME = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;    // textContent: every value here is third-party
    return n;
  }

  /* "Hoje - 18:30", "Amanhã - 20:00", or the date for anything further out. */
  function whenLabel(m) {
    if (m.live) return m.clock ? 'Ao vivo · ' + m.clock : 'Ao vivo';
    if (!m.date) return m.status || '';
    var d = new Date(m.date);
    if (isNaN(d)) return m.status || '';
    var today = new Date();
    var dayDiff = Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
       new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    var when = dayDiff === 0 ? 'Hoje' : dayDiff === 1 ? 'Amanhã' : dayDiff === -1 ? 'Ontem'
      : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return when + ' - ' + TIME.format(d);
  }

  function sideRow(s, cls) {
    var row = el('div', 'side');
    row.appendChild(el('div', 'sc', s.score == null || s.score === '' ? '-' : s.score));
    row.appendChild(el('div', 'nm', s.name));
    if (cls) row.classList.add(cls);
    return row;
  }

  /* "Chapecoense 3 x 0 Vasco" — or "Chapecoense x Vasco" before it kicks off. */
  function inlineMatch(m) {
    var row = el('div', 'match');
    row.appendChild(el('div', 'hm', m.home.name));

    var vs = el('div', 'vs');
    var played = m.home.score != null && m.home.score !== '';
    if (played) vs.appendChild(document.createTextNode(m.home.score));
    var x = el('em', null, 'x');
    vs.appendChild(x);
    if (played) vs.appendChild(document.createTextNode(m.away.score));
    row.appendChild(vs);

    row.appendChild(el('div', 'aw', m.away.name));
    return row;
  }

  function crestImg(id, cls, onFail) {
    var img = document.createElement('img');
    img.className = 'crest ' + cls;
    // Served by THIS server, which mirrors ESPN once for the whole fleet. The id is a number the
    // server re-validates; nothing here can point the tag at another host.
    var url = '../crest/' + encodeURIComponent(id) + '.png';
    img.src = url;
    img.alt = '';
    /*
     * A crest this server has not mirrored yet is fetched from ESPN on the first request, so the
     * first load after a fresh deployment can time out — and a hidden crest stays hidden until the
     * next poll rebuilds the card. Retry twice before giving up; a missing crest must never leave
     * a broken-image glyph on a shop wall.
     */
    var tries = 0;
    img.addEventListener('error', function () {
      if (++tries <= 2) { setTimeout(function () { img.src = url + '?r=' + tries; }, 2000 * tries); return; }
      img.style.visibility = 'hidden';
      if (onFail) onFail();
    });
    return img;
  }

  /*
   * Which match leads. Live beats everything; otherwise the next one to kick off; otherwise the
   * one that finished most recently. A widget that leads with a match from three days ago when
   * one is being played right now is worse than useless.
   */
  function pickFeature(matches) {
    var live = matches.filter(function (m) { return m.live; });
    if (live.length) return live[0];
    var now = Date.now();
    var upcoming = matches.filter(function (m) { return new Date(m.date) >= now; })
      .sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
    if (upcoming.length) return upcoming[0];
    return matches.slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); })[0];
  }

  function renderMatches(d) {
    var root = document.getElementById('root');
    var matches = (d && d.matches) || [];
    if (!matches.length) return;
    last = d;

    root.textContent = '';
    root.className = '';
    var feature = pickFeature(matches);

    var wrap = el('div', 'feature w-rise');
    wrap.style.setProperty('--d', '60ms');

    if (CRESTS && (feature.home.crest || feature.away.crest)) {
      var box = el('div', 'crests');
      box.appendChild(el('div', 'slash'));
      var wanted = 0, failed = 0;
      function onCrestFail() {
        // The divider is there to separate two badges. With neither of them painted it is just a
        // stray diagonal across an empty third of the screen, which reads as a rendering fault —
        // collapse the whole block and let the names carry the match.
        if (++failed >= wanted) box.remove();
      }
      if (feature.home.crest) { wanted++; box.appendChild(crestImg(feature.home.crest, 'home', onCrestFail)); }
      if (feature.away.crest) { wanted++; box.appendChild(crestImg(feature.away.crest, 'away', onCrestFail)); }
      wrap.appendChild(box);
    }

    var pill = el('div', 'pill', whenLabel(feature));
    if (feature.live) pill.classList.add('live');
    wrap.appendChild(pill);

    var sides = el('div', 'sides');
    sides.appendChild(sideRow(feature.home));
    sides.appendChild(sideRow(feature.away));
    wrap.appendChild(sides);
    root.appendChild(wrap);

    /*
     * Capped. A full round is ten fixtures, and nine of them under the featured match is more rows
     * than the space below the divider holds — the list simply ran off the bottom of the screen.
     * Six is three rows in landscape's two columns and still fits a totem's single column.
     */
    var others = matches.filter(function (m) { return m !== feature; }).slice(0, 6);
    if (others.length) {
      root.appendChild(el('div', 'rule'));
      var rest = el('div', 'rest w-rise');
      rest.style.setProperty('--d', '220ms');
      others.forEach(function (m) { rest.appendChild(inlineMatch(m)); });
      root.appendChild(rest);
    }

    wSet(document.getElementById('wFoot'), d.round_label || '', false);
    wSet(document.getElementById('stale'), d.stale ? 'placar em cache' : '', false);
  }

  function buildTable(rows, total, delayMs) {
    var t = el('table', 'tbl w-rise');
    t.style.setProperty('--d', delayMs + 'ms');
    var head = t.insertRow();
    [['', 'pos'], ['Clube', 't'], ['P', ''], ['J', ''], ['V', ''], ['E', ''], ['D', ''], ['SG', '']]
      .forEach(function (h) {
        var th = document.createElement('th');
        th.className = h[1];
        th.textContent = h[0];
        head.appendChild(th);
      });

    rows.forEach(function (r) {
      var tr = t.insertRow();
      // Libertadores places and the relegation zone, against the FULL table rather than the
      // column this row happens to be drawn in.
      if (r.rank <= 4) tr.className = 'up';
      else if (r.rank > total - 4) tr.className = 'down';
      var pos = tr.insertCell(); pos.className = 'pos'; pos.textContent = r.rank;
      var team = tr.insertCell(); team.className = 't';
      if (CRESTS && r.crest) {
        var img = document.createElement('img');
        img.src = '../crest/' + encodeURIComponent(r.crest) + '.png';
        img.alt = '';
        img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
        team.appendChild(img);
      }
      team.appendChild(document.createTextNode(r.team));
      [['pts', r.points], ['', r.played], ['', r.won], ['', r.draw], ['', r.lost], ['', r.gd]]
        .forEach(function (pair) {
          var td = tr.insertCell();
          td.className = pair[0];
          td.textContent = pair[1];
        });
    });
    return t;
  }

  function renderTable(d) {
    var rows = (d && d.rows) || [];
    if (!rows.length) return;
    last = d;
    var root = document.getElementById('root');
    root.textContent = '';

    var wide = isLandscape();
    root.className = wide ? 'two' : '';
    if (wide) {
      var half = Math.ceil(rows.length / 2);
      root.appendChild(buildTable(rows.slice(0, half), rows.length, 60));
      root.appendChild(buildTable(rows.slice(half), rows.length, 160));
    } else {
      root.appendChild(buildTable(rows, rows.length, 60));
    }

    wSet(document.getElementById('wFoot'), d.round ? d.round + 'ª rodada' : 'Série A', false);
    wSet(document.getElementById('stale'), d.stale ? 'tabela em cache' : '', false);
  }

  var last = null;
  function isLandscape() { return window.matchMedia('(orientation: landscape)').matches; }
  var draw = VIEW === 'table' ? renderTable : renderMatches;

  // A panel can be rotated after it is mounted, and the table's column count depends on which way
  // up it is. Re-draw from the payload already in hand rather than refetching.
  function relayout() { if (last) draw(last); }
  window.addEventListener('resize', relayout);
  window.matchMedia('(orientation: landscape)').addEventListener('change', relayout);

  wPoll('data.json', draw, VIEW === 'table' ? 1800000 : 120000);
</script></body></html>`;
}

/*
 * News — one headline at a time, as a full-bleed card.
 *
 * WHY NOT A TICKER. The old rendering was a single line of crawling text, and a crawl is the worst
 * possible shape for signage: it is unreadable if you arrive halfway through, it never stops
 * moving, and a passer-by has to stand still and wait for the sentence to arrive. One headline
 * held for a few seconds over its own photograph is read at a glance from across a room.
 *
 * The ticker is still available as mode: 'ticker' — some customers have it running on strips at
 * the bottom of a screen where a card makes no sense, and taking it away would break their walls.
 *
 * Data and images both come from THIS server (lib/news.js). Images are requested BY ITEM INDEX;
 * see the /newsimg route for why that is the whole security story.
 */
function renderRSS(c) {
  if (c.mode === 'ticker') return renderRSSTicker(c);

  const accent = safeCss(c.accent, '#B4152A');
  const holdMs = Math.max(4000, safeNumber(c.item_seconds, 9) * 1000);
  return `<!DOCTYPE html><html lang="pt-BR"><head>${kit.baseHead({ background: safeCss(c.background, ''), accent })}
<style>${kit.backdrop('news')}
  .w-body { padding:0; align-items:stretch; }
  .w-stage { max-width:none; align-self:stretch; position:relative; text-align:left; }

  /* The photograph is the widget. It fills everything and the words sit on top of it, rather than
     the picture being an illustration beside a paragraph. */
  .shot { position:absolute; inset:0; overflow:hidden; }
  .shot img { width:100%; height:100%; object-fit:cover; }
  /*
   * The photograph pushes in for exactly as long as the headline is held.
   *
   * The first version moved 8% over 12.6s while the card only lived 9s, and eased out on top of
   * that — under 1% a second, decelerating, and cut off before it finished. Nobody read it as
   * movement. This is 16% over the full hold, LINEAR, so the rate is constant and the picture is
   * still travelling at the moment it hands over.
   */
  @keyframes drift {
    from { transform:scale(1) translate(0, 0); }
    to   { transform:scale(1.16) translate(-2.5%, -1.8%); }
  }
  .shot img { animation:drift ${holdMs}ms linear both; }

  /* The band has to be opaque enough to read white text over any photograph that lands in it. */
  .band { position:absolute; left:0; right:0; bottom:0; padding:calc(var(--u) * 5);
          background:linear-gradient(180deg, transparent, rgba(0,0,0,.82) 22%, rgba(0,0,0,.94)); }
  .tag { display:inline-flex; align-items:center; gap:calc(var(--u) * 1.6);
         margin-bottom:calc(var(--u) * 2.4); }
  .tag i { display:block; width:calc(var(--u) * .6); height:calc(var(--u) * 4);
           background:var(--text); transform:skewX(-16deg); }
  .tag span { background:var(--accent); color:var(--text);
              padding:calc(var(--u) * .8) calc(var(--u) * 2.4);
              font-size:calc(var(--u) * 2.8); font-weight:800; letter-spacing:.14em;
              text-transform:uppercase; transform:skewX(-16deg); }
  .tag span b { display:block; transform:skewX(16deg); font-weight:800; }
  .t { font-size:calc(var(--u) * 6.2); font-weight:600; line-height:1.18; font-style:italic;
           /* Four lines is the most anyone reads walking past; a longer headline is clipped
              rather than allowed to push the band over the photograph. */
           display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
  @media (orientation: landscape) { .t { font-size:calc(var(--u) * 7); -webkit-line-clamp:3; } }

  /* Progress through the current item, so a screen never looks stuck. */
  .bar { position:absolute; left:0; bottom:0; height:calc(var(--u) * .55); background:var(--accent); }
  @keyframes advance { from { width:0; } to { width:100%; } }

  /*
   * ONE HEADLINE ON SCREEN AT A TIME.
   *
   * These cards are absolutely positioned siblings, so a cross-fade puts both at partial opacity
   * together and renders two headlines on top of each other — for 620ms the screen showed two
   * stories and neither could be read. The change is sequenced instead: the outgoing card fades
   * out, and only when it is gone does the next one fade in. Slightly slower, and never ambiguous.
   */
  .card { position:absolute; inset:0; opacity:0; transition:opacity 320ms ease; }
  .card.on { opacity:1; }

  /*
   * Without a photograph the band keeps its place and its size, and the backdrop shows through.
   * The earlier version moved the text to the middle of the screen and grew it, which meant the
   * headline JUMPED between two positions depending on whether that item happened to carry a
   * picture — on a rotating widget that reads as a layout that cannot make up its mind.
   */
  .card.noshot .band { background:linear-gradient(180deg, transparent, rgba(0,0,0,.55) 40%); }

  /* Above the photograph: the cards are appended after it, so without this the source name is
     painted over by the next headline that has an image. */
  .src { position:absolute; z-index:3; top:calc(var(--u) * 3); right:calc(var(--u) * 4);
         font-size:calc(var(--u) * 2.6); font-weight:700; letter-spacing:.1em;
         text-transform:uppercase; color:var(--text); opacity:.75;
         text-shadow:0 calc(var(--u) * .2) calc(var(--u) * 1) rgba(0,0,0,.9); }
</style></head><body class="w-shell">
${kit.shell({
    title: String(c.title || 'Notícia'),
    content: `<div class="w-stage">
    <div class="src" id="src"></div>
    <div id="deck"><div class="w-loading" style="padding:calc(var(--u) * 5)">carregando&hellip;</div></div>
  </div>`,
  })}
<script>${kit.baseScript()}
  var HOLD_MS = ${holdMs};
  var items = [], at = 0, timer = null, showing = null;

  function buildCard(item, index) {
    var card = document.createElement('div');
    card.className = 'card';

    if (item.image != null) {
      var shot = document.createElement('div');
      shot.className = 'shot';
      var img = document.createElement('img');
      // Served by THIS server from its own cache of THIS widget's feed, addressed by index.
      img.src = 'newsimg/' + encodeURIComponent(item.image);
      img.alt = '';
      /*
       * A photograph that fails is RETRIED, not written off. The first request for an image the
       * server has not mirrored yet goes out to the news site and is resized before it comes back,
       * so right after a deploy the very first card can time out — and the old code latched that
       * into the no-photo layout until the headlines changed, which on a quiet news day is hours.
       * One retry a few seconds later costs nothing and covers exactly that window.
       */
      var tries = 0;
      img.addEventListener('error', function () {
        if (++tries <= 2) {
          setTimeout(function () { img.src = 'newsimg/' + encodeURIComponent(item.image) + '?r=' + tries; }, 2500 * tries);
          return;
        }
        card.classList.add('noshot');
        shot.remove();
      });
      shot.appendChild(img);
      card.appendChild(shot);
    } else {
      card.classList.add('noshot');
    }

    var band = document.createElement('div');
    band.className = 'band';

    /*
     * The category is only worth the space when it says something the source name does not.
     * Feeds routinely put their own identity there: G1 sends "G1" and globoesporte sends
     * "globoesporte.com", and a red INTERNACIONAL flash that actually reads GLOBOESPORTE.COM is
     * a label that costs a line and tells the reader nothing.
     */
    var cat = (item.category || '').trim();
    var src = (document.getElementById('src').textContent || '').toLowerCase();
    // Escapes are DOUBLED: this whole script is inside a template literal, where \\s is not an
    // escape sequence and collapses to a bare s — /^[^\\s]+/ would silently become /^[^s]+/ and
    // stop matching any domain containing the letter s.
    var looksLikeDomain = /^[^\\s]+\\.[a-z]{2,}$/i.test(cat);
    var isSource = cat.toLowerCase() === src || (src && cat.toLowerCase().indexOf(src) === 0);
    if (cat && !looksLikeDomain && !isSource) {
      var tag = document.createElement('div');
      tag.className = 'tag';
      tag.appendChild(document.createElement('i'));
      var box = document.createElement('span');
      var b = document.createElement('b');
      b.textContent = cat;            // textContent: the feed's own words, not ours
      box.appendChild(b);
      tag.appendChild(box);
      band.appendChild(tag);
    }

    var t = document.createElement('div');
    t.className = 't';
    t.textContent = item.title;
    band.appendChild(t);
    card.appendChild(band);

    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.animation = 'advance ' + HOLD_MS + 'ms linear both';
    card.appendChild(bar);
    return card;
  }

  var FADE_MS = 320;

  /*
   * Sequenced hand-over: fade the current headline out, remove it, THEN bring the next one in.
   * Overlapping the two is what put two stories on the screen at once with neither readable.
   *
   * The photograph is built during the fade-out, so its first bytes are already in flight by the
   * time it is shown — the swap still feels immediate without the two ever coexisting.
   */
  function show(i) {
    if (!items.length) return;
    at = ((i % items.length) + items.length) % items.length;
    var deck = document.getElementById('deck');
    var card = buildCard(items[at], at);
    var previous = showing;
    showing = card;

    function bringIn() {
      if (showing !== card) return;          // a newer hand-over started; drop this one
      deck.textContent = '';                 // nothing else may be on screen
      deck.appendChild(card);
      // One frame before adding .on, or the transition has nothing to animate from.
      requestAnimationFrame(function () { card.classList.add('on'); });
      clearTimeout(timer);
      timer = setTimeout(function () { show(at + 1); }, HOLD_MS);
    }

    if (previous) {
      previous.classList.remove('on');
      setTimeout(bringIn, FADE_MS);
    } else {
      bringIn();
    }
  }

  function render(d) {
    var next = (d && d.items) || [];
    if (!next.length) return;
    wSet(document.getElementById('src'), d.source || '', false);

    // Only restart the rotation when the HEADLINES change. A refresh that returns the same items
    // must not throw away the item currently being read.
    var key = next.map(function (i) { return i.title; }).join('|');
    if (key === render.lastKey) return;
    render.lastKey = key;

    items = next;
    document.getElementById('deck').textContent = '';
    showing = null;

    /*
     * Start where the rotation WOULD be, not at the top.
     *
     * A news widget in a playlist is on screen for its slot and then the playlist moves on; next
     * time round the page is loaded fresh. Starting at item 0 every time meant the same two or
     * three headlines played forever while the other nine were never seen, however often the feed
     * refreshed. Deriving the offset from the clock makes the rotation continue across reloads,
     * and keeps two screens showing the same feed roughly in step rather than deliberately apart.
     */
    show(Math.floor(Date.now() / HOLD_MS) % items.length);
  }

  wPoll('data.json', render, 300000);
</script></body></html>`;
}

/*
 * The original crawling ticker, kept for widgets already configured with it.
 *
 * scroll_speed is authored in the UI as "seconds" (legacy field), but that used to be wired
 * straight into animation-duration: a *fixed total time* for the whole strip to cross the
 * screen. That makes the on-screen speed depend on how much content there is - a feed with
 * many items gets dragged through in the same {scroll_speed}s as a feed with one, so it
 * flies past far too fast, never lets the reader finish, and simply "jumps back to the
 * start" once the fixed duration is up. Instead we treat scroll_speed as calibrating a
 * constant px/sec rate (using one viewport-width per scroll_speed seconds as the reference,
 * matching prior behaviour for content that fits in one screen), then measure the actual
 * rendered width of the ticker and derive a duration long enough to move that full distance
 * at the same constant speed - so more items simply take proportionally longer, and every
 * item scrolls fully into and out of view before the loop restarts.
 *
 * It now reads THIS server's cache like every other widget, rather than calling rss2json from
 * the player.
 */
function renderRSSTicker(c) {
  const scrollSpeedSec = safeNumber(c.scroll_speed, 30);
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, '#000')}; height:100vh; overflow:hidden; font-family:-apple-system,sans-serif; }
  .ticker { display:flex; align-items:center; height:100%; white-space:nowrap; position:relative; will-change:transform; }
  .item { display:inline-block; padding:0 40px; font-size:${safeNumber(c.font_size, 24)}px; color:${safeCss(c.color, '#FFF')}; }
  .item .title { font-weight:600; }
  .item .sep { margin:0 20px; opacity:0.3; }
</style></head><body>
<div class="ticker" id="ticker"><div class="item">Carregando…</div></div>
<script>
var SCROLL_SPEED_SEC = ${scrollSpeedSec};
var ticker = document.getElementById('ticker');
var anim = null;
function restartAnimation() {
  if (anim) { anim.cancel(); anim = null; }
  var viewportW = window.innerWidth;
  var tickerW = ticker.scrollWidth;
  // Reference speed: one viewport-width travelled every SCROLL_SPEED_SEC seconds, so the
  // default of 30s behaves the same as before for a feed that fits within one screen.
  var pxPerSec = viewportW / SCROLL_SPEED_SEC;
  var distance = viewportW + tickerW; // starts fully off-screen right, ends fully off-screen left
  var durationMs = Math.max(1000, (distance / pxPerSec) * 1000);
  anim = ticker.animate(
    [
      { transform: 'translateX(' + viewportW + 'px)' },
      { transform: 'translateX(-' + tickerW + 'px)' },
    ],
    { duration: durationMs, iterations: Infinity, easing: 'linear' }
  );
}
function paint(items) {
  ticker.textContent = '';
  if (!items.length) { ticker.appendChild(row('Sem itens', 'item')); return; }
  items.forEach(function (i, n) {
    if (n) ticker.appendChild(row('•', 'item sep'));
    var d = document.createElement('div');
    d.className = 'item';
    var s = document.createElement('span');
    s.className = 'title';
    s.textContent = i.title;      // feed titles are external content
    d.appendChild(s);
    ticker.appendChild(d);
  });
}
function row(text, cls) {
  var d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
function load() {
  fetch('data.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.items || !d.items.length) return;
      paint(d.items.slice(0, ${safeNumber(c.max_items, 10)}));
      requestAnimationFrame(restartAnimation);
    })
    .catch(function () { /* keep whatever is on screen */ });
}
window.addEventListener('resize', restartAnimation);
load(); setInterval(load, 300000);
</script></body></html>`;
}

function renderText(c, iframeSandbox = 'allow-scripts') {
  let html = c.html || '<p style="color:white;padding:20px">Empty text widget</p>';

  // LEGACY DESIGNER RESCUE — deliberately narrow.
  //
  // The Content Designer used to publish absolute font sizes as fontSize*10.8 px; today it emits
  // cqw (see designer.js). Converting px/108 back to vw restores the author's intended size and
  // makes those old widgets scale to any screen.
  //
  // It must NOT touch hand-authored HTML. This regex used to run over EVERY text widget, so
  // someone writing `font-size:16px` in the Text/HTML editor got 0.15vw — 2.8px on a 1080p
  // screen, and smaller still on anything narrower. Their text was not clipped or hidden; it was
  // rendered too small to read, in the one widget whose whole purpose is hand-written HTML.
  //
  // Designer output is identified by its absolutely-positioned elements, the same signal the
  // dashboard uses to decide whether a text widget can be reopened in the designer. Hand-written
  // markup keeps its px exactly as typed.
  const isDesignerAuthored = /position:\s*absolute;\s*left:/.test(html);
  if (isDesignerAuthored) {
    html = html.replace(/font-size:\s*([\d.]+)px/g, (match, px) => {
      return `font-size:${(parseFloat(px) / 108).toFixed(2)}vw`;
    });
  }

  // What to do when the text is taller than the screen. It used to be clipped in silence: the
  // document was overflow:hidden with no scrollbar and nothing to scroll it, so on a display
  // shorter than the content the bottom simply vanished — reported as "text goes to bottom and
  // disappears. It dont fit."
  //
  //   fit    (default) shrink until it fits. A no-op when the content already fits, so this
  //          rescues widgets that are currently losing text without altering ones that are fine.
  //   scroll pan through it on a loop, with a pause at each end. For content that is genuinely
  //          longer than a screen, where shrinking it would make it unreadable.
  //   clip   the old behaviour, kept because a designer-positioned layout may deliberately run
  //          past the edge and must not be rescaled underneath the author.
  const overflowMode = ['fit', 'scroll', 'clip'].includes(c.overflow) ? c.overflow : 'fit';

  // Runs inside the sandboxed iframe (allow-scripts, null origin). Measures after layout, after
  // web fonts settle, and on resize — a rotation or a resized zone changes the answer, and fonts
  // loading late is the classic cause of a fit that was computed against the wrong height.
  const fitScript = overflowMode === 'clip' ? '' : `<script>
  (function () {
    var mode = ${JSON.stringify(overflowMode)};
    var wrap = document.getElementById('st-wrap');
    if (!wrap) return;
    var anim = null;
    function apply() {
      // Reset before measuring, or we measure the previous transform's result.
      wrap.style.transform = '';
      if (anim) { anim.cancel(); anim = null; }
      var avail = document.documentElement.clientHeight;
      var need = wrap.scrollHeight;
      if (!avail || !need || need <= avail + 1) return;   // already fits: leave it alone
      if (mode === 'fit') {
        var k = avail / need;
        wrap.style.transformOrigin = 'top center';
        wrap.style.transform = 'scale(' + k + ')';
        return;
      }
      // scroll: hold, pan the overflow, hold, return. Speed is distance-based so a long
      // document is not unreadably fast and a short one is not tediously slow.
      var over = need - avail;
      var panMs = Math.max(4000, (over / 40) * 1000);
      var holdMs = 2000;
      var total = panMs * 2 + holdMs * 2;
      var p1 = holdMs / total, p2 = (holdMs + panMs) / total, p3 = (holdMs * 2 + panMs) / total;
      anim = wrap.animate(
        [
          { transform: 'translateY(0)', offset: 0 },
          { transform: 'translateY(0)', offset: p1 },
          { transform: 'translateY(' + (-over) + 'px)', offset: p2 },
          { transform: 'translateY(' + (-over) + 'px)', offset: p3 },
          { transform: 'translateY(0)', offset: 1 },
        ],
        { duration: total, iterations: Infinity, easing: 'linear' }
      );
    }
    addEventListener('resize', apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(function(){});
    // Late images change the height too; rAF lets first layout finish before measuring.
    addEventListener('load', function () { requestAnimationFrame(apply); });
    requestAnimationFrame(apply);
  })();
  </script>`;

  // Security: c.html / c.css are intentionally raw user-authored content, but the
  // render is public and same-origin with the dashboard - injected <script> could
  // otherwise read the dashboard's localStorage JWT. Render the user content inside
  // a sandboxed iframe with NO allow-same-origin: scripts still run (so legit
  // widget markup works) but in a null origin that can't touch the app's storage.
  const inner = `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100vw; height:100vh; overflow:hidden; }
  /* The wrapper is what gets scaled or panned. It must be allowed to exceed the viewport,
     otherwise there is nothing to measure and nothing to move. */
  #st-wrap { width:100%; min-height:100%; will-change:transform; }
  ${c.css || ''}
</style></head><body><div id="st-wrap">${html}</div>${fitScript}</body></html>`;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100vw; height:100vh; overflow:hidden; background:${safeCss(c.background, 'transparent')}; }
  iframe { width:100%; height:100%; border:0; display:block; }
</style></head><body><iframe sandbox="${escapeHtml(iframeSandbox)}" srcdoc="${escapeHtml(inner)}"></iframe></body></html>`;
}

function renderWebpage(c, iframeSandbox = 'allow-scripts') {
  const zoom = (c.zoom || 100) / 100;
  const invZoom = 100 / (c.zoom || 100) * 100;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; } body { height:100vh; overflow:hidden; }
  iframe { width:${invZoom}%; height:${invZoom}%; border:0; transform:scale(${zoom}); transform-origin:0 0; }
</style></head><body>
<iframe src="${escapeHtml(safeUrl(c.url))}" sandbox="${escapeHtml(iframeSandbox)}"></iframe>
${c.refresh_interval > 0 ? `<script>setInterval(()=>document.querySelector('iframe').src=document.querySelector('iframe').src,${c.refresh_interval * 1000});</script>` : ''}
</body></html>`;
}

function renderSocial(c) {
  return `<!DOCTYPE html><html><head><style>
  body { background:${safeCss(c.background, '#000')}; color:${safeCss(c.color, '#FFF')}; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
</style></head><body>
<div style="text-align:center">
  <p style="font-size:24px">Social Feed</p>
  <p style="opacity:0.5;margin-top:8px">${escapeHtml(c.platform) || 'twitter'}: ${escapeHtml(c.query) || ''}</p>
  <p style="opacity:0.3;margin-top:16px;font-size:13px">Configure API key in widget settings</p>
</div></body></html>`;
}

// Directory Board — lobby tenant directory with scrolling content, header/footer,
// rotating background images, and anti-burn-in motion (pixel shift, bg pulse).
// All user-supplied strings are rendered via textContent in-browser, not inlined
// into HTML, so no server-side HTML escaping is needed for entries/categories.
function renderDirectoryBoard(c) {
  const configJson = JSON.stringify(c || {}).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Directory</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; overflow:hidden; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:#fff;
    background:#1a1a2e;
    animation: bg-pulse 60s ease-in-out infinite;
  }
  body.light { color:#1a1a2e; background:#f5f5f5; animation: bg-pulse-light 60s ease-in-out infinite; }
  @keyframes bg-pulse { 0%,100% { background:#1a1a2e; } 50% { background:#1b1b30; } }
  @keyframes bg-pulse-light { 0%,100% { background:#f5f5f5; } 50% { background:#ededf0; } }

  .page { position:fixed; inset:0; overflow:hidden; transition: transform 1.5s ease; will-change: transform; }

  .bg-layer { position:absolute; inset:0; z-index:0; }
  .bg-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; transition: opacity 2s ease-in-out; }
  .bg-img.active { opacity:0.30; }

  .header {
    position:absolute; top:0; left:0; right:0; z-index:2;
    padding:32px 48px 24px; text-align:center;
    background: linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0));
  }
  body.light .header { background: linear-gradient(to bottom, rgba(255,255,255,0.75), rgba(255,255,255,0)); }
  .header img.logo { max-height:160px; max-width:440px; object-fit:contain; margin-bottom:16px; }
  .header h1 { font-size:72px; font-weight:600; letter-spacing:0.02em; }

  .footer {
    position:absolute; bottom:0; left:0; right:0; z-index:2;
    padding:22px 48px; text-align:center;
    background: linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0));
    font-size:28px; color:#fff; line-height:1.3;
  }
  body.light .footer { color:#1a1a2e; background: linear-gradient(to top, rgba(255,255,255,0.85), rgba(255,255,255,0)); }

  .scroller {
    position:absolute; left:0; right:0; z-index:1;
    overflow:hidden;
    mask-image: linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
  }
  .track { position:absolute; top:0; left:0; right:0; }

  .category { padding:36px 0 16px; }
  .category h2 {
    text-align:center;
    font-size:52px;
    font-weight:500;
    letter-spacing:0.08em;
    text-transform:uppercase;
    opacity:0.9;
    padding-bottom:14px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
    margin-bottom:22px;
  }
  body.light .category h2 { border-bottom-color: rgba(0,0,0,0.12); }

  .entries { display:grid; gap:14px 36px; }
  .entries[data-cols="auto"] { grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); }
  .entries[data-cols="1"] { grid-template-columns: 1fr; }
  .entries[data-cols="2"] { grid-template-columns: repeat(2, 1fr); }
  .entries[data-cols="3"] { grid-template-columns: repeat(3, 1fr); }
  .entries[data-cols="4"] { grid-template-columns: repeat(4, 1fr); }

  .entry { font-size:38px; line-height:1.35; color:#fff; display:flex; gap:14px; align-items:baseline; }
  .entry .id { font-weight:600; min-width:3.5em; flex-shrink:0; }
  .entry .text { display:flex; flex-direction:column; flex:1; min-width:0; }
  .entry .nm { font-weight:400; }
  .entry .sub { font-size:0.55em; opacity:0.65; margin-top:4px; line-height:1.3; font-weight:400; }
  .entry.available { color:#00ff00; }
  .entry.available .id { color:#00ff00; }
  body.light .entry { color:#1a1a2e; }
  body.light .entry.available, body.light .entry.available .id { color:#059669; }

  @media (max-width: 1280px) {
    .header h1 { font-size:54px; }
    .header img.logo { max-height:120px; }
    .category h2 { font-size:40px; }
    .entry { font-size:28px; }
    .footer { font-size:22px; padding:16px 32px; }
    .entries[data-cols="auto"] { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  }
</style>
</head>
<body>
  <div class="page" id="page">
    <div class="bg-layer" id="bgLayer"></div>
    <header class="header" id="header"></header>
    <div class="scroller" id="scroller">
    </div>
    <footer class="footer" id="footer"></footer>
  </div>

<script>
(function(){
  var cfg = ${configJson};
  var SPEEDS = { slow: 20, medium: 45, fast: 75 };

  if (cfg.theme === 'light') document.body.classList.add('light');
  var GAP_PX = 120; // blank space between the end of the directory and where it repeats (loop seam)
  var MIN_SCROLL_PX_SEC = 5; // anti-burn-in minimum when content fits
  var REFRESH_MS = 60000;    // poll data.json this often; re-render ONLY when entries changed

  // ----- header -----
  var header = document.getElementById('header');
  function safeImgUrl(u) {
    return typeof u === 'string' && (u.indexOf('/') === 0 || /^https?:\\/\\//.test(u) || /^data:image\\//.test(u)) ? u : '';
  }
  var logoSrc = safeImgUrl(cfg.logo_url);
  if (logoSrc) {
    var img = document.createElement('img');
    img.className = 'logo';
    img.src = logoSrc;
    img.alt = '';
    header.appendChild(img);
  }
  // A logo replaces the title text — showing both stacks the wordmark over the name.
  if (cfg.title && !logoSrc) {
    var h1 = document.createElement('h1');
    h1.textContent = cfg.title;
    header.appendChild(h1);
  }

  // ----- footer -----
  var footer = document.getElementById('footer');
  footer.textContent = cfg.footer_text || '';

  // ----- background images crossfade -----
  var bgLayer = document.getElementById('bgLayer');
  var bgs = Array.isArray(cfg.background_images) ? cfg.background_images.map(safeImgUrl).filter(Boolean) : [];
  var bgEls = [];
  bgs.forEach(function(url){
    var el = document.createElement('img');
    el.className = 'bg-img';
    el.src = url;
    el.alt = '';
    bgLayer.appendChild(el);
    bgEls.push(el);
  });
  if (bgEls.length > 0) {
    bgEls[0].classList.add('active');
    if (bgEls.length > 1) {
      var idx = 0;
      setInterval(function(){
        bgEls[idx].classList.remove('active');
        idx = (idx + 1) % bgEls.length;
        bgEls[idx].classList.add('active');
      }, 15000);
    }
  }

  // ----- layout the scroller between header and footer -----
  var scroller = document.getElementById('scroller');
  function layoutScroller() {
    var headerH = header.getBoundingClientRect().height;
    var footerH = footer.getBoundingClientRect().height;
    scroller.style.top = headerH + 'px';
    scroller.style.bottom = footerH + 'px';
  }
  layoutScroller();
  window.addEventListener('resize', layoutScroller);

  // ----- build directory content -----
  var cols = cfg.columns || 'auto';
  if (['auto','1','2','3','4'].indexOf(String(cols)) === -1) cols = 'auto';

  function buildCategoryEl(cat) {
    var catEl = document.createElement('div');
    catEl.className = 'category';
    var h2 = document.createElement('h2');
    h2.textContent = cat.name || '';
    catEl.appendChild(h2);
    var entries = document.createElement('div');
    entries.className = 'entries';
    entries.setAttribute('data-cols', String(cols));
    (cat.entries || []).forEach(function(e){
      var row = document.createElement('div');
      row.className = 'entry' + (e.available ? ' available' : '');
      var id = document.createElement('span');
      id.className = 'id';
      id.textContent = (e.identifier || '') + ':';
      var text = document.createElement('div');
      text.className = 'text';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = e.name || '';
      text.appendChild(nm);
      if (e.subtitle) {
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = e.subtitle;
        text.appendChild(sub);
      }
      row.appendChild(id);
      row.appendChild(text);
      entries.appendChild(row);
    });
    catEl.appendChild(entries);
    return catEl;
  }

  var stage = scroller; // the clip window between header & footer
  var N = 4;            // panels in the ring (2 tile the screen, 1 dwells below, 1 above)
  var baseStyle = document.createElement('style');
  baseStyle.textContent =
    '.panel{ position:absolute; left:0; right:0; top:0; overflow:hidden; contain:paint; will-change:transform; backface-visibility:hidden; }' +
    '.pcontent{ position:absolute; left:0; right:0; top:0; padding:0 48px; }';
  document.head.appendChild(baseStyle);
  var scrollStyle = document.createElement('style');
  scrollStyle.id = 'dir-scroll-kf';
  document.head.appendChild(scrollStyle);

  // ----- scroll: a ring of compositor-animated, viewport-tall panels -----
  // Animating one tall track fails on Firefox (it won't composite a transform bigger than ~1.1x the
  // viewport / 4096px and falls back to a stuttering main-thread animation) and churns GPU tiles even
  // on Chromium. Instead we run N panels, each exactly one stage-height tall (overflow:hidden +
  // contain:paint clamp each compositor layer to that box). Each panel is a static window onto a full
  // copy of the directory (positioned by a static inner translateY = -slice); the PANEL is slid
  // rigidly upward by ONE CSS @keyframes animation, and the panels are phase-locked by negative
  // animation-delay so two always tile the screen while one dwells off-screen below and one above.
  // There is NO per-frame JS — "scrolling" is the compositor sliding pre-rasterized viewport-sized
  // textures, so nothing on the main thread (GC, extensions, the host player) can stutter it. On each
  // off-screen wrap a panel jumps its slice N screens ahead (content already built — nothing to load
  // when it reappears) and, if a data refresh is pending, rebuilds its content THEN, safely off-screen.
  var panels = [];       // [{el, content, version, slice}]
  var Sh = 0;            // panel / stage height
  var C = 0;             // looped directory height (one full copy)
  var speedPxSec = 0;
  var contentVersion = 0;
  var pending = null;    // a queued data refresh, picked up per-panel while off-screen

  function fillContent(el) { // full directory + a clone of the top (>= one screen) for the within-panel wrap
    var arr = Array.isArray(cfg.categories) ? cfg.categories : [];
    arr.forEach(function(c){ el.appendChild(buildCategoryEl(c)); });
    var full = el.scrollHeight; // == C (one full directory)
    var i = 0, guard = arr.length * 4 + 1;
    while ((el.scrollHeight - full) < Sh + 4 && arr.length && i < guard) {
      el.appendChild(buildCategoryEl(arr[i % arr.length])); i++;
    }
    return full;
  }

  function globalScroll() { return speedPxSec * ((document.timeline.currentTime || 0) / 1000); }
  function mod(a, n) { return n > 0 ? ((a % n) + n) % n : 0; }
  function setSlice(p, off) { p.slice = off; p.content.style.transform = 'translate3d(0,' + (-off) + 'px,0)'; }

  function seedSlices() { // four consecutive screens, matching the lanes' physical phase (delays 0..-3T)
    var base = globalScroll();
    var laneStart = [2 * Sh, 1 * Sh, 0, -1 * Sh];
    panels.forEach(function(p, i){ setSlice(p, mod(base + laneStart[i % 4], C)); });
  }

  function onWrap(p) { // fires as a panel wraps to the bottom (off-screen); rebuild + advance N screens
    if (pending && p.version !== pending.version) {
      p.content.replaceChildren();
      C = fillContent(p.content); // all panels share the same data => same C
      p.version = pending.version;
    }
    setSlice(p, mod(p.slice + N * Sh, C));
  }

  function setup() {
    layoutScroller();
    Sh = stage.getBoundingClientRect().height || window.innerHeight;
    stage.replaceChildren();
    panels = [];
    for (var i = 0; i < N; i++) {
      var el = document.createElement('div'); el.className = 'panel'; el.setAttribute('data-lane', i);
      el.style.height = Sh + 'px';
      var content = document.createElement('div'); content.className = 'pcontent';
      el.appendChild(content);
      stage.appendChild(el);
      panels.push({ el: el, content: content, version: contentVersion, slice: 0 });
    }
    C = fillContent(panels[0].content);
    for (var j = 1; j < N; j++) fillContent(panels[j].content);
    speedPxSec = (C <= Sh) ? MIN_SCROLL_PX_SEC : (SPEEDS[cfg.scroll_speed] || SPEEDS.medium);
    var T = Sh / speedPxSec, dur = N * T;
    var kf = '@keyframes dir-pan { from { transform: translate3d(0,' + (2 * Sh) + 'px,0); } to { transform: translate3d(0,' + (-2 * Sh) + 'px,0); } }';
    kf += '.panel{ animation: dir-pan ' + dur + 's linear infinite; }';
    for (var k = 0; k < N; k++) kf += '.panel[data-lane="' + k + '"]{ animation-delay: ' + (-k * T).toFixed(4) + 's; }';
    scrollStyle.textContent = kf;
    seedSlices();
    panels.forEach(function(p){ p.el.addEventListener('animationiteration', function(){ onWrap(p); }); });
  }

  // wait for images (logo + bgs) to load before the first layout, so heights are correct
  var pendingImgs = Array.from(document.images).filter(function(i){ return !i.complete; });
  if (pendingImgs.length === 0) {
    setup();
  } else {
    var built = false, build = function(){ if (!built) { built = true; setup(); } };
    pendingImgs.forEach(function(i){
      i.addEventListener('load', build, { once:true });
      i.addEventListener('error', build, { once:true });
    });
    setTimeout(build, 5000); // hard timeout so we never hang
  }

  // re-layout on resize (debounced) — rebuild the ring; globalScroll() keeps the same content position
  var rT;
  window.addEventListener('resize', function(){
    clearTimeout(rT);
    rT = setTimeout(setup, 250);
  });

  // ----- live data refresh: poll data.json; re-render ONLY when the entries changed -----
  // Mirrors the directory-search poll. data.json is THIS board's own feed (relative URL,
  // CORS-open, no-store). Diff the categories signature and rebuild IN PLACE only on a real
  // change, so an unchanged poll never touches the running scroll (no periodic reset).
  var lastSig = JSON.stringify(cfg.categories || []);
  setInterval(function(){
    if (document.hidden) return;
    fetch('data.json', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(data){
        var cats = data && Array.isArray(data.categories) ? data.categories : [];
        var sig = JSON.stringify(cats);
        if (sig === lastSig) return;      // unchanged -> leave the scroll running untouched
        lastSig = sig;
        cfg.categories = cats;
        contentVersion++;                 // queue it; each panel adopts it on its next off-screen wrap
        pending = { version: contentVersion };
      })
      .catch(function(){ /* transient error -> keep last-good board */ });
  }, REFRESH_MS);

  // ----- pixel shift (anti-burn-in): every 5 min, shift .page 0-3px random dir -----
  var page = document.getElementById('page');
  setInterval(function(){
    var dx = Math.floor(Math.random() * 7) - 3; // -3..+3
    var dy = Math.floor(Math.random() * 7) - 3;
    page.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
  }, 5 * 60 * 1000);
})();
</script>
</body></html>`;
}

// Friendly full-page fallback when a directory-search points at a missing or
// non-directory-board source. Matches the "Unknown widget" fallback tone.
function renderDirectorySearchMissing() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Directory Search</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;color:#fff;background:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:640px"><h1 style="font-size:2.2em;font-weight:600;margin:0 0 14px">Directory source not found</h1><p style="opacity:0.7;font-size:1.2em;margin:0;line-height:1.4">Pick a directory board in the widget settings.</p></div>
</body></html>`;
}

// Interactive walk-up search over an existing directory-board's entries. It
// REFERENCES the source board by id (no data copy): the board scrolls on a main
// screen while this lets someone find an entry instantly on a tablet.
function renderDirectorySearch(c) {
  c = c || {};
  const src = db.prepare('SELECT * FROM widgets WHERE id = ?').get(c.source_widget_id);
  if (!src || src.widget_type !== 'directory-board') return renderDirectorySearchMissing();
  let categories = [];
  try {
    const sc = JSON.parse(src.config || '{}');
    categories = Array.isArray(sc.categories) ? sc.categories : [];
  } catch (e) { categories = []; }

  // Inline everything the page needs as one JSON blob, guarded the same way the
  // board does. All user text is rendered via textContent below — never concat.
  const payload = {
    categories: categories,
    source_widget_id: src.id,
    title: c.title || '',
    logo_url: c.logo_url || '',
    theme: c.theme === 'light' ? 'light' : 'dark',
    placeholder_text: c.placeholder_text || 'Search…',
    show_onscreen_keyboard: c.show_onscreen_keyboard !== false,
  };
  const configJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Directory Search</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:#fff; background:#1a1a2e;
    display:flex; flex-direction:column; height:100vh; overflow:hidden;
  }
  body.light { color:#1a1a2e; background:#f5f5f5; }

  .header { flex:0 0 auto; text-align:center; padding:20px 24px 8px; }
  .header img.logo { max-height:90px; max-width:320px; object-fit:contain; margin:0 auto 8px; display:block; }
  .header h1 { font-size:40px; font-weight:600; letter-spacing:0.01em; }

  .searchbar { flex:0 0 auto; padding:10px 24px; }
  #q {
    width:100%; font-size:34px; padding:18px 22px; border-radius:14px; color:inherit; outline:none;
    border:2px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.08);
  }
  #q:focus { border-color:#4a9eff; }
  #q::placeholder { color:rgba(255,255,255,0.4); }
  body.light #q { border-color:rgba(0,0,0,0.15); background:#fff; }
  body.light #q:focus { border-color:#2563eb; }
  body.light #q::placeholder { color:rgba(0,0,0,0.4); }

  .results { flex:1 1 auto; overflow-y:auto; padding:8px 24px 16px; -webkit-overflow-scrolling:touch; }
  .msg { text-align:center; opacity:0.55; font-size:26px; padding:48px 16px; line-height:1.4; }

  .group { margin-bottom:22px; }
  .group h2 {
    font-size:22px; font-weight:500; letter-spacing:0.06em; text-transform:uppercase; opacity:0.6;
    padding:14px 0 8px; border-bottom:1px solid rgba(255,255,255,0.15); margin-bottom:10px;
  }
  body.light .group h2 { border-bottom-color:rgba(0,0,0,0.12); }

  .entry { display:flex; gap:14px; align-items:baseline; padding:10px 8px; font-size:30px; line-height:1.3; border-radius:8px; }
  .entry:nth-child(even) { background:rgba(255,255,255,0.03); }
  body.light .entry:nth-child(even) { background:rgba(0,0,0,0.03); }
  .entry .id { font-weight:700; min-width:2.6em; flex-shrink:0; }
  .entry .text { display:flex; flex-direction:column; flex:1; min-width:0; }
  .entry .nm { font-weight:400; }
  .entry .sub { font-size:0.6em; opacity:0.6; margin-top:3px; }
  .entry.available, .entry.available .id { color:#00ff00; }
  body.light .entry.available, body.light .entry.available .id { color:#059669; }

  /* The keyboard is sized against the VIEWPORT, not in fixed px. A panel's CSS viewport is its
     physical resolution divided by its density, so a 1080p screen at 240dpi presents only 1280x720
     CSS px - and a keyboard laid out for 1920x1080 then eats ~37% of the height instead of ~24%.
     The vh terms scale it down on short viewports; the clamp() maxima are the original values, so
     a 1080-tall viewport renders pixel-identically to before (5.3vh and 2.3vh both exceed their
     max at 1080 and clamp). The px minima keep the keys tappable on very short screens. */
  .keyboard { flex:0 0 auto; padding:clamp(5px,0.8vh,8px) 12px clamp(8px,1.3vh,14px); background:rgba(0,0,0,0.25); user-select:none; }
  body.light .keyboard { background:rgba(0,0,0,0.05); }
  .krow { display:flex; gap:clamp(4px,0.6vh,6px); justify-content:center; margin-bottom:clamp(4px,0.6vh,6px); }
  .key {
    flex:1 1 0; max-width:96px; min-width:0;
    height:clamp(34px,5.3vh,56px); font-size:clamp(15px,2.3vh,24px); text-transform:uppercase;
    border:0; border-radius:8px; background:rgba(255,255,255,0.12); color:inherit; cursor:pointer;
  }
  .key:active { background:#4a9eff; color:#fff; }
  body.light .key { background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.15); }
  .key-space { flex:4 1 0; max-width:none; text-transform:none; }
  .key-wide { flex:2 1 0; max-width:none; text-transform:none; }

  @media (max-width:700px) {
    .header h1 { font-size:30px; }
    #q { font-size:26px; padding:14px 16px; }
    .entry { font-size:24px; }
    /* .key is viewport-scaled above - no fixed override here, it would undo the clamp. */
  }
</style>
</head>
<body>
  <header class="header" id="header"></header>
  <div class="searchbar"><input id="q" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
  <div class="results" id="results"></div>
  <div class="keyboard" id="keyboard"></div>
<script>
(function(){
  var cfg = ${configJson};
  if (cfg.theme === 'light') document.body.classList.add('light');

  function safeImgUrl(u) {
    return typeof u === 'string' && (u.indexOf('/') === 0 || /^https?:\\/\\//.test(u) || /^data:image\\//.test(u)) ? u : '';
  }

  // ----- header -----
  var header = document.getElementById('header');
  var logoSrc = safeImgUrl(cfg.logo_url);
  if (logoSrc) {
    var img = document.createElement('img');
    img.className = 'logo'; img.src = logoSrc; img.alt = '';
    header.appendChild(img);
  }
  // A logo replaces the title text — showing both stacks the wordmark over the name.
  if (cfg.title && !logoSrc) {
    var h1 = document.createElement('h1');
    h1.textContent = cfg.title;
    header.appendChild(h1);
  }
  if (!logoSrc && !cfg.title) header.style.display = 'none';

  // ----- flatten source entries (preserve category order) -----
  function buildFlat(categories) {
    var out = [];
    (Array.isArray(categories) ? categories : []).forEach(function(cat){
      var cn = cat && cat.name != null ? String(cat.name) : '';
      var entries = cat && Array.isArray(cat.entries) ? cat.entries : [];
      entries.forEach(function(e){
        var item = {
          cat: cn,
          identifier: e && e.identifier != null ? String(e.identifier) : '',
          name: e && e.name != null ? String(e.name) : '',
          subtitle: e && e.subtitle != null ? String(e.subtitle) : '',
          available: !!(e && e.available)
        };
        item._h = (item.identifier + ' ' + item.name + ' ' + item.subtitle).toLowerCase();
        out.push(item);
      });
    });
    return out;
  }
  var flat = buildFlat(cfg.categories);

  var input = document.getElementById('q');
  input.placeholder = cfg.placeholder_text || '';
  var results = document.getElementById('results');
  var HINT = 'Start typing to search the directory…';
  var NO_MATCHES = 'No matches';

  function showMessage(msg) {
    results.textContent = '';
    var d = document.createElement('div');
    d.className = 'msg';
    d.textContent = msg;
    results.appendChild(d);
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) { showMessage(HINT); return; }
    var matches = flat.filter(function(e){ return e._h.indexOf(q) !== -1; });
    if (!matches.length) { showMessage(NO_MATCHES); return; }
    var order = [], groups = {};
    matches.forEach(function(e){
      if (!groups[e.cat]) { groups[e.cat] = []; order.push(e.cat); }
      groups[e.cat].push(e);
    });
    results.textContent = '';
    order.forEach(function(cn){
      var group = document.createElement('div');
      group.className = 'group';
      if (cn) {
        var h2 = document.createElement('h2');
        h2.textContent = cn;
        group.appendChild(h2);
      }
      groups[cn].forEach(function(e){
        var row = document.createElement('div');
        row.className = 'entry' + (e.available ? ' available' : '');
        var id = document.createElement('span');
        id.className = 'id';
        id.textContent = e.identifier;
        var text = document.createElement('div');
        text.className = 'text';
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.name;
        text.appendChild(nm);
        if (e.subtitle) {
          var sub = document.createElement('span');
          sub.className = 'sub';
          sub.textContent = e.subtitle;
          text.appendChild(sub);
        }
        row.appendChild(id);
        row.appendChild(text);
        group.appendChild(row);
      });
      results.appendChild(group);
    });
    results.scrollTop = 0;
  }

  // ----- debounced input (~120ms) -----
  var dT;
  function onInput() { clearTimeout(dT); dT = setTimeout(function(){ render(input.value); }, 120); }
  input.addEventListener('input', onInput);

  // ----- on-screen keyboard (drives the same filter path as typing) -----
  if (cfg.show_onscreen_keyboard) {
    /* Tell the platform not to raise ITS keyboard for this field. We autofocus a real
       <input>, which on Android is the signal to throw the system IME over the bottom of
       the screen - directly on top of the keyboard we draw below, so a directory panel
       showed Google's keyboard (mic, GIF and emoji keys included) and never showed its
       own. The buttons write input.value directly, so suppressing the platform keyboard
       costs nothing here. Ignored by browsers that don't know inputmode, which is the
       right fallback: a desktop preview keeps behaving exactly as before. */
    input.setAttribute('inputmode', 'none');
    var kb = document.getElementById('keyboard');
    function press(ch) { input.value += ch; try { input.focus(); } catch(e){} onInput(); }
    ['1234567890','qwertyuiop','asdfghjkl','zxcvbnm'].forEach(function(r){
      var rowEl = document.createElement('div');
      rowEl.className = 'krow';
      r.split('').forEach(function(ch){
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'key'; b.textContent = ch;
        b.addEventListener('click', function(){ press(ch); });
        rowEl.appendChild(b);
      });
      kb.appendChild(rowEl);
    });
    var act = document.createElement('div');
    act.className = 'krow';
    var back = document.createElement('button');
    back.type = 'button'; back.className = 'key key-wide'; back.textContent = '\\u232B';
    back.addEventListener('click', function(){ input.value = input.value.slice(0, -1); try { input.focus(); } catch(e){} onInput(); });
    var space = document.createElement('button');
    space.type = 'button'; space.className = 'key key-space'; space.textContent = 'space';
    space.addEventListener('click', function(){ press(' '); });
    var clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'key key-wide'; clear.textContent = 'clear';
    clear.addEventListener('click', function(){ input.value = ''; try { input.focus(); } catch(e){} onInput(); });
    act.appendChild(back); act.appendChild(space); act.appendChild(clear);
    kb.appendChild(act);
  } else {
    var kbOff = document.getElementById('keyboard');
    if (kbOff) kbOff.style.display = 'none';
  }

  // ----- initial state + autofocus -----
  render('');
  try { input.focus(); } catch(e){}

  // ----- live sync: poll the source board so edits appear without a reload -----
  // The board's data.json sits next to this page (/api/widgets/<board>/data.json),
  // reached with a relative URL so it works behind any proxy/base path and from a
  // null-origin sandboxed iframe (data.json is CORS-open). We only rebuild + rerender
  // when the data actually changed, so a mid-search view isn't disturbed every tick.
  var SRC_ID = cfg.source_widget_id || '';
  var POLL_MS = 30000;
  var lastSig = JSON.stringify(cfg.categories || []);
  if (SRC_ID) {
    setInterval(function(){
      if (document.hidden) return;
      fetch('../' + encodeURIComponent(SRC_ID) + '/data.json', { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function(data){
          var cats = data && Array.isArray(data.categories) ? data.categories : [];
          var sig = JSON.stringify(cats);
          if (sig === lastSig) return;      // unchanged -> leave the view alone
          lastSig = sig;
          flat = buildFlat(cats);
          render(input.value);              // refresh results for the current query
        })
        .catch(function(){ /* transient error -> keep last-good data */ });
    }, POLL_MS);
  }
})();
</script>
</body></html>`;
}

// diag-smoothness: a self-contained frame-cadence tester for the ACTUAL panel. Two GPU-composited
// animations (a vertical scroll like the board + a fast sweep) plus a big on-screen HUD (FPS, refresh
// estimate, long-frame count, worst stall, SMOOTH/STALLING verdict) — so a stutter can be read off the
// panel screen with no console. If this stalls on real signage hardware, the hardware is the cause.
function renderDiagSmoothness(config) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smoothness Diagnostic</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:#0a0d13;color:#cbd4e4;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;height:100vh}
  .bar{position:absolute;top:0;left:0;right:0;padding:1.4vh 2vw;border-bottom:1px solid #20293a;background:#0f1420;z-index:5}
  .bar h1{font-size:2.2vh;font-weight:700;letter-spacing:.02em}
  .bar p{font-size:1.7vh;color:#6d7789;margin-top:.4vh}
  .bar b{color:#54a6ff}
  .stage{position:absolute;top:0;left:0;right:0;bottom:0}
  .col{position:absolute;top:0;left:0;width:52%;height:100%;overflow:hidden;border-right:1px solid #20293a}
  .roll{position:absolute;left:0;right:0;top:0;will-change:transform;animation:roll 30s linear infinite}
  @keyframes roll{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,-50%,0)}}
  .row{display:flex;align-items:center;gap:1.4vw;padding:1.5vh 2vw;border-bottom:1px solid #20293a;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:2.6vh}
  .row .n{color:#54a6ff;min-width:3.2em;font-variant-numeric:tabular-nums}
  .row:nth-child(3n) .n{color:#37d391}
  .sweep{position:absolute;top:0;right:0;width:48%;height:100%;background:repeating-linear-gradient(90deg,#0f1420 0 3vw,#182234 3vw 6vw)}
  .marker{position:absolute;top:0;bottom:0;width:.5vw;background:#f5b451;box-shadow:0 0 3vw #f5b451;will-change:transform;animation:sweep 2s linear infinite}
  @keyframes sweep{from{transform:translateX(0)}to{transform:translateX(calc(48vw - .5vw))}}
  .tag{position:absolute;top:1.5vh;font-family:ui-monospace,monospace;font-size:1.6vh;color:#6d7789;z-index:2}
  .col .tag{left:1.5vw;background:#0a0d13;padding:.4vh .8vw;border-radius:4px}
  .sweep .tag{right:1.5vw}
  .hud{position:absolute;left:50%;bottom:3vh;transform:translateX(-50%);background:rgba(12,16,24,.94);border:1px solid #20293a;border-radius:14px;padding:2.2vh 2.4vw;min-width:64vw;z-index:6;box-shadow:0 1.4vh 4vh rgba(0,0,0,.55)}
  .verdict{display:flex;align-items:center;gap:1.4vw;margin-bottom:1.8vh}
  .dot{width:1.8vh;height:1.8vh;border-radius:50%;background:#6d7789}
  .verdict.smooth .dot{background:#37d391;box-shadow:0 0 0 .6vh rgba(55,211,145,.16)}
  .verdict.stall .dot{background:#ff5d5d;box-shadow:0 0 0 .6vh rgba(255,93,93,.18)}
  .verdict .txt{font-size:3.4vh;font-weight:750;letter-spacing:.01em}
  .verdict.smooth .txt{color:#37d391}.verdict.stall .txt{color:#ff5d5d}
  .verdict .sub{font-size:1.9vh;color:#6d7789;font-weight:400;margin-left:auto;text-align:right}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.2vw;margin-bottom:1.4vh}
  .stat{background:#121826;border:1px solid #20293a;border-radius:10px;padding:1.2vh 1vw}
  .stat .k{font-size:1.4vh;text-transform:uppercase;letter-spacing:.08em;color:#6d7789}
  .stat .v{font-family:ui-monospace,Menlo,monospace;font-size:4vh;font-variant-numeric:tabular-nums;margin-top:.4vh}
  .stat .v small{font-size:1.8vh;color:#6d7789}
  .log{font-family:ui-monospace,Menlo,monospace;font-size:1.7vh;color:#6d7789;height:2.4vh;overflow:hidden}
  .log b{color:#ff5d5d}
  </style></head><body>
  <div class="bar"><h1>Panel Smoothness Diagnostic</h1><p>Two GPU-composited animations, zero app logic. If the scroll or the yellow bar <b>skips</b> — or the HUD reads STALLING — this <b>panel/hardware</b> is dropping frames.</p></div>
  <div class="stage">
    <div class="col"><div class="tag">TEST 1 &middot; vertical scroll</div><div class="roll" id="roll"></div></div>
    <div class="sweep"><div class="tag">TEST 2 &middot; fast sweep</div><div class="marker"></div></div>
    <div class="hud">
      <div class="verdict" id="verdict"><span class="dot"></span><span class="txt" id="vtxt">measuring&hellip;</span><span class="sub" id="vsub">collecting frames</span></div>
      <div class="grid">
        <div class="stat"><div class="k">FPS now</div><div class="v" id="fps">&ndash;</div></div>
        <div class="stat"><div class="k">Refresh est.</div><div class="v" id="hz">&ndash;<small> Hz</small></div></div>
        <div class="stat"><div class="k">Long frames</div><div class="v" id="long">0<small> &gt;50ms</small></div></div>
        <div class="stat"><div class="k">Worst stall</div><div class="v" id="worst">0<small> ms</small></div></div>
      </div>
      <div class="log" id="log">no stalls yet &middot; a healthy panel shows 0 long frames</div>
    </div>
  </div>
  <script>
  (function(){
    var roll=document.getElementById('roll'),half='',i;
    for(i=1;i<=26;i++){ half+='<div class="row"><span class="n">'+(100+i)+'</span><span class="t">Directory line '+i+'</span></div>'; }
    roll.innerHTML=half+half;
    var last=0,worst=0,longCount=0,recent=[],dts=[],started=0,lastPaint=0;
    var elFps=document.getElementById('fps'),elHz=document.getElementById('hz'),elLong=document.getElementById('long'),
        elWorst=document.getElementById('worst'),elLog=document.getElementById('log'),verdict=document.getElementById('verdict'),
        vtxt=document.getElementById('vtxt'),vsub=document.getElementById('vsub');
    function median(a){ var b=a.slice().sort(function(x,y){return x-y}); return b[Math.floor(b.length/2)]||0; }
    function paint(ts){
      var med=median(dts)||16.7;
      elFps.innerHTML=(1000/med).toFixed(0);
      elHz.innerHTML=(1000/med).toFixed(0)+'<small> Hz</small>';
      elLong.innerHTML=longCount+'<small> &gt;50ms</small>';
      elWorst.innerHTML=worst.toFixed(0)+'<small> ms</small>';
      if(recent.length) elLog.innerHTML=recent.join(' \\u00b7 ');
      var el=ts-started;
      if(el>4000){
        if(longCount===0){ verdict.className='verdict smooth'; vtxt.innerHTML='SMOOTH'; vsub.innerHTML='0 long frames &mdash; this panel animates cleanly'; }
        else { verdict.className='verdict stall'; vtxt.innerHTML='STALLING'; vsub.innerHTML=longCount+' long frame'+(longCount>1?'s':'')+' &mdash; this panel is dropping frames'; }
      } else { vsub.innerHTML='collecting frames&hellip; '+(el/1000).toFixed(0)+'s'; }
    }
    function frame(ts){
      if(!started) started=ts;
      if(last){ var dt=ts-last; dts.push(dt); if(dts.length>180) dts.shift();
        if(dt>50){ longCount++; if(dt>worst) worst=dt;
          recent.unshift('<b>'+dt.toFixed(0)+'ms</b> @ '+((ts-started)/1000).toFixed(0)+'s'); if(recent.length>3) recent.pop(); }
      }
      last=ts;
      if(ts-lastPaint>250){ lastPaint=ts; paint(ts); }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // the player appends ?device=<id> to the render URL so telemetry can be keyed to THIS panel.
    var DEVID=''; try{ var mm=(location.search||'').match(/[?&](?:device|d)=([^&]+)/); if(mm) DEVID=decodeURIComponent(mm[1]); }catch(e){}
    // report the snapshot back to the server (relative 'telemetry' -> /api/widgets/<id>/telemetry).
    // text/plain keeps it a CORS-simple request (no preflight) from the null-origin sandboxed iframe.
    function report(){
      try{
        var med=median(dts)||16.7, now=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
        var payload={device:DEVID,fps:Math.round(1000/med),refreshHz:Math.round(1000/med),longFrames:longCount,worstStallMs:Math.round(worst),
          elapsedS:started?Math.round((now-started)/1000):0,
          verdict:(started&&(now-started>4000))?(longCount?'STALLING':'SMOOTH'):'measuring',
          recent:recent.slice(0,3).map(function(s){return s.replace(/<[^>]+>/g,'');}),
          vp:window.innerWidth+'x'+window.innerHeight,dpr:window.devicePixelRatio||1,ua:(navigator.userAgent||'').slice(0,180)};
        fetch('telemetry',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload),keepalive:true})['catch'](function(){});
      }catch(e){}
    }
    setInterval(report,2500);
  })();
  </script></body></html>`;
}

module.exports = router;
