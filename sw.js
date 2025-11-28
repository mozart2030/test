const CACHE_NAME = 'epub-translator-pwa-v2';
const urlsToCache = [
  'index.html',
  'manifest.json',
  'sw.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  // يجب إضافة أسماء ملفات الأيقونات هنا
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', event => {
  // تخزين الموارد الأساسية مؤقتًا عند التثبيت
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache and added all necessary files.');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
          console.error('Failed to cache resources during install:', err);
      })
  );
  self.skipWaiting(); // تفعيل عامل الخدمة فوراً
});

self.addEventListener('activate', event => {
  // تنظيف أي نسخ قديمة من الكاش
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // استراتيجية Cache-First: جرب الكاش، وإذا فشل اذهب للشبكة
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // إذا وجدنا استجابة في الكاش، نُرجعها
        if (response) {
          return response;
        }
        // إذا لم نجدها، نذهب إلى الشبكة
        return fetch(event.request);
      })
  );
});
