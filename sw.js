/* Service worker
   1. Makes the portal installable and opens the page shell quickly. It caches
      ONLY this site's own static files — requests to Firebase and Apps Script
      (all staff data) are never stored, so a lost phone holds no clinic data.
   2. Shows push notifications (Firebase Cloud Messaging) when the portal is
      closed or in the background, and opens the right page when one is tapped. */
const CACHE = "kkmeru-shell-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./boot-check.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/badge-72.png"];

/* ---------- push notifications ---------- */
try { importScripts("./config.js"); } catch (e) {}
const CFG = self.PORTAL_CONFIG || {};
const unset = v => !v || /PASTE_/.test(String(v));

if (CFG.firebase && !unset(CFG.firebase.apiKey) && !unset(CFG.firebase.messagingSenderId)) {
  try {
    importScripts(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
    );
    firebase.initializeApp(CFG.firebase);
    firebase.messaging().onBackgroundMessage(payload => showPortalNotification((payload && payload.data) || {}));
  } catch (e) { /* offline at install time — retried when the worker next updates */ }
}

function showPortalNotification(d) {
  const urgent = d.urgent === "1";
  return self.registration.showNotification(d.title || "Portal KK Meru", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-72.png",          // small monochrome icon in the Android status bar
    tag: d.tag || "portal",               // a newer notice about the same thing replaces the old one
    renotify: true,
    requireInteraction: urgent,           // urgent ones stay on a laptop screen until dismissed
    vibrate: urgent ? [200, 100, 200, 100, 200] : [120],
    data: { url: d.url || "./" }
  });
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) {
      open.postMessage({ type: "open-tab", url });   // the page switches tab without losing unsaved edits
      return open.focus();
    }
    return self.clients.openWindow(url);
  }));
});

/* ---------- offline shell ---------- */
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Network first, so updates pushed to GitHub show up straight away;
  // the cached copy is only used when offline.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      .then(hit => hit || new Response("Offline", { status: 503, statusText: "Offline" })))
  );
});
