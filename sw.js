// Caches only the static app shell. Data calls to Supabase always go to the network.
const CACHE = "attendance-shell-v4";
const APP_SHELL = ["./", "./index.html", "./app.js?v=4", "./config.js", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // never touch API/CDN calls
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));    // network first, cache fallback
});
