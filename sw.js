const CACHE_NAME = "mpv2-v1";
const SHELL_FILES = ["/", "/index.html", "/app.js"];

// ─── INSTALL: cache app shell ─────────────────────────────────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// ─── ACTIVATE: clean old caches ──────────────────────────────────────────────
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── FETCH: serve shell from cache, API calls always go to network ────────────
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// ─── PUSH: show notification when backend pushes a signal ────────────────────
self.addEventListener("push", (e) => {
  let data = { title: "Market Prediction V2", body: "New signal detected", ticker: "", upside: 0 };
  try {
    data = e.data.json();
  } catch (_) {}

  e.waitUntil(
    self.registration.showNotification(data.title || "Market Prediction V2", {
      body: data.body || "New high-conviction signal detected",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.ticker || "signal",
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || "/" },
      actions: [{ action: "view", title: "View Signal" }],
    })
  );
});

// ─── MESSAGE: trigger scan from app, post result back ────────────────────────
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// ─── NOTIFICATION CLICK: open app ────────────────────────────────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ─── BACKGROUND SYNC: periodic scan every 5 min when app is closed ───────────
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "market-scan") {
    e.waitUntil(runBackgroundScan());
  }
});

async function runBackgroundScan() {
  try {
    // Get the backend URL from the cache storage (app saves it there)
    const cache = await caches.open(CACHE_NAME);
    const configRes = await cache.match("/config");
    let backendUrl = "https://signal4.vercel.app/api/scan";
    if (configRes) {
      const config = await configRes.json();
      backendUrl = config.backendUrl || backendUrl;
    }

    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    if (!res.ok) return;
    const data = await res.json();
    if (data.marketClosed || !data.alerts?.length) return;

    // Only notify for Critical/High alerts
    const important = data.alerts.filter(
      (a) => a.urgency === "Critical" || a.urgency === "High"
    );
    if (!important.length) return;

    const top = important[0];
    await self.registration.showNotification("🚨 Market Prediction V2", {
      body: `${top.ticker} +${top.estimatedUpside}% — ${top.headline}`,
      icon: "/icon-192.png",
      tag: "background-signal",
      renotify: true,
      requireInteraction: true,
      data: { url: "/" },
    });

    // Post to all open clients so they update without reload
    const clientList = await clients.matchAll({ type: "window" });
    clientList.forEach((client) =>
      client.postMessage({ type: "NEW_SIGNALS", alerts: data.alerts })
    );
  } catch (_) {}
}
