// Family Wallet — Service Worker
const CACHE_NAME = 'family-wallet-v1';
const BASE = '/Family-Wallet';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png'
];

// Install: cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: serve from cache first, fall back to network
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always let external APIs go straight to network — never intercept
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firebaseapp') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('openai.com') ||
    url.hostname.includes('generativelanguage') ||
    url.protocol === 'chrome-extension:'
  ) {
    return; // Do NOT call e.respondWith — browser handles it natively
  }

  // App shell: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index.html for navigation requests
        if (e.request.mode === 'navigate') {
          return caches.match(BASE + '/index.html');
        }
      });
    })
  );
});
