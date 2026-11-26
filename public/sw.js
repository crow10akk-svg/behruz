const CACHE_NAME = 'smart-kutubxona-static-v3';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/face-models/tiny_face_detector_model-weights_manifest.json',
  '/face-models/tiny_face_detector_model.bin',
  '/face-models/face_landmark_68_tiny_model-weights_manifest.json',
  '/face-models/face_landmark_68_tiny_model.bin',
  '/face-models/face_recognition_model-weights_manifest.json',
  '/face-models/face_recognition_model.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first with cache fallback for HTML navigation and root shell
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for immutable face recognition weights, catalog snapshot, and hashed assets
  if (
    url.pathname.startsWith('/face-models/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/data/')
  ) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE_NAME).then((c) => c.put(req, copy).catch(() => {}));
            }
            return res;
          })
      )
    );
  }
});
