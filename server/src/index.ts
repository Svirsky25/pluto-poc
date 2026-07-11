// Load environment variables FIRST. This side-effect import is hoisted above
// the local imports below (./db, ./push), so any module that reads process.env
// at load time sees the values. Keep it as the very first import.
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
import { isPushEnabled, sendPushToAll } from "./push";

const PORT = Number(process.env.PORT) || 3001;
const GARDEN_WINDOW_MS = Number(process.env.GARDEN_WINDOW_MS) || 15000; // garden window duration in ms (default 15s for testing)
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

// --- Realtime (Server-Sent Events) ---------------------------------------

const sseClients = new Set<Response>();

// Push the current status to every connected SSE client immediately.
function broadcastStatus(): void {
  const data = `data: ${JSON.stringify(buildStatusResponse())}\n\n`;
  for (const client of sseClients) client.write(data);
}

// --- Precise window scheduling -------------------------------------------

let expiryTimer: NodeJS.Timeout | null = null;
let reminderTimer: NodeJS.Timeout | null = null;

// Fire the reminder and expiry the instant they are due, instead of waiting
// for the polling backstop. Re-called whenever the garden window changes.
function scheduleWindowTimers(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  if (reminderTimer) clearTimeout(reminderTimer);
  expiryTimer = null;
  reminderTimer = null;

  const row = getStatusRow();
  if (
    row.current_status !== "READY_FOR_GARDEN" ||
    row.garden_available_until === null
  ) {
    return;
  }

  const now = Date.now();
  const expiryDelay = row.garden_available_until - now;
  if (expiryDelay <= 0) {
    checkGardenWindow();
    return;
  }
  expiryTimer = setTimeout(checkGardenWindow, expiryDelay);

  if (row.reminder_sent === 0) {
    const reminderDelay = row.garden_available_until - REMINDER_LEAD_MS - now;
    reminderTimer = setTimeout(checkGardenWindow, Math.max(0, reminderDelay));
  }
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

  scheduleWindowTimers();
  broadcastStatus();
  res.json(buildStatusResponse());
});

// GET /api/vapid-public-key -> public key for the client PushManager.
// Reads process.env directly (live) and logs presence so Railway logs reveal
// whether the variable is actually reaching the running server.
app.get("/api/vapid-public-key", (_req: Request, res: Response) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  console.log(
    `[push] GET /api/vapid-public-key — VAPID_PUBLIC_KEY ${
      publicKey ? `present (len ${publicKey.length})` : "MISSING"
    }`,
  );
  res.json({ publicKey });
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

// GET /api/events -> Server-Sent Events stream so the UI updates in realtime.
app.get("/api/events", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Send the current state right away, then keep the connection open.
  res.write(`data: ${JSON.stringify(buildStatusResponse())}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
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
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    if (reminderTimer) {
      clearTimeout(reminderTimer);
      reminderTimer = null;
    }
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
    broadcastStatus();
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

// Backstop poll in case a precise timer is ever lost (e.g. after a restart).
setInterval(checkGardenWindow, EXPIRY_CHECK_INTERVAL_MS);

// Schedule precise timers for any window already in progress at startup.
scheduleWindowTimers();

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
  console.log(
    `[env] VAPID_PUBLIC_KEY ${
      process.env.VAPID_PUBLIC_KEY ? "present" : "MISSING"
    }, VAPID_PRIVATE_KEY ${
      process.env.VAPID_PRIVATE_KEY ? "present" : "MISSING"
    }, VAPID_SUBJECT ${process.env.VAPID_SUBJECT ? "present" : "default"}`,
  );
});
