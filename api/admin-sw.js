// Service Worker for Admin Panel Caching
const CACHE_NAME = 'admin-cache-v1';
const ADMIN_URLS = [
  '/admin',
  '/admin-t',
  '/admin-m.html',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js'
];

// Install event - cache admin resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Admin Service Worker: Caching admin resources');
        return cache.addAll(ADMIN_URLS.filter(url => !url.includes('firebase')));
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Admin Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache with network fallback
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for admin-related resources
  if (event.request.method !== 'GET') return;
  
  const url = event.request.url;
  const isAdminResource = ADMIN_URLS.some(adminUrl => 
    url.includes(adminUrl.replace(/^https?:\/\/[^\/]+/, ''))
  ) || url.includes('/admin');

  if (isAdminResource) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          // Return cached version if available
          if (response) {
            // Fetch fresh version in background for next time
            fetch(event.request).then((freshResponse) => {
              if (freshResponse.ok) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, freshResponse.clone());
                });
              }
            }).catch(() => {
              // Network error, cached version is still good
            });
            return response;
          }
          
          // Not in cache, fetch from network
          return fetch(event.request).then((response) => {
            if (response.ok) {
              // Cache successful responses
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, response.clone());
              });
            }
            return response;
          });
        })
        .catch(() => {
          // Both cache and network failed
          return new Response('Admin panel temporarily unavailable', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        })
    );
  }
});

// Message handling for cache updates
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }
});
