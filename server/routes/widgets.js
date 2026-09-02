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
// O miolo puro mora em lib/widget-render.js — extraído na Fase B para as duas casas
// servirem o MESMO código. A injeção liga a única leitura de banco que ele precisa.
const widgetRender = require('../lib/widget-render');
const { escapeHtml, safeNumber, KNOWN_WIDGET_TYPES, renderWidgetHtml, seedFor, renderDiagSmoothness } = widgetRender;
widgetRender.usarBuscadorDeWidget((id) => db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));

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
router.get('/:id/render', async (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');
  const config = JSON.parse(widget.config || '{}');
  /*
   * How long this widget is on screen, passed by the player (?dur=seconds).
   *
   * It cannot come from the widget's own config: the same widget can sit in two playlists with
   * different slot lengths, so only the player knows. A widget that knows its slot can size its
   * own rotation to it — one headline per appearance, and a progress bar that finishes exactly
   * when the playlist moves on instead of stopping two thirds of the way across.
   *
   * Clamped, and ignored when absent, so an old player or a direct visit still renders.
   */
  const slotSec = Math.min(3600, Math.max(0, safeNumber(req.query.dur, 0)));
  const iframeSandbox = widgetIframeSandboxForWorkspace(widget.workspace_id);
  if (slotSec > 0) config.__slot_seconds = slotSec;
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
    /*
     * NOT immutable, and that word is the whole lesson.
     *
     * The rev makes the URL content-addressed with respect to the WIDGET — its config, its
     * updated_at — and the code hash folded in beside it covers the widget source too. What
     * neither covers is everything else that shapes these bytes, and "immutable" is a promise
     * that they can never change for any reason at all. A panel that has the page believes that
     * promise literally: it does not revalidate, it does not ask, it renders what it has. For a
     * year.
     *
     * That is not theory. A compatibility fix went out for widget CSS that was breaking every old
     * panel, and the fleet never saw it — the access log shows those panels requesting data.json
     * every few seconds and the rendered page NOT ONCE, because they already had it and had been
     * told never to check again. The only widget that recovered was one the operator happened to
     * recreate, which gave it a new id and therefore a URL nothing had cached.
     *
     * So: still cached, still fast, still there when the network is not. stale-while-revalidate
     * (Chrome 75+, which is under our floor) serves the cached copy instantly and refreshes it in
     * the background, and keeps serving it when the refresh fails — which is what the offline
     * resilience this header was written for actually needs. A fix now reaches every panel within
     * ten minutes instead of never.
     */
    res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=604800');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('Content-Type', 'text/html');
  /*
   * Paint complete, then poll. The seed is this widget's data, resolved on the server and written
   * into the page, so the first frame is the finished widget rather than the word "carregando".
   * The script that follows consumes it before it makes any request at all.
   *
   * Injected right before </body> so it lands AFTER the widget's own script has defined its
   * handler, and JSON.stringify is escaped for the one sequence that could close the tag early.
   */
  const html = renderWidgetHtml(widget.widget_type, config, { iframeSandbox });
  const seed = await seedFor(widget);
  if (!seed) return res.send(html);

  // Escape the one sequence that could close the script tag early: a headline containing
  // </script> would otherwise end the block and put the rest of the feed into the document.
  const json = JSON.stringify(seed).replace(/</g, '\\u003c');
  return res.send(html.replace('</body>', `<script>window.__WSEED__=${json};if(window.__wSeedReady)window.__wSeedReady();</script></body>`));
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

  /*
   * The handle is "<feed>.<item>" when the widget reads several feeds, and a bare item index when
   * it reads one. Both resolve against the feeds THIS widget is configured with — the caller never
   * supplies a URL, which is what keeps this from being an open proxy.
   */
  const feeds = Array.isArray(cfg.feed_urls) && cfg.feed_urls.length ? cfg.feed_urls : [cfg.feed_url];
  const parts = String(req.params.n).split('.');
  const feedIdx = parts.length > 1 ? Number(parts[0]) : 0;
  const itemIdx = parts.length > 1 ? parts[1] : parts[0];
  if (!Number.isInteger(feedIdx) || feedIdx < 0 || feedIdx >= feeds.length) return res.status(404).end();

  const file = await require('../lib/news').imageFor(feeds[feedIdx], itemIdx);
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
    // Several sources interleave into one rotation; one source keeps the shape it always had.
    const feeds = Array.isArray(rssCfg.feed_urls) && rssCfg.feed_urls.length
      ? rssCfg.feed_urls : [rssCfg.feed_url];
    let data = null;
    try { data = await require('../lib/news').getAll(feeds); } catch (e) {
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
        source: i.source,
        // A HANDLE, never a URL. "<feed>.<item>" once several feeds are interleaved, because a
        // position in the merged list does not identify anything on its own.
        image: i._f != null ? `${i._f}.${i._i}` : n,
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


module.exports = router;
