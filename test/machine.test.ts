import { describe, expect, it } from "vitest";
import {
  isIdle,
  planJoin,
  remoteHoldCount,
  staleHeadTimers,
  transition,
  type MachineContext,
} from "../src/domain/machine";
import { DEFAULT_POLICY, type BarberSnapshot, type QueueEntry } from "../src/domain/types";
import { entry } from "./helpers";

const NOW = new Date("2026-08-29T14:00:00Z");
const available: BarberSnapshot = {
  id: "b1",
  presence: "available",
  breakUntil: null,
  acceptingRemoteJoins: true,
};

const ctx = (queue: QueueEntry[], barber: Partial<BarberSnapshot> = {}): MachineContext => ({
  now: NOW,
  policy: DEFAULT_POLICY,
  barber: { ...available, ...barber },
  queue,
});

const remote = (id: string, sortKey: number, over: Partial<QueueEntry> = {}) =>
  entry({ id, sortKey, status: "queued_remote", joinMethod: "remote", checkedInAt: null, ...over });

describe("joining", () => {
  it("gives a walk-in an immediate check-in and a remote join none", () => {
    const base = { now: NOW, policy: DEFAULT_POLICY, barber: available, queue: [], customerHasActiveVisit: false };
    const walkIn = planJoin({ joinMethod: "walk_in" }, base);
    const away = planJoin({ joinMethod: "remote" }, base);
    expect(walkIn.ok && walkIn.status).toBe("queued_present");
    expect(walkIn.ok && walkIn.checkedInAt).toEqual(NOW);
    expect(away.ok && away.status).toBe("queued_remote");
    expect(away.ok && away.checkedInAt).toBeNull();
  });

  it("caps remote joins but never walk-ins", () => {
    const queue = [remote("r1", 1000), remote("r2", 2000), remote("r3", 3000)];
    const base = { now: NOW, policy: DEFAULT_POLICY, barber: available, queue, customerHasActiveVisit: false };
    const blocked = planJoin({ joinMethod: "remote" }, base);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.code).toBe("remote_cap_reached");
    // The cap exists to protect walk-ins, so it must never turn one away.
    expect(planJoin({ joinMethod: "walk_in" }, base).ok).toBe(true);
  });

  it("counts only un-arrived holds against the cap", () => {
    // A remote customer who walks in frees their slot for the next person.
    const queue = [remote("r1", 1000), remote("r2", 2000), entry({ id: "r3", sortKey: 3000 })];
    expect(remoteHoldCount(queue)).toBe(2);
    const plan = planJoin(
      { joinMethod: "remote" },
      { now: NOW, policy: DEFAULT_POLICY, barber: available, queue, customerHasActiveVisit: false },
    );
    expect(plan.ok).toBe(true);
  });

  it("refuses a second queue for the same customer, and a barber who is off", () => {
    const base = { now: NOW, policy: DEFAULT_POLICY, barber: available, queue: [], customerHasActiveVisit: true };
    expect(planJoin({ joinMethod: "walk_in" }, base)).toMatchObject({ code: "customer_already_queued" });
    expect(
      planJoin({ joinMethod: "walk_in" }, { ...base, customerHasActiveVisit: false, barber: { ...available, presence: "off" } }),
    ).toMatchObject({ code: "barber_off" });
  });

  it("honours a barber pausing remote joins without going on break", () => {
    const result = planJoin(
      { joinMethod: "remote" },
      {
        now: NOW,
        policy: DEFAULT_POLICY,
        barber: { ...available, acceptingRemoteJoins: false },
        queue: [],
        customerHasActiveVisit: false,
      },
    );
    expect(result).toMatchObject({ code: "remote_joins_closed" });
  });
});

describe("check in", () => {
  it("holds the position it already had", () => {
    const r = remote("r1", 1000);
    const result = transition(r, { type: "check_in" }, ctx([r, entry({ id: "w", sortKey: 2000 })]));
    expect(result.ok && result.to).toBe("queued_present");
    // The whole promise of a remote join: sort_key is untouched.
    expect(result.ok && result.patch.sortKey).toBeUndefined();
    expect(result.ok && result.patch.checkedInAt).toEqual(NOW);
  });

  it("cannot be checked in twice", () => {
    const w = entry({ id: "w", sortKey: 1000 });
    expect(transition(w, { type: "check_in" }, ctx([w]))).toMatchObject({ code: "invalid_transition" });
  });
});

describe("calling", () => {
  it("refuses to call someone who has not arrived", () => {
    const r = remote("r1", 1000);
    const result = transition(r, { type: "call_next" }, ctx([r]));
    expect(result).toMatchObject({ code: "invalid_transition" });
    expect(!result.ok && result.message).toContain("not arrived");
  });

  it("refuses to jump the person in front", () => {
    const a = entry({ id: "a", sortKey: 1000 });
    const b = entry({ id: "b", sortKey: 2000 });
    expect(transition(b, { type: "call_next" }, ctx([a, b]))).toMatchObject({ code: "not_callable" });
  });

  it("lets the first arrived customer be called past an un-arrived head", () => {
    const r = remote("r1", 1000);
    const b = entry({ id: "b", sortKey: 2000 });
    expect(transition(b, { type: "call_next" }, ctx([r, b])).ok).toBe(true);
  });

  it("blocks while on break or already with someone", () => {
    const a = entry({ id: "a", sortKey: 1000 });
    expect(
      transition(a, { type: "call_next" }, ctx([a], { presence: "on_break", breakUntil: NOW })),
    ).toMatchObject({ code: "barber_unavailable" });

    const busy = entry({ id: "z", sortKey: 500, status: "in_progress", startedAt: NOW });
    expect(transition(a, { type: "call_next" }, ctx([busy, a]))).toMatchObject({ code: "barber_busy" });
  });
});

describe("no-show on a called position", () => {
  const called = (noShowCount = 0) =>
    entry({
      id: "a",
      sortKey: 1000,
      status: "called",
      calledAt: new Date(NOW.getTime() - 10 * 60_000),
      noShowCount,
    });

  const behind = [
    entry({ id: "b", sortKey: 2000 }),
    entry({ id: "c", sortKey: 3000 }),
    entry({ id: "d", sortKey: 4000 }),
  ];

  it("drops two places instead of taking the spot away", () => {
    const a = called();
    const result = transition(a, { type: "no_show", reason: "grace_expired" }, ctx([a, ...behind]));
    expect(result.ok && result.to).toBe("queued_present");
    expect(result.ok && result.patch.noShowCount).toBe(1);
    expect(result.ok && result.patch.sortKey).toBeGreaterThan(3000);
    expect(result.ok && result.patch.sortKey).toBeLessThan(4000);
  });

  it("waits for the grace period when the sweeper asks", () => {
    const a = entry({ id: "a", sortKey: 1000, status: "called", calledAt: new Date(NOW.getTime() - 30_000) });
    expect(
      transition(a, { type: "no_show", reason: "grace_expired" }, ctx([a, ...behind])),
    ).toMatchObject({ code: "grace_not_expired" });
    // The barber can always override it by hand.
    expect(transition(a, { type: "no_show", reason: "barber_marked" }, ctx([a, ...behind])).ok).toBe(true);
  });

  it("removes them on the second no-show", () => {
    const a = called(1);
    const result = transition(a, { type: "no_show", reason: "grace_expired" }, ctx([a, ...behind]));
    expect(result.ok && result.to).toBe("no_show");
    expect(result.ok && result.patch.outcome).toBe("no_show");
    expect(result.ok && result.effects).toContainEqual({ kind: "increment_no_shows" });
  });
});

describe("the remote customer who never arrives", () => {
  const idleQueue = () => {
    const r = remote("r1", 1000);
    return { r, queue: [r, entry({ id: "b", sortKey: 2000 }), entry({ id: "c", sortKey: 3000 })] };
  };

  it("arms a timer the first time it sees them blocking an idle barber", () => {
    const { r, queue } = idleQueue();
    const result = transition(r, { type: "no_arrival" }, ctx(queue));
    expect(result.ok && result.to).toBe("queued_remote");
    expect(result.ok && result.bookkeepingOnly).toBe(true);
    expect(result.ok && result.patch.headSinceAt).toEqual(NOW);
  });

  it("does nothing while the barber is busy — the hold costs nobody anything", () => {
    const { r, queue } = idleQueue();
    queue.push(entry({ id: "z", sortKey: 500, status: "in_progress", startedAt: NOW }));
    expect(transition(r, { type: "no_arrival" }, ctx(queue))).toMatchObject({ code: "barber_not_idle" });
  });

  it("waits out the grace period, then demotes two places", () => {
    const { r, queue } = idleQueue();
    r.headSinceAt = new Date(NOW.getTime() - 60_000);
    expect(transition(r, { type: "no_arrival" }, ctx(queue))).toMatchObject({
      code: "head_grace_not_expired",
    });

    r.headSinceAt = new Date(NOW.getTime() - 11 * 60_000);
    const result = transition(r, { type: "no_arrival" }, ctx(queue));
    expect(result.ok && result.to).toBe("queued_remote");
    expect(result.ok && result.patch.sortKey).toBeGreaterThan(3000);
    expect(result.ok && result.patch.headSinceAt).toBeNull();
  });

  it("drops them on the second timeout", () => {
    const { r, queue } = idleQueue();
    r.headSinceAt = new Date(NOW.getTime() - 11 * 60_000);
    r.noShowCount = 1;
    const result = transition(r, { type: "no_arrival" }, ctx(queue));
    expect(result.ok && result.to).toBe("left");
    expect(result.ok && result.patch.outcome).toBe("no_show");
  });

  it("clears timers that no longer describe reality", () => {
    const { r, queue } = idleQueue();
    r.headSinceAt = NOW;
    expect(staleHeadTimers(available, queue)).toEqual([]);

    // Barber picks someone up: the head's grace must stop accruing.
    queue.push(entry({ id: "z", sortKey: 500, status: "in_progress", startedAt: NOW }));
    expect(isIdle(available, queue)).toBe(false);
    expect(staleHeadTimers(available, queue)).toEqual(["r1"]);
  });
});

describe("serving and leaving", () => {
  it("runs the happy path start to complete", () => {
    const a = entry({ id: "a", sortKey: 1000, status: "called", calledAt: NOW });
    const started = transition(a, { type: "start" }, ctx([a]));
    expect(started.ok && started.to).toBe("in_progress");

    const inChair = entry({ id: "a", sortKey: 1000, status: "in_progress", calledAt: NOW, startedAt: NOW });
    const done = transition(inChair, { type: "complete" }, ctx([inChair]));
    expect(done.ok && done.to).toBe("completed");
    expect(done.ok && done.patch.outcome).toBe("served");
    expect(done.ok && done.effects).toContainEqual({ kind: "record_completion" });
  });

  it("does not learn a duration from an abandoned cut", () => {
    const inChair = entry({ id: "a", sortKey: 1000, status: "in_progress", calledAt: NOW, startedAt: NOW });
    const result = transition(inChair, { type: "abort" }, ctx([inChair]));
    expect(result.ok && result.to).toBe("left");
    expect(result.ok && result.effects).toEqual([]);
  });

  it("lets a waiting customer leave from any waiting state", () => {
    for (const status of ["queued_remote", "queued_present", "called"] as const) {
      const v = entry({ id: "a", sortKey: 1000, status, calledAt: NOW });
      expect(transition(v, { type: "leave", by: "customer" }, ctx([v])).ok).toBe(true);
    }
  });

  it("closes out anything still active at the end of the day", () => {
    const v = entry({ id: "a", sortKey: 1000, status: "queued_remote" });
    const result = transition(v, { type: "close_out" }, ctx([v]));
    expect(result.ok && result.to).toBe("closed_out");
    const done = entry({ id: "b", sortKey: 2000, status: "completed" });
    expect(transition(done, { type: "close_out" }, ctx([done])).ok).toBe(false);
  });
});
