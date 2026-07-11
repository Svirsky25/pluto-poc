// Client-side Web Push subscription helpers.

export type PushState =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

export function getPushState(): PushState {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission as PushState;
}

// Whether there is already an active push subscription (drives the toggle).
export async function isSubscribed(): Promise<boolean> {
  if (getPushState() === "unsupported") return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  } catch {
    return false;
  }
}

// Turn any thrown value into a readable string (Errors, DOMExceptions, etc.).
export function errStr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// Environment facts that explain most iOS push failures (especially whether
// the app is running as an installed/standalone PWA — iOS requires it).
export function pushDiagnostics(): string {
  const standalone =
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    // iOS Safari legacy flag
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  return [
    `standalone(installed)=${standalone}`,
    `permission=${"Notification" in window ? Notification.permission : "n/a"}`,
    `serviceWorker=${"serviceWorker" in navigator}`,
    `PushManager=${"PushManager" in window}`,
    `Notification=${"Notification" in window}`,
    `secureContext=${window.isSecureContext}`,
    `ua=${navigator.userAgent}`,
  ].join("\n");
}

// Convert a base64url VAPID key into the Uint8Array the PushManager expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getVapidPublicKey(): Promise<string> {
  const res = await fetch("/api/vapid-public-key");
  if (!res.ok) throw new Error("Failed to load VAPID public key");
  const data = await res.json();
  if (!data.publicKey) throw new Error("Server has no VAPID public key configured");
  return data.publicKey as string;
}

// Request permission (must be called from a user gesture) and register a
// push subscription with the server. Returns the resulting permission state.
export async function subscribeToPush(): Promise<PushState> {
  if (getPushState() === "unsupported") {
    throw new Error(
      "Push unsupported (missing serviceWorker / PushManager / Notification)",
    );
  }

  // Each phase is wrapped so the surfaced error names exactly where it failed.
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (e) {
    throw new Error(`[requestPermission] ${errStr(e)}`);
  }
  if (permission !== "granted") return permission as PushState;

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch (e) {
    throw new Error(`[serviceWorker.ready] ${errStr(e)}`);
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await getVapidPublicKey();
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    } catch (e) {
      throw new Error(
        `[pushManager.subscribe] ${errStr(e)} (vapidKeyLen=${publicKey.length})`,
      );
    }
  }

  let res: Response;
  try {
    res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch (e) {
    throw new Error(`[server subscribe fetch] ${errStr(e)}`);
  }
  if (!res.ok) throw new Error(`[server subscribe] HTTP ${res.status}`);

  return "granted";
}

export async function unsubscribeFromPush(): Promise<void> {
  if (getPushState() === "unsupported") return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  await fetch("/api/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}
