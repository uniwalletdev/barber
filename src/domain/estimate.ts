/**
 * Wait-time estimation.
 *
 * The estimate is a sum over the actual people ahead of you, each priced at
 * this barber's own measured pace for the service they are having — never a
 * flat per-head number.
 */

import { orderQueue } from "./order";
import type {
  BarberSnapshot,
  QueueEntry,
  ServiceAverage,
  ShopPolicy,
} from "./types";

/**
 * Shown once a cut has run past its estimate. A hard zero would sit there
 * indefinitely at exactly the moment a waiting customer is most likely to walk.
 */
export const WRAPPING_UP_FLOOR_SECONDS = 120;

/** Durations outside this band are treated as mistaps, not measurements. */
export const MIN_PLAUSIBLE_CUT_SECONDS = 240;
export const MAX_PLAUSIBLE_CUT_SECONDS = 5400;

/** Per-service timing for one barber: the shop default plus what they've measured. */
export interface ServiceTiming {
  defaultDurationSeconds: number;
  average?: ServiceAverage;
}

export type TimingLookup = (serviceId: string) => ServiceTiming | undefined;

/**
 * How long this barber takes over this service.
 *
 * Below `estimateMinSamples` the barber's own average is blended toward the
 * shop default rather than trusted outright, so one unusually fast morning
 * does not set the quote for everybody behind.
 */
export function serviceDuration(
  timing: ServiceTiming | undefined,
  minSamples: number,
): number {
  if (!timing) return 0;
  const avg = timing.average;
  if (!avg || avg.sampleCount === 0) return timing.defaultDurationSeconds;
  if (avg.sampleCount >= minSamples) return avg.avgDurationSeconds;
  const w = avg.sampleCount / minSamples;
  return Math.round(w * avg.avgDurationSeconds + (1 - w) * timing.defaultDurationSeconds);
}

export interface ChairState {
  seconds: number;
  /** The visit this time is already accounted for, so callers do not count it twice. */
  accountedVisitId: string | null;
  wrappingUp: boolean;
}

/** Time left on the chair right now, live against the clock. */
export function remainingInChair(
  queue: readonly QueueEntry[],
  timings: TimingLookup,
  policy: ShopPolicy,
  now: Date,
): ChairState {
  const inProgress = queue.find((v) => v.status === "in_progress");
  if (inProgress?.startedAt) {
    const estimate = serviceDuration(timings(inProgress.serviceId), policy.estimateMinSamples);
    const elapsed = (now.getTime() - inProgress.startedAt.getTime()) / 1000;
    if (elapsed >= estimate) {
      return {
        seconds: WRAPPING_UP_FLOOR_SECONDS,
        accountedVisitId: inProgress.id,
        wrappingUp: true,
      };
    }
    return { seconds: estimate - elapsed, accountedVisitId: inProgress.id, wrappingUp: false };
  }

  // Someone has been called but is not in the chair yet: the chair is turning
  // over, and their whole service is still ahead of everyone behind them.
  const called = queue.find((v) => v.status === "called");
  if (called) {
    return {
      seconds: serviceDuration(timings(called.serviceId), policy.estimateMinSamples),
      accountedVisitId: called.id,
      wrappingUp: false,
    };
  }
  return { seconds: 0, accountedVisitId: null, wrappingUp: false };
}

export interface WaitEstimate {
  seconds: number;
  /** People genuinely ahead, for "3 ahead of you" in the UI. */
  ahead: number;
  wrappingUp: boolean;
}

function sumAhead(
  ahead: readonly QueueEntry[],
  accountedVisitId: string | null,
  timings: TimingLookup,
  policy: ShopPolicy,
): number {
  return ahead
    .filter((v) => v.id !== accountedVisitId)
    .reduce(
      (total, v) =>
        total + serviceDuration(timings(v.serviceId), policy.estimateMinSamples) +
        policy.chairTurnoverSeconds,
      0,
    );
}

function breakRemainder(barber: BarberSnapshot, now: Date): number {
  if (barber.presence !== "on_break" || !barber.breakUntil) return 0;
  return Math.max(0, (barber.breakUntil.getTime() - now.getTime()) / 1000);
}

/** Wait for a visit already in the queue. */
export function waitFor(
  visitId: string,
  queue: readonly QueueEntry[],
  opts: { timings: TimingLookup; policy: ShopPolicy; barber: BarberSnapshot; now: Date },
): WaitEstimate | null {
  const line = orderQueue(queue);
  const index = line.findIndex((v) => v.id === visitId);
  if (index === -1) return null;

  const chair = remainingInChair(queue, opts.timings, opts.policy, opts.now);
  const ahead = line.slice(0, index);
  const seconds =
    chair.seconds +
    sumAhead(ahead, chair.accountedVisitId, opts.timings, opts.policy) +
    // The chair has to turn over for this customer too.
    opts.policy.chairTurnoverSeconds +
    breakRemainder(opts.barber, opts.now);

  return {
    seconds: Math.round(seconds),
    ahead: ahead.filter((v) => v.id !== chair.accountedVisitId).length +
      (chair.accountedVisitId ? 1 : 0),
    wrappingUp: chair.wrappingUp,
  };
}

/** What a new joiner would wait — the number on the barber list. */
export function waitToJoin(
  queue: readonly QueueEntry[],
  opts: { timings: TimingLookup; policy: ShopPolicy; barber: BarberSnapshot; now: Date },
): WaitEstimate {
  const line = orderQueue(queue);
  const chair = remainingInChair(queue, opts.timings, opts.policy, opts.now);
  const seconds =
    chair.seconds +
    sumAhead(line, chair.accountedVisitId, opts.timings, opts.policy) +
    opts.policy.chairTurnoverSeconds +
    breakRemainder(opts.barber, opts.now);

  return {
    seconds: Math.round(seconds),
    ahead: line.filter((v) => v.id !== chair.accountedVisitId).length +
      (chair.accountedVisitId ? 1 : 0),
    wrappingUp: chair.wrappingUp,
  };
}

export interface AverageUpdate {
  avgDurationSeconds: number;
  sampleCount: number;
  /** False when the sample was rejected as implausible and nothing was learned. */
  accepted: boolean;
}

/**
 * Fold one completed cut into a barber's running average.
 *
 * Early samples move the average a lot and later ones settle into an EWMA, so a
 * new barber converges quickly without a single outlier owning the estimate
 * forever. Implausible durations are logged and discarded rather than averaged:
 * a barber who forgets to tap Complete until closing time is the single largest
 * source of corruption here.
 */
export function updateAverage(
  current: ServiceAverage,
  actualSeconds: number,
): AverageUpdate {
  const ceiling = Math.max(MAX_PLAUSIBLE_CUT_SECONDS, 3 * current.avgDurationSeconds);
  if (actualSeconds < MIN_PLAUSIBLE_CUT_SECONDS || actualSeconds > ceiling) {
    return { ...current, accepted: false };
  }
  const alpha = Math.max(1 / (current.sampleCount + 1), 0.2);
  return {
    avgDurationSeconds: Math.round(
      current.avgDurationSeconds + alpha * (actualSeconds - current.avgDurationSeconds),
    ),
    sampleCount: current.sampleCount + 1,
    accepted: true,
  };
}

/** Display rounding: 5-minute granularity, and a band once the wait is long. */
export function formatWait(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 5) return "under 5 min";
  const low = Math.round(minutes / 5) * 5;
  if (low <= 20) return `${low} min`;
  const high = Math.round((low * 1.25) / 5) * 5;
  return `${low}–${high} min`;
}
