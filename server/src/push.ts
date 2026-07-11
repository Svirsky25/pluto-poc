import webpush from "web-push";
import { listSubscriptions, deleteSubscription } from "./db";

// Debug: report whether the keys are visible when this module loads (never
// print the secret itself — just presence — since this lands in Railway logs).
console.log(
  "[push] module load — VAPID_PUBLIC_KEY:",
  process.env.VAPID_PUBLIC_KEY ? "present" : "MISSING",
  "VAPID_PRIVATE_KEY:",
  process.env.VAPID_PRIVATE_KEY ? "present" : "MISSING",
);

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

// Read the keys LIVE from process.env every time (never cache them into a
// const at module load) so that import ordering can never capture them before
// dotenv / the hosting platform has populated the environment.
export function getPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}

function getPrivateKey(): string {
  return process.env.VAPID_PRIVATE_KEY || "";
}

export function isPushEnabled(): boolean {
  return Boolean(getPublicKey() && getPrivateKey());
}

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
  webpush.setVapidDetails(VAPID_SUBJECT, getPublicKey(), getPrivateKey());
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
