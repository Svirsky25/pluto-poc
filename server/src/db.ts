import Database from "better-sqlite3";
import path from "path";
import { DogStatusRow, DogStatus, PushSubscriptionRow } from "./types";

// SQLite file location. On Railway, set DATABASE_PATH to a mounted volume
// (e.g. /data/pluto.db) so data survives redeploys.
const DB_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, "..", "pluto.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// The singleton row always uses id = 1.
const SINGLETON_ID = 1;

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dog_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_status TEXT NOT NULL,
      last_update_time INTEGER NOT NULL,
      garden_available_until INTEGER,
      reminder_sent INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS walk_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      resulting_status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Migration: add reminder_sent to a pre-existing dog_status table.
  const columns = db
    .prepare("PRAGMA table_info(dog_status)")
    .all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "reminder_sent")) {
    db.exec(
      "ALTER TABLE dog_status ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0"
    );
  }

  // Seed the singleton row exactly once.
  const existing = db
    .prepare("SELECT id FROM dog_status WHERE id = ?")
    .get(SINGLETON_ID);

  if (!existing) {
    db.prepare(
      `INSERT INTO dog_status (id, current_status, last_update_time, garden_available_until, reminder_sent)
       VALUES (?, ?, ?, ?, 0)`
    ).run(SINGLETON_ID, "NEEDS_WALK", Date.now(), null);
  }
}

export function getStatusRow(): DogStatusRow {
  return db
    .prepare("SELECT * FROM dog_status WHERE id = ?")
    .get(SINGLETON_ID) as DogStatusRow;
}

export function updateStatus(
  status: DogStatus,
  gardenAvailableUntil: number | null,
  reminderSent = 0
): void {
  db.prepare(
    `UPDATE dog_status
     SET current_status = ?, last_update_time = ?, garden_available_until = ?, reminder_sent = ?
     WHERE id = ?`
  ).run(status, Date.now(), gardenAvailableUntil, reminderSent, SINGLETON_ID);
}

export function setReminderSent(value: number): void {
  db.prepare("UPDATE dog_status SET reminder_sent = ? WHERE id = ?").run(
    value,
    SINGLETON_ID
  );
}

export function logAction(
  actionType: string,
  resultingStatus: DogStatus
): void {
  db.prepare(
    `INSERT INTO walk_actions (action_type, resulting_status, created_at)
     VALUES (?, ?, ?)`
  ).run(actionType, resultingStatus, Date.now());
}

// --- Push subscription storage -------------------------------------------

export function addSubscription(
  endpoint: string,
  p256dh: string,
  auth: string
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(endpoint, p256dh, auth, Date.now());
}

export function listSubscriptions(): PushSubscriptionRow[] {
  return db
    .prepare("SELECT * FROM push_subscriptions")
    .all() as PushSubscriptionRow[];
}

export function deleteSubscription(endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}
