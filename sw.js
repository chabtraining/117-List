// Offline support: pages and scripts come from the network first so updates show immediately,
// photos come from the cache first (a replaced photo gets a new file name), and the last cached
// copy is used when the workshop has no signal.
const CACHE = 'charb-training-v2';
const PHOTOS = 'charb-training-v1'; // index.html pre-caches every topic photo here
const CORE = ['./', 'index.html', 'print.html', 'video-player.css', 'chairatchakarn-group-logo.png'];
const PHOTO = /\.(webp|jpe?g|png)$/i;

// Cloudflare Pages answers /print.html with a redirect to /print, and a browser refuses a
// redirected response for a page load, so keep a plain copy of the final page instead.
function plain(res) {
  return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(CORE.map(url =>
        fetch(url, { cache: 'reload' }).then(res => {
          if (!res.ok) throw new Error(url + ' ' + res.status);
          return cache.put(url, plain(res));
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTOS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Sign-in calls always go to the server.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (PHOTO.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // The page and its scripts must never come from the browser's own HTTP cache,
  // or an edit can stay invisible for up to ten minutes after it is published.
  const fresh = req.mode === 'navigate' || /\.(html|js)$/.test(url.pathname);
  const hit = fresh ? fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' })) : fetch(req);
  event.respondWith(
    hit
      .then(res => {
        res = plain(res);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit ||
          // Versioned URLs (?v=) may differ from the cached copy; any version beats nothing offline.
          caches.match(req, { ignoreSearch: true }).then(any => any ||
            (req.mode === 'navigate' ? caches.match('index.html', { ignoreSearch: true }) : Response.error())))
      )
  );
});
