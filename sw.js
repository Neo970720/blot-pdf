/* Blot service worker — keeps the tool usable offline. No document ever touches the network. */
const VERSION = "blot-v1.0.2";
const BASE = new URL("./", self.location).pathname;
const FILES = [
  "",
  "index.html",
  "app/index.html",
  "assets/style.css",
  "assets/config.js",
  "assets/license.js",
  "assets/engine.js",
  "assets/app.js",
  "assets/favicon.svg",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
  "vendor/pdf-lib.min.js",
  "manifest.webmanifest"
];
const SHELL = FILES.map((f) => BASE + f);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        fetch(req).then((res) => { if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(BASE + "app/index.html").then((r) => r || caches.match(BASE + "index.html")));
    })
  );
});
