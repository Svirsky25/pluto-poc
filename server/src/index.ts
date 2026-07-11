import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import {
  initDb,
  getStatusRow,
  updateStatus,
  setReminderSent,
  logAction,
  addSubscription,
  deleteSubscription,
} from "./db";
import { ActionType, StatusResponse } from "./types";
import { isPushEnabled, getPublicKey, sendPushToAll } from "./push";

const PORT = Number(process.env.PORT) || 3001;
const GARDEN_WINDOW_MS = 1000; // 5 hours
const EXPIRY_CHECK_INTERVAL_MS = 15 * 1000; // background job cadence
const REMINDER_LEAD_MS =
  (Number(process.env.REMINDER_LEAD_MINUTES) || 15) * 60 * 1000;

initDb();

const app = express();
app.use(cors());
app.use(express.json());

// --- Helpers -------------------------------------------------------------

function computeRemainingSeconds(gardenAvailableUntil: number | null): number {
  if (!gardenAvailableUntil) return 0;
  const remaining = gardenAvailableUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function buildStatusResponse(): StatusResponse {
  const row = getStatusRow();
  return {
    current_status: row.current_status,
    last_update_time: row.last_update_time,
    garden_available_until: row.garden_available_until,
    remaining_seconds: computeRemainingSeconds(row.garden_available_until),
  };
}

function firePush(title: string, body: string, tag: string): void {
  sendPushToAll({ title, body, tag, url: "/" }).catch((e) =>
    console.error("[push] fan-out error:", e),
  );
}

// --- API routes ----------------------------------------------------------

// GET /api/status -> current status + timer info.
app.get("/api/status", (_req: Request, res: Response) => {
  res.json(buildStatusResponse());
});

// POST /api/action -> record a dog action and apply business logic.
app.post("/api/action", (req: Request, res: Response) => {
  const actionType = req.body?.action_type as ActionType | undefined;

  if (actionType !== "PEE_ONLY" && actionType !== "PEE_AND_POOP") {
    return res.status(400).json({
      error: "action_type must be one of 'PEE_ONLY' or 'PEE_AND_POOP'",
    });
  }

  if (actionType === "PEE_ONLY") {
    // Pee only: no garden window, needs attention soon.
    updateStatus("PEE_ONLY", null);
    logAction(actionType, "PEE_ONLY");
    console.log(
      `[ALERT] ${new Date().toISOString()} - Pluto peed only (רק פיפי). ` +
        `Garden window cleared. Immediate notification.`,
    );
    firePush("פלוטו 🐶", "פלוטו עשה רק פיפי 💛", "pluto-action");
  } else {
    // Pee + poop: opens a fresh 5-hour garden window (overrides any prior one
    // and resets the reminder flag).
    const gardenAvailableUntil = Date.now() + GARDEN_WINDOW_MS;
    updateStatus("READY_FOR_GARDEN", gardenAvailableUntil, 0);
    logAction(actionType, "READY_FOR_GARDEN");
    console.log(
      `[ALERT] ${new Date().toISOString()} - Pluto pooped (פיפי + קקי). ` +
        `Garden available until ${new Date(gardenAvailableUntil).toISOString()}. ` +
        `Immediate notification.`,
    );
    firePush(
      "פלוטו 🐶",
      "פלוטו עשה קקי — הגינה זמינה ל-5 שעות 🌳",
      "pluto-action",
    );
  }

  res.json(buildStatusResponse());
});

// GET /api/vapid-public-key -> public key for the client PushManager.
app.get("/api/vapid-public-key", (_req: Request, res: Response) => {
  res.json({ publicKey: getPublicKey() });
});

// POST /api/subscribe -> store a Web Push subscription.
app.post("/api/subscribe", (req: Request, res: Response) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription payload" });
  }
  addSubscription(endpoint, keys.p256dh, keys.auth);
  res.status(201).json({ ok: true });
});

// POST /api/unsubscribe -> remove a subscription by endpoint.
app.post("/api/unsubscribe", (req: Request, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  deleteSubscription(endpoint);
  res.json({ ok: true });
});

// --- Background job: reminder + expire the garden window -----------------

function checkGardenWindow(): void {
  const row = getStatusRow();
  if (
    row.current_status !== "READY_FOR_GARDEN" ||
    row.garden_available_until === null
  ) {
    return;
  }

  const now = Date.now();

  if (now >= row.garden_available_until) {
    // Window elapsed -> Pluto needs a walk (delayed notification).
    updateStatus("NEEDS_WALK", null, 0);
    console.log(
      `[DELAYED NOTIFICATION] ${new Date().toISOString()} - ` +
        `Garden window expired. Pluto now NEEDS_WALK. Please take Pluto out!`,
    );
    firePush(
      "פלוטו צריך טיול! 🚨",
      "חלון הגינה נגמר — קחו את פלוטו לטיול 🚶",
      "pluto-walk",
    );
    return;
  }

  // Reminder shortly before the window closes (fire once).
  if (
    row.reminder_sent === 0 &&
    now >= row.garden_available_until - REMINDER_LEAD_MS
  ) {
    setReminderSent(1);
    const minutesLeft = Math.max(
      1,
      Math.round((row.garden_available_until - now) / 60000),
    );
    console.log(
      `[REMINDER] ${new Date().toISOString()} - Garden window closes in ~${minutesLeft} min.`,
    );
    firePush(
      "פלוטו — תזכורת ⏰",
      `חלון הגינה נסגר בעוד כ-${minutesLeft} דקות`,
      "pluto-reminder",
    );
  }
}

setInterval(checkGardenWindow, EXPIRY_CHECK_INTERVAL_MS);

// --- Serve the compiled React client -------------------------------------

const clientDist = path.join(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDist));

// SPA fallback: any non-API route serves index.html.
app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Pluto server listening on http://localhost:${PORT}`);
  console.log(`Serving client from: ${clientDist}`);
  console.log(`Push notifications: ${isPushEnabled() ? "ON" : "OFF"}`);
});
