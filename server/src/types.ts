// Shared domain types for the Pluto server.

export type DogStatus = "READY_FOR_GARDEN" | "PEE_ONLY" | "NEEDS_WALK";

export type ActionType = "PEE_ONLY" | "PEE_AND_POOP";

// Row shape of the singleton `dog_status` table.
export interface DogStatusRow {
  id: number;
  current_status: DogStatus;
  last_update_time: number; // epoch milliseconds
  garden_available_until: number | null; // epoch milliseconds, null when no active window
  reminder_sent: number; // 0/1 — whether the pre-expiry reminder push was already sent
}

// A stored Web Push subscription.
export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

// Payload returned by GET /api/status.
export interface StatusResponse {
  current_status: DogStatus;
  last_update_time: number;
  garden_available_until: number | null;
  remaining_seconds: number; // 0 when there is no active garden window
}
