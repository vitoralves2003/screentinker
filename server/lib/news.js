'use strict';

/*
 * News feeds for the RSS widget — fetched, parsed and cached ON THE SERVER.
 *
 * WHAT THIS REPLACES. The widget used to call api.rss2json.com from the player, once per panel per
 * five minutes. That is a third-party service with a free-tier quota standing between our customer
 * and their own headlines, it means every screen needs a route to the public internet, and it hands
 * a stranger the list of what our customers read. The same argument as lib/lottery.js: the server
 * fetches once for the whole install and the widget reads /api/widgets/:id/data.json.
 *
 * KEEP-LAST-GOOD, as everywhere else here. A failed refresh never clears the cache; a panel in a
 * waiting room shows headlines from an hour ago rather than an error, which is both more useful and
 * less embarrassing.
 *
 * IMAGES ARE MIRRORED, NOT LINKED. The card layout lives or dies on the photograph, and a player
 * on a locked-down shop network cannot reach a news CDN. The server mirrors each image once. The
 * widget asks for it BY ITEM INDEX, never by URL — see imageFor() for why that distinction is the
 * whole security story.
 *
 * FEED URLS ARE TENANT-SUPPLIED, so every outbound request goes through lib/ssrf-guard: scheme
 * check, DNS resolution, every resolved address vetted against private ranges, and the socket
 * pinned to the vetted IP so a rebinding DNS server cannot swap it afterwards.
 */

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const config = require('../config');
const appSettings = require('./app-settings');
const { assertSafeUrl, pinnedLookup } = require('./ssrf-guard');

const TIMEOUT_MS = 12000;
const TTL_MS = (parseInt(process.env.NEWS_TTL_MINUTES, 10) || 10) * 60 * 1000;
const MAX_ITEMS = 12;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Wide enough to fill a 4K card without being visibly soft, small enough that a panel on a modem
// is not pulling a print-resolution photograph.
const IMAGE_WIDTH = parseInt(process.env.NEWS_IMAGE_WIDTH, 10) || 1600;

const IMG_DIR = path.join(config.paths?.dataDir || process.env.DATA_DIR || '.', 'cache', 'news');
// News images churn, unlike club crests. Keep the directory bounded rather than letting a year of
// headlines accumulate on a device with an 8GB card.
const IMG_CACHE_MAX = parseInt(process.env.NEWS_IMAGE_CACHE_MAX, 10) || 240;

const inFlight = new Map();
const imgInFlight = new Map();

/* ── cache ──────────────────────────────────────────────────────────────── */

// One row per feed URL. Hashed because the URL is tenant-supplied and app_settings keys are not
// the place to put arbitrary text.
function cacheKey(feedUrl) {
  return 'news.' + crypto.createHash('sha256').update(String(feedUrl)).digest('hex').slice(0, 32);
}

function readCache(feedUrl) {
  const raw = appSettings.get(cacheKey(feedUrl), null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeCache(feedUrl, data) {
  try { appSettings.set(cacheKey(feedUrl), JSON.stringify(data)); }
  catch (e) { console.warn(`[news] could not persist feed: ${e.message}`); }
}

/* ── outbound ───────────────────────────────────────────────────────────── */

/*
 * Vetted GET. Follows redirects, RE-VETTING each hop — a feed that redirects to 127.0.0.1 is the
 * standard way past a guard that only checks the first URL.
 */
function getVetted(rawUrl, { maxBytes, accept }, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    assertSafeUrl(rawUrl).then(({ url, addresses }) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method: 'GET',
        lookup: pinnedLookup(addresses),   // connect to the vetted IP (defeats DNS rebinding)
        servername: url.hostname,          // SNI and cert validation stay against the hostname
        headers: { 'user-agent': 'LoopPlayer-Signage/1.0', accept },
      }, (res) => {
        const sc = res.statusCode;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch { return reject(new Error('bad redirect')); }
          return getVetted(next, { maxBytes, accept }, redirectsLeft - 1).then(resolve, reject);
        }
        if (sc !== 200) { res.resume(); return reject(new Error(`HTTP ${sc}`)); }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(); return reject(new Error('response too large')); }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
        res.on('error', reject);
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

/* ── parsing ────────────────────────────────────────────────────────────── */

function stripCdata(s) {
  return String(s == null ? '' : s).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"' };

function decode(s) {
  return stripCdata(s)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return m;
    })
    .replace(/<[^>]+>/g, '')     // feeds put markup inside titles more often than they should
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function attr(block, tagName, attrName) {
  const m = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${attrName}\\s*=\\s*["']([^"']+)["'][^>]*>`, 'i'));
  return m ? decode(m[1]) : '';
}

/*
 * The image, in the order feeds actually carry one. Verified against live Brazilian feeds: G1
 * publishes media:content, and a feed that carries nothing here is not an error — the widget has a
 * typographic layout for exactly that case.
 */
function imageFrom(block) {
  for (const [t, a] of [['media:content', 'url'], ['media:thumbnail', 'url'], ['enclosure', 'url'], ['image', 'href']]) {
    const v = attr(block, t, a);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  // Last resort: the first <img> inside the description, which is how older feeds do it.
  const desc = (block.match(/<(?:description|content:encoded)(?:\s[^>]*)?>([\s\S]*?)<\/(?:description|content:encoded)>/i) || [])[1] || '';
  const img = stripCdata(desc).match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return img && /^https?:\/\//i.test(img[1]) ? decode(img[1]) : null;
}

/*
 * Decode the feed body with the charset it actually uses.
 *
 * Brazilian feeds are not all UTF-8: UOL serves ISO-8859-1 and declares it only in the
 * Content-Type header (its XML has no declaration at all). Decoding that as UTF-8 turns every
 * accented word into replacement characters — "após" became "ap�s" on screen, which on a news
 * widget is worse than showing nothing.
 */
function decodeBody(buf, contentType) {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType || '');
  // The XML declaration is ASCII-compatible in every encoding we support, so it is safe to read
  // out of a latin1 view of the first bytes before deciding.
  const fromXml = /encoding\s*=\s*["']([\w-]+)["']/i.exec(buf.toString('latin1', 0, 200));
  const charset = (fromHeader?.[1] || fromXml?.[1] || 'utf-8').toLowerCase();
  const latin = ['iso-8859-1', 'latin1', 'windows-1252', 'cp1252', 'iso8859-1'];
  return buf.toString(latin.includes(charset) ? 'latin1' : 'utf8');
}

/*
 * Today and yesterday only.
 *
 * A signage wall showing a three-day-old headline as if it were news is worse than showing none,
 * and several Brazilian feeds carry evergreen items alongside the day's stories. Compared by DAY
 * in São Paulo, not by a 48-hour window: "yesterday" to a reader means the calendar day, and an
 * item published at 23:50 yesterday is still yesterday's news at 09:00 today.
 *
 * An unparseable date is KEPT. Feeds get their date formats wrong more often than they publish
 * stale news, and throwing away everything we cannot parse is how a widget goes blank.
 */
const _spDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

function isRecent(dateStr) {
  if (!dateStr) return true;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return true;
  const today = _spDay.format(new Date());
  const yesterday = _spDay.format(new Date(Date.now() - 86400000));
  const day = _spDay.format(new Date(t));
  return day === today || day === yesterday;
}

function parseFeed(xml) {
  const source = tag(xml.slice(0, xml.search(/<(?:item|entry)\b/i) + 1 || undefined), 'title');

  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = blocks.map((b) => ({
    title: tag(b, 'title'),
    // Atom puts the date in <updated>/<published>, RSS in <pubDate>.
    date: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || '',
    category: tag(b, 'category'),
    image: imageFrom(b),
    source,
  }))
    // A PHOTOGRAPH IS REQUIRED. The card layout is the picture; without one the widget falls back
    // to a wall of text, and a rotation that alternates between poster and paragraph looks broken
    // rather than varied. Items without an image are dropped, not rendered plainly.
    .filter((i) => i.title && i.image && isRecent(i.date))
    .slice(0, MAX_ITEMS);

  if (!items.length) throw new Error('no recent items with an image');
  return { source, items };
}

/* ── refresh / serve ────────────────────────────────────────────────────── */

async function refresh(feedUrl) {
  try {
    const { body, type } = await getVetted(feedUrl, {
      maxBytes: MAX_FEED_BYTES,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    });
    const parsed = parseFeed(decodeBody(body, type));
    const data = { ...parsed, fetchedAt: Date.now() };
    writeCache(feedUrl, data);
    console.log(`[news] ${parsed.items.length} items from ${parsed.source || feedUrl}`);
    /*
     * Mirror every photograph NOW, in the background, rather than when a panel first asks for it.
     * The first request for an image the server has not seen goes out to the news site and is
     * resized before it returns; doing that while a screen is waiting is what made the first card
     * of a slot come up black. By the time any player polls, the pictures are already on disk.
     * Spaced out so a refresh does not open twelve connections to one news site at once.
     */
    parsed.items.forEach((_, n) => {
      setTimeout(() => { imageFor(feedUrl, n).catch(() => {}); }, n * 400).unref?.();
    });
    return data;
  } catch (err) {
    console.warn(`[news] refresh failed (${err.message}) — keeping cached items`);
    return null;
  }
}

/*
 * The items to serve. Fresh cache is immediate; a stale one is served NOW and refreshed behind it,
 * so a screen never waits on someone else's feed.
 */
async function get(feedUrl) {
  if (!feedUrl) return null;
  const cached = readCache(feedUrl);
  if (cached && (Date.now() - (cached.fetchedAt || 0)) < TTL_MS) return { ...cached, stale: false };

  if (!inFlight.has(feedUrl)) {
    inFlight.set(feedUrl, refresh(feedUrl).finally(() => inFlight.delete(feedUrl)));
  }
  if (!cached) {
    const fresh = await inFlight.get(feedUrl);
    return fresh ? { ...fresh, stale: false } : null;
  }
  return { ...cached, stale: true };
}

/*
 * SEVERAL feeds in one widget, interleaved.
 *
 * One source repeats itself: a single Brazilian portal publishes a dozen stories a day and a
 * widget that only reads it shows the same handful over and over. Taking a round from each source
 * in turn — first story of each, then second of each — means consecutive cards come from different
 * newsrooms, so the wall reads as a news service rather than as one site's front page.
 *
 * A feed that fails contributes nothing and the rest carry on; that is the whole point of asking
 * for more than one.
 */
async function getAll(feedUrls) {
  const urls = (Array.isArray(feedUrls) ? feedUrls : []).filter(Boolean);
  if (!urls.length) return null;
  if (urls.length === 1) return get(urls[0]);

  const feeds = (await Promise.all(urls.map((u) => get(u).catch(() => null)))).filter(Boolean);
  if (!feeds.length) return null;

  /*
   * Each merged item remembers WHICH feed it came from and its index THERE, because that pair is
   * the only way to resolve its photograph later. The widget asks for an image by position, and
   * once several feeds are interleaved a position in the merged list means nothing on its own.
   */
  const merged = [];
  const deepest = Math.max(...feeds.map((f) => f.items.length));
  for (let round = 0; round < deepest; round++) {
    feeds.forEach((feed, f) => {
      if (feed.items[round]) merged.push({ ...feed.items[round], _f: f, _i: round });
    });
  }
  return {
    source: feeds.map((s) => s.source).filter(Boolean).join(' · '),
    items: merged.slice(0, MAX_ITEMS * 2),
    stale: feeds.some((s) => s.stale),
  };
}

/* ── image mirror ───────────────────────────────────────────────────────── */

// Oldest-first eviction, run after each write. Crude on purpose: the directory is small and this
// costs one readdir, which is cheaper than tracking access times for a few hundred JPEGs.
function evict() {
  let files;
  try { files = fs.readdirSync(IMG_DIR).filter((f) => !f.endsWith('.tmp')); } catch { return; }
  if (files.length <= IMG_CACHE_MAX) return;
  const stamped = files.map((f) => {
    try { return { f, t: fs.statSync(path.join(IMG_DIR, f)).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.t - b.t);
  for (const { f } of stamped.slice(0, stamped.length - IMG_CACHE_MAX)) {
    try { fs.unlinkSync(path.join(IMG_DIR, f)); } catch { /* raced with another sweep */ }
  }
}

/*
 * Mirror the image of item `index` of `feedUrl`, returning a local path.
 *
 * THE URL COMES FROM THE CACHE, NOT FROM THE CALLER. This is the whole reason the widget asks by
 * index: an endpoint that took the image URL as a parameter would be an open proxy, and the SSRF
 * guard alone would not save it — the guard stops private addresses, not the use of this server as
 * an anonymous fetcher for the public internet. By index, the only images that can ever be
 * requested are the ones already in a feed the customer configured.
 */
async function imageFor(feedUrl, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_ITEMS) return null;

  const cached = readCache(feedUrl);
  const url = cached?.items?.[n]?.image;
  if (!url) return null;

  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  const file = path.join(IMG_DIR, key);
  if (fs.existsSync(file)) return file;

  if (!imgInFlight.has(key)) {
    imgInFlight.set(key, (async () => {
      try {
        const { body, type } = await getVetted(url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/*' });
        // Trust the bytes, not the header: serving whatever a feed's CDN chose to return, under a
        // content type we did not verify, is how a proxy becomes a way to host arbitrary files.
        if (!isImage(body)) throw new Error(`not an image (${type})`);
        fs.mkdirSync(IMG_DIR, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body);

        /*
         * Downscale before caching. A G1 lead photo is 2.7MB at full size, and every panel on the
         * wall would pull all of it to fill a card that is at most 1600px across. Resizing once
         * here — on the machine that has the CPU — turns that into a couple of hundred KB for
         * every player, forever. It reuses the same jimp/WASM decoder the media ingest uses, so no
         * new dependency and no native build.
         *
         * If the resize fails the ORIGINAL is kept: a heavy photograph beats no photograph.
         */
        try {
          const { writeThumbnail } = require('./image-ops-core');
          const resized = `${file}.${process.pid}.small`;
          await writeThumbnail(tmp, resized, IMAGE_WIDTH, 78);
          fs.renameSync(resized, file);
          fs.unlinkSync(tmp);
        } catch (e) {
          console.warn(`[news] could not downscale image (${e.message}) — caching as received`);
          fs.renameSync(tmp, file);
        }
        evict();
        return file;
      } catch (err) {
        console.warn(`[news] image ${n} unavailable (${err.message})`);
        return null;
      } finally {
        imgInFlight.delete(key);
      }
    })());
  }
  return imgInFlight.get(key);
}

// Magic-number sniff. Only the formats a browser will actually paint.
function isImage(b) {
  if (!b || b.length < 12) return false;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;                       // jpeg
  if (b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return true;                    // png
  if (b.toString('latin1', 0, 3) === 'GIF') return true;                                  // gif
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return true;
  if (b.toString('latin1', 4, 8) === 'ftyp' && /avif|avis/.test(b.toString('latin1', 8, 12))) return true;
  return false;
}

module.exports = { get, getAll, refresh, imageFor, isImage, TTL_MS, MAX_ITEMS, __parse: parseFeed };
