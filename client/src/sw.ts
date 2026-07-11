/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

// This file is compiled by vite-plugin-pwa (injectManifest). It is excluded
// from the main `tsc` typecheck to avoid DOM/WebWorker lib conflicts.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Precache the built app shell so it is installable / works offline.
precacheAndRoute(self.__WB_MANIFEST || []);

self.skipWaiting();
clientsClaim();

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

// Receive a Web Push message and show a notification (works when the app,
// including its tab, is fully closed).
self.addEventListener("push", (event: PushEvent) => {
  let payload: PushPayload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch {
    if (event.data) payload = { body: event.data.text() };
  }

  const title = payload.title || "פלוטו 🐶";
  const options: NotificationOptions = {
    body: payload.body || "",
    tag: payload.tag || "pluto-status",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    dir: "rtl",
    lang: "he",
    renotify: true,
    data: { url: payload.url || "/" },
  } as NotificationOptions;

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing window (or open one) when a notification is tapped.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
