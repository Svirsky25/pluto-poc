import webpush from "web-push";
import { listSubscriptions, deleteSubscription } from "./db";

// Read the keys LIVE from process.env every time (never cache them into a
// const at module load) so that import ordering / a late-binding monorepo
// start script can never freeze empty values before the environment is
// populated.
export function getPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}

function getPrivateKey(): string {
  return process.env.VAPID_PRIVATE_KEY || "";
}

function getSubject(): string {
  return process.env.VAPID_SUBJECT || "mailto:admin@example.com";
}

export function isPushEnabled(): boolean {
  return Boolean(getPublicKey() && getPrivateKey());
}

// A safe-to-log snapshot of exactly what the environment holds for these keys.
// The public key is not a secret; the private key is reported only by length so
// it never leaks. `vapidKeysFound` surfaces typos / wrong casing in the names.
export function vapidEnvSnapshot(): Record<string, unknown> {
  return {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? null,
    VAPID_PRIVATE_KEY_length: (process.env.VAPID_PRIVATE_KEY || "").length,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? null,
    vapidKeysFound: Object.keys(process.env).filter((k) => /vapid/i.test(k)),
  };
}

// Debug: dump the environment at module load. If it shows empty/null here it is
// harmless — values are read live per request, so a later-populated env works.
console.log("[push] module load env:", JSON.stringify(vapidEnvSnapshot()));

// Configure web-push lazily, the first time we actually need to send.
let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  if (!isPushEnabled()) {
    console.warn(
      "[push] VAPID keys missing — push DISABLED. Set VAPID_PUBLIC_KEY / " +
        "VAPID_PRIVATE_KEY in the environment.",
    );
    return false;
  }
  webpush.setVapidDetails(getSubject(), getPublicKey(), getPrivateKey());
  vapidConfigured = true;
  console.log("[push] Web Push configured.");
  return true;
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

// Fan a notification out to every stored subscription. Stale endpoints
// (410 Gone / 404) are pruned automatically.
export async function sendPushToAll(message: PushMessage): Promise<void> {
  if (!ensureVapidConfigured()) return;

  const subscriptions = listSubscriptions();
  const payload = JSON.stringify(message);

  await Promise.all(
    subscriptions.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deleteSubscription(sub.endpoint);
          console.log(`[push] pruned stale subscription (${statusCode}).`);
        } else {
          console.error("[push] send failed:", statusCode ?? err);
        }
      }
    }),
  );
}
