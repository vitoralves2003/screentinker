// Service worker for the admin SPA. Strategy is network-first with offline
// fallback (the server sends Cache-Control: no-cache + ETag, so 304s stay fast).
// Cache name is bumped on each release that must invalidate stale client caches:
//   v2 - first network-first version (replaced a cache-first SW that shipped stale JS)
//   v3 - force returning clients to drop the old bucket so the "Add user" admin
//        button (and any client still on a pre-v2 cache-first SW) lands.
//   v4 - stop intercepting media/content/player + range requests. The old handler
//        clone+cache+respond'd every non-API request; a video Range request gets a
//        206 (uncacheable) which broke the handler ("ServiceWorker encountered an
//        unexpected error"), so videos never loaded on pages this SW controls
//        (e.g. the web player, since this SW's scope is '/').
//   v5 - a CASCA DO APLICATIVO MUDOU. A barra deixou de ser marcação no index.html e
//        virou <loop-sidebar>; app.js deixou de desenhá-la. Um cliente com o balde v4
//        guarda o index.html E o app.js ANTIGOS, e a estratégia é network-first: basta
//        UMA falha de rede — um redeploy de poucos segundos — para o `catch` servir os
//        dois do cache. Foi o que aconteceu.
//
//        E o par misto é pior que o par velho: com o index.html novo e o app.js antigo,
//        o componente desenha a barra (logo e Configurações), mas o app.js antigo procura
//        `.sidebar`, encontra null, e route() morre em `sidebar.style` — conteúdo em
//        branco, sem nada na barra, e o servidor respondendo tudo certo o tempo todo.
//
//        A LIÇÃO, escrita onde ela é aplicada: mudar a lista abaixo, ou qualquer arquivo
//        dela, EXIGE subir esta string. Não subir não quebra nada em quem chega novo —
//        quebra em quem já tinha o produto aberto, que é justamente quem não pensaria em
//        limpar o cache.
// Changing this string is what makes the browser detect a new SW + run activate,
// which deletes every cache key != CACHE below.
const CACHE = 'rd-admin-v5';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/css/variables.css', '/css/reset.css', '/css/main.css',
    '/js/app.js', '/js/api.js', '/js/socket.js', '/js/i18n.js',
    '/js/components/toast.js'
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GET navigations/assets. Everything else hits the
  // network unmediated:
  //  - non-GET: cache.put() rejects on them anyway.
  //  - Range requests (video seeking): the response is 206 Partial Content, which
  //    is uncacheable and breaks clone+cache+respond -> "ServiceWorker encountered
  //    an unexpected error", stalling video playback.
  //  - /uploads/ (content/media), /player (the web player), /api/, /socket.io/:
  //    not ours to cache; the player + server set their own cache headers.
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = req.url;
  if (url.includes('/api/') || url.includes('/socket.io/') ||
      url.includes('/uploads/') || url.includes('/player')) return;

  // Network-first: respect the server's Cache-Control: no-cache + ETag (304s stay
  // fast); fall back to cache only when offline. Only cache full, same-origin 200s.
  e.respondWith(
    fetch(req)
      .then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req))
  );
});
