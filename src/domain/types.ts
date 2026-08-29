/** Shared vocabulary for the queue. Mirrors the enums in db/migrations/0001_init.sql. */

export type VisitStatus =
  | "queued_remote"
  | "queued_present"
  | "called"
  | "in_progress"
  | "completed"
  | "left"
  | "no_show"
  | "closed_out";

export type VisitOutcome = "served" | "left" | "no_show" | "closed_out";
export type JoinMethod = "remote" | "walk_in";
export type Presence = "available" | "on_break" | "off";

/** What the customer-facing list shows. `with_client` is derived, never stored. */
export type PublicStatus = "available" | "with_client" | "on_break" | "off";

/** Statuses that occupy the barber for the rest of the day. */
export const ACTIVE_STATUSES = [
  "queued_remote",
  "queued_present",
  "called",
  "in_progress",
] as const satisfies readonly VisitStatus[];

/** Statuses that hold a place in line. `in_progress` is in the chair, not in line. */
export const QUEUED_STATUSES = ["queued_remote", "queued_present", "called"] as const satisfies
  readonly VisitStatus[];

export const TERMINAL_STATUSES = ["completed", "left", "no_show", "closed_out"] as const satisfies
  readonly VisitStatus[];

export function isActive(status: VisitStatus): boolean {
  return (ACTIVE_STATUSES as readonly VisitStatus[]).includes(status);
}
export function isQueued(status: VisitStatus): boolean {
  return (QUEUED_STATUSES as readonly VisitStatus[]).includes(status);
}
export function isTerminal(status: VisitStatus): boolean {
  return (TERMINAL_STATUSES as readonly VisitStatus[]).includes(status);
}

/** Per-shop queue policy. Every field is a column on `shops`. */
export interface ShopPolicy {
  remoteJoinCapPerBarber: number;
  callGraceSeconds: number;
  noShowDemotionPlaces: number;
  maxNoShowsPerVisit: number;
  remoteHeadGraceSeconds: number;
  chairTurnoverSeconds: number;
  estimateMinSamples: number;
}

export const DEFAULT_POLICY: ShopPolicy = {
  remoteJoinCapPerBarber: 3,
  callGraceSeconds: 180,
  noShowDemotionPlaces: 2,
  maxNoShowsPerVisit: 2,
  remoteHeadGraceSeconds: 600,
  chairTurnoverSeconds: 90,
  estimateMinSamples: 5,
};

/**
 * A visit reduced to what ordering and the state machine need. The repository
 * builds these from rows; nothing here touches the database.
 */
export interface QueueEntry {
  id: string;
  customerId: string;
  serviceId: string;
  status: VisitStatus;
  joinMethod: JoinMethod;
  priority: number;
  sortKey: number;
  noShowCount: number;
  checkedInAt: Date | null;
  calledAt: Date | null;
  startedAt: Date | null;
  headSinceAt: Date | null;
}

export interface BarberSnapshot {
  id: string;
  presence: Presence;
  breakUntil: Date | null;
  acceptingRemoteJoins: boolean;
}

/** A barber's measured pace for one service. */
export interface ServiceAverage {
  avgDurationSeconds: number;
  sampleCount: number;
}

export interface ServiceDefaults {
  id: string;
  defaultDurationSeconds: number;
}

/**
 * The public badge. `with_client` is computed from the barber's in-flight visit
 * rather than stored, so it cannot drift out of step with the queue.
 */
export function publicStatus(barber: BarberSnapshot, queue: readonly QueueEntry[]): PublicStatus {
  if (barber.presence === "off") return "off";
  if (barber.presence === "on_break") return "on_break";
  const engaged = queue.some((v) => v.status === "called" || v.status === "in_progress");
  return engaged ? "with_client" : "available";
}
