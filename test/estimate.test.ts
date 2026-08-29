import { describe, expect, it } from "vitest";
import {
  WRAPPING_UP_FLOOR_SECONDS,
  formatWait,
  remainingInChair,
  serviceDuration,
  updateAverage,
  waitFor,
  waitToJoin,
  type TimingLookup,
} from "../src/domain/estimate.js";
import { DEFAULT_POLICY, type BarberSnapshot } from "../src/domain/types.js";
import { entry } from "./helpers.js";

const NOW = new Date("2026-08-29T14:00:00Z");
const MIN = 60;

const barber: BarberSnapshot = {
  id: "b1",
  presence: "available",
  breakUntil: null,
  acceptingRemoteJoins: true,
};

// Adult cut: 35 min shop default, this barber measured at 30. Kids: 45 min.
const timings: TimingLookup = (id) =>
  ({
    adult: { defaultDurationSeconds: 35 * MIN, average: { avgDurationSeconds: 30 * MIN, sampleCount: 20 } },
    kids: { defaultDurationSeconds: 45 * MIN },
  })[id];

const opts = { timings, policy: DEFAULT_POLICY, barber, now: NOW };

describe("service duration", () => {
  it("uses the shop default until the barber has any history", () => {
    expect(serviceDuration({ defaultDurationSeconds: 2100 }, 5)).toBe(2100);
    expect(
      serviceDuration({ defaultDurationSeconds: 2100, average: { avgDurationSeconds: 900, sampleCount: 0 } }, 5),
    ).toBe(2100);
  });

  it("trusts the barber's own pace once there are enough samples", () => {
    expect(
      serviceDuration({ defaultDurationSeconds: 2100, average: { avgDurationSeconds: 1800, sampleCount: 5 } }, 5),
    ).toBe(1800);
  });

  it("blends toward the default while the sample is thin", () => {
    // Two samples of a five-sample threshold: 40% the barber, 60% the shop.
    const blended = serviceDuration(
      { defaultDurationSeconds: 2100, average: { avgDurationSeconds: 1600, sampleCount: 2 } },
      5,
    );
    expect(blended).toBe(Math.round(0.4 * 1600 + 0.6 * 2100));
    expect(blended).toBeGreaterThan(1600);
    expect(blended).toBeLessThan(2100);
  });
});

describe("the chair", () => {
  it("counts down against the clock", () => {
    const queue = [
      entry({
        id: "chair",
        sortKey: 100,
        status: "in_progress",
        serviceId: "adult",
        startedAt: new Date(NOW.getTime() - 10 * MIN * 1000),
      }),
    ];
    const chair = remainingInChair(queue, timings, DEFAULT_POLICY, NOW);
    expect(chair.seconds).toBe(20 * MIN);
    expect(chair.wrappingUp).toBe(false);
  });

  it("never sits at zero once a cut runs long", () => {
    const queue = [
      entry({
        id: "chair",
        sortKey: 100,
        status: "in_progress",
        serviceId: "adult",
        startedAt: new Date(NOW.getTime() - 90 * MIN * 1000),
      }),
    ];
    const chair = remainingInChair(queue, timings, DEFAULT_POLICY, NOW);
    expect(chair.seconds).toBe(WRAPPING_UP_FLOOR_SECONDS);
    expect(chair.wrappingUp).toBe(true);
  });

  it("prices a called customer's whole service — the chair is turning over", () => {
    const queue = [entry({ id: "called", sortKey: 100, status: "called", serviceId: "adult", calledAt: NOW })];
    expect(remainingInChair(queue, timings, DEFAULT_POLICY, NOW).seconds).toBe(30 * MIN);
  });
});

describe("wait estimates", () => {
  it("sums the actual services ahead, not a flat per-head number", () => {
    const queue = [
      entry({ id: "chair", sortKey: 100, status: "in_progress", serviceId: "adult", startedAt: new Date(NOW.getTime() - 10 * MIN * 1000) }),
      entry({ id: "a", sortKey: 1000, serviceId: "kids" }),
      entry({ id: "b", sortKey: 2000, serviceId: "adult" }),
      entry({ id: "me", sortKey: 3000, serviceId: "adult" }),
    ];
    const wait = waitFor("me", queue, opts)!;
    // 20 left in the chair + kids 45 + adult 30 + turnover for each of the
    // three chair changes ahead of this customer.
    expect(wait.seconds).toBe((20 + 45 + 30) * MIN + 3 * DEFAULT_POLICY.chairTurnoverSeconds);
    expect(wait.ahead).toBe(3);
  });

  it("does not double-count the customer who has been called", () => {
    const queue = [
      entry({ id: "called", sortKey: 1000, status: "called", serviceId: "adult", calledAt: NOW }),
      entry({ id: "me", sortKey: 2000, serviceId: "adult" }),
    ];
    const wait = waitFor("me", queue, opts)!;
    // The called customer's cut, plus the one chair change between them and
    // this customer. The turnover already under way as they walk to the chair
    // is absorbed, not charged again.
    expect(wait.seconds).toBe(30 * MIN + DEFAULT_POLICY.chairTurnoverSeconds);
    expect(wait.ahead).toBe(1);
  });

  it("adds the rest of a break", () => {
    const queue = [entry({ id: "me", sortKey: 1000, serviceId: "adult" })];
    const onBreak = {
      ...opts,
      barber: { ...barber, presence: "on_break" as const, breakUntil: new Date(NOW.getTime() + 15 * MIN * 1000) },
    };
    expect(waitFor("me", queue, onBreak)!.seconds).toBe(
      15 * MIN + DEFAULT_POLICY.chairTurnoverSeconds,
    );
  });

  it("quotes a new joiner the whole line", () => {
    const queue = [
      entry({ id: "a", sortKey: 1000, serviceId: "adult" }),
      entry({ id: "b", sortKey: 2000, serviceId: "adult" }),
    ];
    expect(waitToJoin(queue, opts).seconds).toBe(60 * MIN + 3 * DEFAULT_POLICY.chairTurnoverSeconds);
    expect(waitToJoin([], opts).seconds).toBe(DEFAULT_POLICY.chairTurnoverSeconds);
  });

  it("returns nothing for a visit that is not in line", () => {
    expect(waitFor("ghost", [entry({ id: "a", sortKey: 1000 })], opts)).toBeNull();
  });
});

describe("learning a barber's pace", () => {
  it("moves fast on the first samples and settles later", () => {
    const first = updateAverage({ avgDurationSeconds: 2100, sampleCount: 0 }, 1800);
    expect(first.accepted).toBe(true);
    expect(first.avgDurationSeconds).toBe(1800); // alpha = 1: the first real measurement
    expect(first.sampleCount).toBe(1);

    const later = updateAverage({ avgDurationSeconds: 1800, sampleCount: 40 }, 2400);
    expect(later.avgDurationSeconds).toBe(1920); // alpha floors at 0.2
  });

  it("throws away the cut the barber forgot to close", () => {
    const current = { avgDurationSeconds: 1800, sampleCount: 10 };
    const forgotten = updateAverage(current, 6 * 3600);
    expect(forgotten.accepted).toBe(false);
    expect(forgotten.avgDurationSeconds).toBe(1800);
    expect(forgotten.sampleCount).toBe(10);

    // And the mistap where Complete follows Start by seconds.
    expect(updateAverage(current, 30).accepted).toBe(false);
  });
});

describe("display", () => {
  it("rounds to five minutes and widens into a band once the wait is long", () => {
    expect(formatWait(90)).toBe("under 5 min");
    expect(formatWait(11 * MIN)).toBe("10 min");
    expect(formatWait(36 * MIN)).toBe("35–45 min");
  });
});
