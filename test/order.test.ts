import { describe, expect, it } from "vitest";
import {
  callable,
  demotedSortKey,
  head,
  orderQueue,
  positionOf,
  renormalizeSortKeys,
  tailSortKey,
} from "../src/domain/order.js";
import { entry } from "./helpers.js";

const line = () => [
  entry({ id: "a", sortKey: 1000 }),
  entry({ id: "b", sortKey: 2000 }),
  entry({ id: "c", sortKey: 3000 }),
  entry({ id: "d", sortKey: 4000 }),
  entry({ id: "e", sortKey: 5000 }),
];

describe("queue ordering", () => {
  it("orders by sort key and reports 1-indexed positions", () => {
    const queue = line();
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(positionOf(queue, "c")).toBe(3);
    expect(positionOf(queue, "missing")).toBeNull();
  });

  it("puts higher priority first regardless of join order", () => {
    const queue = [...line(), entry({ id: "vip", sortKey: 9000, priority: 100 })];
    expect(orderQueue(queue)[0]?.id).toBe("vip");
  });

  it("excludes the chair and terminal states from the line", () => {
    const queue = [
      entry({ id: "chair", sortKey: 500, status: "in_progress" }),
      entry({ id: "done", sortKey: 600, status: "completed" }),
      ...line(),
    ];
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps a called customer in line so they still see a position", () => {
    const queue = line();
    queue[0]!.status = "called";
    expect(positionOf(queue, "a")).toBe(1);
  });
});

describe("head vs callable", () => {
  it("separates the head from who can actually be called", () => {
    const queue = line();
    queue[0]!.status = "queued_remote";
    queue[0]!.checkedInAt = null;

    // The un-arrived remote customer keeps position 1 ...
    expect(head(queue)?.id).toBe("a");
    expect(positionOf(queue, "a")).toBe(1);
    // ... but Call next acts on the first person actually in the shop.
    expect(callable(queue)?.id).toBe("b");
  });

  it("has nobody callable when every waiting customer is remote", () => {
    const queue = line().map((v) => ({ ...v, status: "queued_remote" as const, checkedInAt: null }));
    expect(callable(queue)).toBeUndefined();
    expect(head(queue)?.id).toBe("a");
  });
});

describe("demotion", () => {
  it("drops exactly two places", () => {
    const queue = line();
    const a = queue[0]!;
    a.sortKey = demotedSortKey(queue, a, 2);
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["b", "c", "a", "d", "e"]);
    expect(positionOf(queue, "a")).toBe(3);
  });

  it("goes to the tail when fewer than two people are behind", () => {
    const queue = [entry({ id: "a", sortKey: 1000 }), entry({ id: "b", sortKey: 2000 })];
    const a = queue[0]!;
    a.sortKey = demotedSortKey(queue, a, 2);
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["b", "a"]);
  });

  it("leaves a lone customer where they are", () => {
    const queue = [entry({ id: "a", sortKey: 1000 })];
    expect(demotedSortKey(queue, queue[0]!, 2)).toBe(1000);
  });

  it("demotes from the middle without disturbing anyone else", () => {
    const queue = line();
    const b = queue[1]!;
    b.sortKey = demotedSortKey(queue, b, 2);
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["a", "c", "d", "b", "e"]);
  });

  it("stays inside its own priority tier", () => {
    // A demoted priority customer falls behind the next two of *their* tier,
    // not behind the whole walk-in line.
    const queue = [
      entry({ id: "v1", sortKey: 1000, priority: 100 }),
      entry({ id: "v2", sortKey: 2000, priority: 100 }),
      entry({ id: "v3", sortKey: 3000, priority: 100 }),
      entry({ id: "w1", sortKey: 1500 }),
      entry({ id: "w2", sortKey: 2500 }),
    ];
    const v1 = queue[0]!;
    v1.sortKey = demotedSortKey(queue, v1, 2);
    expect(orderQueue(queue).map((v) => v.id)).toEqual(["v2", "v3", "v1", "w1", "w2"]);
  });

  it("survives repeated demotion into the same gap", () => {
    const queue = line();
    const a = queue[0]!;
    for (let i = 0; i < 8; i++) a.sortKey = demotedSortKey(queue, a, 2);
    expect(orderQueue(queue).filter((v) => v.id === "a")).toHaveLength(1);
    expect(new Set(orderQueue(queue).map((v) => v.sortKey)).size).toBe(5);
  });
});

describe("sort keys", () => {
  it("appends behind everyone already waiting", () => {
    const queue = [entry({ id: "a", sortKey: Date.now() + 60_000 })];
    expect(tailSortKey(queue, new Date())).toBeGreaterThan(queue[0]!.sortKey);
  });

  it("respaces the line evenly", () => {
    const queue = line();
    queue[0]!.sortKey = 2000.0001;
    const keys = renormalizeSortKeys(queue);
    expect([...keys.values()]).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
});
