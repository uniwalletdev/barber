/**
 * The visit state machine.
 *
 * Pure: it reads a snapshot of the barber's queue and returns either a
 * rejection or the patch to apply. Nothing here touches the database, so every
 * guard is testable without one. The repository turns an accepted result into
 * SQL inside a transaction, and the partial unique indexes in the schema catch
 * anything that races past these guards.
 */

import {
  callable,
  demotedSortKey,
  head,
  orderQueue,
  tailSortKey,
} from "./order.js";
import type {
  BarberSnapshot,
  JoinMethod,
  QueueEntry,
  ShopPolicy,
  VisitOutcome,
  VisitStatus,
} from "./types.js";
import { isActive, isQueued } from "./types.js";

export type QueueEventType =
  | "check_in"
  | "call_next"
  | "start"
  | "no_show"
  | "no_arrival"
  | "complete"
  | "leave"
  | "abort"
  | "close_out";

export type QueueEvent =
  | { type: "check_in" }
  | { type: "call_next" }
  | { type: "start" }
  /** `grace_expired` is the sweeper; `barber_marked` is the barber tapping No-show. */
  | { type: "no_show"; reason: "grace_expired" | "barber_marked" }
  /** The sweeper, for a remote customer who has never arrived. */
  | { type: "no_arrival" }
  | { type: "complete" }
  | { type: "leave"; by: "customer" | "barber" }
  | { type: "abort" }
  | { type: "close_out" };

export type RejectionCode =
  | "invalid_transition"
  | "barber_off"
  | "barber_unavailable"
  | "barber_busy"
  | "barber_not_idle"
  | "remote_joins_closed"
  | "remote_cap_reached"
  | "customer_already_queued"
  | "not_callable"
  | "not_head"
  | "grace_not_expired"
  | "head_grace_not_expired";

export interface VisitPatch {
  status: VisitStatus;
  outcome?: VisitOutcome;
  checkedInAt?: Date;
  calledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  endedAt?: Date;
  sortKey?: number;
  noShowCount?: number;
  headSinceAt?: Date | null;
}

/** Work the repository must do beyond the visit row itself. */
export type SideEffect =
  | { kind: "record_completion" }
  | { kind: "increment_no_shows" }
  | { kind: "increment_cancellations" };

export interface Accepted {
  ok: true;
  event: QueueEventType;
  from: VisitStatus;
  to: VisitStatus;
  patch: VisitPatch;
  effects: SideEffect[];
  /**
   * True when nothing about the customer's standing changed — only an internal
   * timer moved. Note that a demotion keeps `status` at queued_remote, so this
   * cannot be a comparison of from and to.
   */
  bookkeepingOnly: boolean;
}

export interface Rejected {
  ok: false;
  code: RejectionCode;
  message: string;
}

export type TransitionResult = Accepted | Rejected;

export interface MachineContext {
  now: Date;
  policy: ShopPolicy;
  barber: BarberSnapshot;
  /** Every active visit for this barber, including the one being transitioned. */
  queue: readonly QueueEntry[];
}

function reject(code: RejectionCode, message: string): Rejected {
  return { ok: false, code, message };
}

/** Patch fields that do not change where a customer stands in the queue. */
const BOOKKEEPING_FIELDS = new Set<keyof VisitPatch>(["status", "headSinceAt"]);

function accept(
  event: QueueEventType,
  from: VisitStatus,
  patch: VisitPatch,
  effects: SideEffect[] = [],
): Accepted {
  const touchesStanding = (Object.keys(patch) as (keyof VisitPatch)[]).some(
    (key) => !BOOKKEEPING_FIELDS.has(key),
  );
  return {
    ok: true,
    event,
    from,
    to: patch.status,
    patch,
    effects,
    bookkeepingOnly: from === patch.status && !touchesStanding && effects.length === 0,
  };
}

/** The barber is free right now: not on a break, and nobody called or in the chair. */
export function isIdle(barber: BarberSnapshot, queue: readonly QueueEntry[]): boolean {
  if (barber.presence !== "available") return false;
  return !queue.some((v) => v.status === "called" || v.status === "in_progress");
}

// --------------------------------------------------------------- joining ---

export interface JoinRequest {
  joinMethod: JoinMethod;
  priority?: number;
}

export interface JoinContext {
  now: Date;
  policy: ShopPolicy;
  barber: BarberSnapshot;
  queue: readonly QueueEntry[];
  /** The customer already has an active visit somewhere in this shop. */
  customerHasActiveVisit: boolean;
}

export interface JoinPlan {
  ok: true;
  status: Extract<VisitStatus, "queued_remote" | "queued_present">;
  sortKey: number;
  checkedInAt: Date | null;
  priority: number;
}

/**
 * Remote holds counted against the cap: un-checked-in customers only, so a
 * remote customer who walks in frees their slot back to the next person.
 */
export function remoteHoldCount(queue: readonly QueueEntry[]): number {
  return queue.filter((v) => v.status === "queued_remote").length;
}

export function planJoin(request: JoinRequest, ctx: JoinContext): JoinPlan | Rejected {
  if (ctx.barber.presence === "off") {
    return reject("barber_off", "This barber is not taking customers right now.");
  }
  if (ctx.customerHasActiveVisit) {
    return reject(
      "customer_already_queued",
      "You are already in a queue at this shop. Leave that one first.",
    );
  }
  if (request.joinMethod === "remote") {
    if (!ctx.barber.acceptingRemoteJoins) {
      return reject("remote_joins_closed", "This barber has paused remote joins. Walk-ins only.");
    }
    if (remoteHoldCount(ctx.queue) >= ctx.policy.remoteJoinCapPerBarber) {
      return reject(
        "remote_cap_reached",
        "All remote spots for this barber are taken. Come in to join the line.",
      );
    }
  }
  return {
    ok: true,
    status: request.joinMethod === "remote" ? "queued_remote" : "queued_present",
    sortKey: tailSortKey(ctx.queue, ctx.now),
    checkedInAt: request.joinMethod === "walk_in" ? ctx.now : null,
    priority: request.priority ?? 0,
  };
}

// ----------------------------------------------------------- transitions ---

export function transition(
  visit: QueueEntry,
  event: QueueEvent,
  ctx: MachineContext,
): TransitionResult {
  const { now, policy } = ctx;

  switch (event.type) {
    case "check_in": {
      if (visit.status !== "queued_remote") {
        return reject("invalid_transition", `Cannot check in from ${visit.status}.`);
      }
      // sort_key is untouched: the position was held, that is the whole point
      // of a remote join. head_since_at clears because they have arrived.
      return accept("check_in", visit.status, {
        status: "queued_present",
        checkedInAt: now,
        headSinceAt: null,
      });
    }

    case "call_next": {
      if (visit.status !== "queued_present") {
        return reject(
          "invalid_transition",
          visit.status === "queued_remote"
            ? "This customer has not arrived yet."
            : `Cannot call a visit in ${visit.status}.`,
        );
      }
      if (ctx.barber.presence !== "available") {
        return reject(
          "barber_unavailable",
          ctx.barber.presence === "on_break"
            ? "End your break before calling the next customer."
            : "You are marked as off for the day.",
        );
      }
      if (ctx.queue.some((v) => v.status === "called" || v.status === "in_progress")) {
        return reject("barber_busy", "Finish with your current customer first.");
      }
      const next = callable(ctx.queue);
      if (!next || next.id !== visit.id) {
        return reject("not_callable", "Someone ahead of this customer is next in line.");
      }
      return accept("call_next", visit.status, {
        status: "called",
        calledAt: now,
        headSinceAt: null,
      });
    }

    case "start": {
      if (visit.status !== "called") {
        return reject("invalid_transition", `Cannot start from ${visit.status}.`);
      }
      return accept("start", visit.status, { status: "in_progress", startedAt: now });
    }

    case "no_show": {
      if (visit.status !== "called") {
        return reject("invalid_transition", `Only a called customer can be a no-show.`);
      }
      if (event.reason === "grace_expired") {
        const calledAt = visit.calledAt;
        if (!calledAt) return reject("invalid_transition", "This visit has no call time.");
        const waited = (now.getTime() - calledAt.getTime()) / 1000;
        if (waited < policy.callGraceSeconds) {
          return reject(
            "grace_not_expired",
            `Still within the ${policy.callGraceSeconds}s grace period.`,
          );
        }
      }
      const nextCount = visit.noShowCount + 1;
      if (nextCount >= policy.maxNoShowsPerVisit) {
        return accept(
          "no_show",
          visit.status,
          {
            status: "no_show",
            outcome: "no_show",
            endedAt: now,
            noShowCount: nextCount,
            headSinceAt: null,
          },
          [{ kind: "increment_no_shows" }],
        );
      }
      // Drop places, do not lose the spot.
      return accept(
        "no_show",
        visit.status,
        {
          status: "queued_present",
          noShowCount: nextCount,
          sortKey: demotedSortKey(ctx.queue, visit, policy.noShowDemotionPlaces),
          headSinceAt: null,
        },
        [{ kind: "increment_no_shows" }],
      );
    }

    case "no_arrival": {
      // The remote customer who never turns up: the failure the "no-show on a
      // called position" rule does not cover, and the one that leaves an idle
      // barber staring at a queue.
      if (visit.status !== "queued_remote") {
        return reject("invalid_transition", "Only an un-arrived remote join can time out.");
      }
      if (!isIdle(ctx.barber, ctx.queue)) {
        return reject("barber_not_idle", "The barber is busy, so the hold costs nobody anything.");
      }
      if (head(ctx.queue)?.id !== visit.id) {
        return reject("not_head", "This customer is not at the head of the queue.");
      }
      if (!visit.headSinceAt) {
        // First time we have seen them at the head of an idle queue: start the
        // clock rather than punishing them for a barber who just freed up.
        return accept("no_arrival", visit.status, {
          status: "queued_remote",
          headSinceAt: now,
        });
      }
      const heldFor = (now.getTime() - visit.headSinceAt.getTime()) / 1000;
      if (heldFor < policy.remoteHeadGraceSeconds) {
        return reject(
          "head_grace_not_expired",
          `Held the head for ${Math.round(heldFor)}s of ${policy.remoteHeadGraceSeconds}s.`,
        );
      }
      const nextCount = visit.noShowCount + 1;
      if (nextCount >= policy.maxNoShowsPerVisit) {
        return accept(
          "no_arrival",
          visit.status,
          {
            status: "left",
            outcome: "no_show",
            endedAt: now,
            noShowCount: nextCount,
            headSinceAt: null,
          },
          [{ kind: "increment_no_shows" }],
        );
      }
      return accept(
        "no_arrival",
        visit.status,
        {
          status: "queued_remote",
          noShowCount: nextCount,
          sortKey: demotedSortKey(ctx.queue, visit, policy.noShowDemotionPlaces),
          headSinceAt: null,
        },
        [{ kind: "increment_no_shows" }],
      );
    }

    case "complete": {
      if (visit.status !== "in_progress") {
        return reject("invalid_transition", `Cannot complete from ${visit.status}.`);
      }
      return accept(
        "complete",
        visit.status,
        { status: "completed", outcome: "served", completedAt: now },
        [{ kind: "record_completion" }],
      );
    }

    case "leave": {
      if (!isQueued(visit.status)) {
        return reject("invalid_transition", `Cannot leave from ${visit.status}.`);
      }
      return accept("leave", visit.status, {
        status: "left",
        outcome: "left",
        endedAt: now,
        headSinceAt: null,
      }, [{ kind: "increment_cancellations" }]);
    }

    case "abort": {
      if (visit.status !== "in_progress") {
        return reject("invalid_transition", `Cannot abort from ${visit.status}.`);
      }
      // No timing sample: an abandoned cut is not evidence of how long this
      // barber takes, and averaging it in would drag every estimate down.
      return accept("abort", visit.status, { status: "left", outcome: "left", endedAt: now });
    }

    case "close_out": {
      if (!isActive(visit.status)) {
        return reject("invalid_transition", `Visit is already ${visit.status}.`);
      }
      return accept("close_out", visit.status, {
        status: "closed_out",
        outcome: "closed_out",
        endedAt: now,
        headSinceAt: null,
      });
    }
  }
}

/**
 * Head timers that no longer describe reality: the visit has stopped being the
 * head, or the barber stopped being idle. The sweeper clears these so a
 * customer cannot accumulate grace across a barber's busy stretch.
 */
export function staleHeadTimers(
  barber: BarberSnapshot,
  queue: readonly QueueEntry[],
): string[] {
  const armed = queue.filter((v) => v.headSinceAt !== null);
  if (armed.length === 0) return [];
  if (!isIdle(barber, queue)) return armed.map((v) => v.id);
  const currentHead = orderQueue(queue)[0];
  return armed.filter((v) => v.id !== currentHead?.id).map((v) => v.id);
}
