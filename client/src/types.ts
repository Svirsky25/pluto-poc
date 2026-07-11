export type DogStatus = "READY_FOR_GARDEN" | "PEE_ONLY" | "NEEDS_WALK";

export type ActionType = "PEE_ONLY" | "PEE_AND_POOP";

export interface StatusResponse {
  current_status: DogStatus;
  last_update_time: number;
  garden_available_until: number | null;
  remaining_seconds: number;
}
