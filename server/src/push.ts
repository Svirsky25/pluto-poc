import webpush from "web-push";
import { listSubscriptions, deleteSubscription } from "./db";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let pushEnabled = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  pushEnabled = true;
  console.log("[push] Web Push enabled.");
} else {
  console.warn(
    "[push] VAPID keys missing — push notifications DISABLED. " +
      "Run `npm run generate:vapid` and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY."
  );
}

export function isPushEnabled(): boolean {
  return pushEnabled;
}

export function getPublicKey(): string {
  return VAPID_PUBLIC_KEY;
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
  if (!pushEnabled) return;

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
    })
  );
}
