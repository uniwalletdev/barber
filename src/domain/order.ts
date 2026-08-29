/**
 * Queue ordering.
 *
 * Position is computed on read from a sparse `sort_key`, never stored. That
 * makes a demotion a single-row update rather than a renumbering of everything
 * behind it, which matters because the kiosk, several phones and the barber's
 * tablet all write to the same queue.
 */

import type { QueueEntry } from "./types";
import { isQueued } from "./types";

/** Gap left when appending to the tail. Large enough to bisect into for years. */
export const SORT_KEY_GAP = 1000;

/** priority DESC, then sort_key ASC, then id so the order is total and stable. */
export function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The line, in the order customers are shown. Excludes the chair and terminals. */
export function orderQueue(entries: readonly QueueEntry[]): QueueEntry[] {
  return entries.filter((e) => isQueued(e.status)).sort(compareEntries);
}

/** 1-indexed position as displayed, or null if the visit is not in line. */
export function positionOf(entries: readonly QueueEntry[], visitId: string): number | null {
  const index = orderQueue(entries).findIndex((e) => e.id === visitId);
  return index === -1 ? null : index + 1;
}

/** First in line. May be a remote customer who has not arrived yet. */
export function head(entries: readonly QueueEntry[]): QueueEntry | undefined {
  return orderQueue(entries)[0];
}

/**
 * The first customer the barber can actually call: earliest in line who is
 * physically present. Deliberately not the same as `head` — a remote customer
 * keeps their position while the barber serves someone who is in the building.
 */
export function callable(entries: readonly QueueEntry[]): QueueEntry | undefined {
  return orderQueue(entries).find((e) => e.status === "queued_present");
}

/** Sort key for a new arrival at the back of the line. */
export function tailSortKey(entries: readonly QueueEntry[], now: Date = new Date()): number {
  const last = orderQueue(entries).at(-1);
  const candidate = now.getTime();
  return last && last.sortKey >= candidate ? last.sortKey + SORT_KEY_GAP : candidate;
}

/**
 * Where a demoted customer lands.
 *
 * Operates within the visit's own priority tier, so that when priority stops
 * being 0 for everyone (appointments, cut club) a demoted member falls behind
 * the next two members of their own tier rather than behind the whole line.
 */
export function demotedSortKey(
  entries: readonly QueueEntry[],
  visit: QueueEntry,
  places: number,
): number {
  const tier = orderQueue(entries).filter(
    (e) => e.priority === visit.priority && e.id !== visit.id,
  );
  if (tier.length === 0) return visit.sortKey;

  // Index the visit currently occupies among its own tier.
  const index = tier.filter((e) => compareEntries(e, visit) < 0).length;
  const behind = tier[index + places - 1]; // the entry it should land behind
  const ahead = tier[index + places]; // the one it should land in front of

  // Fewer than `places` customers behind it: it goes to the tail of the tier.
  if (!behind) {
    const last = tier.at(-1)!;
    return Math.max(last.sortKey, visit.sortKey) + SORT_KEY_GAP;
  }
  if (!ahead) return behind.sortKey + SORT_KEY_GAP;
  return (behind.sortKey + ahead.sortKey) / 2;
}

/**
 * Even respacing of the whole line. A visit can only be demoted a couple of
 * times before it is removed, so bisection cannot realistically exhaust
 * numeric(20,6) — but the daily open job runs this so it never has to.
 */
export function renormalizeSortKeys(entries: readonly QueueEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  orderQueue(entries).forEach((entry, i) => out.set(entry.id, (i + 1) * SORT_KEY_GAP));
  return out;
}
