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
  if (getPushState() === "unsupported") return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission as PushState;

  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await getVapidPublicKey();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const res = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) throw new Error(`Subscribe failed: HTTP ${res.status}`);

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
