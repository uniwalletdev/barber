import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { QueueRepo } from "../src/db/queue-repo.js";
import { reset, seedShop, testPool, type Fixture } from "./helpers.js";

const pool: pg.Pool = await testPool();
const repo = new QueueRepo(pool);
let fx: Fixture;

const CUSTOMER = { type: "customer" as const };
const BARBER = { type: "barber" as const };

beforeEach(async () => {
  await reset(pool);
  fx = await seedShop(pool);
});

afterAll(async () => {
  await pool.end();
});

/** Joins `count` walk-ins in order and returns their visit ids. */
async function walkIns(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = await repo.join({
      barberId: fx.barberId,
      customerId: fx.customers[i]!,
      serviceId: fx.adultCut,
      joinMethod: "walk_in",
    });
    expect(result.ok).toBe(true);
    if (result.ok) ids.push(result.visitId);
  }
  return ids;
}

const positions = async () => {
  const view = await repo.barberQueue(fx.barberId);
  return view!.entries.map((e) => `${e.id.slice(0, 8)}:${e.position}`);
};

const statusOf = async (visitId: string) => {
  const { rows } = await pool.query(`select status, outcome, no_show_count from visits where id = $1`, [visitId]);
  return rows[0];
};

describe("the ordinary path", () => {
  it("runs join to complete and learns the barber's pace", async () => {
    const [visitId] = await walkIns(1);

    const called = await repo.callNext(fx.barberId, BARBER);
    expect(called).toMatchObject({ ok: true, visitId, to: "called" });

    expect((await repo.apply(visitId!, { type: "start" }, BARBER)).ok).toBe(true);
    // A plausible 32-minute cut, backdated so completion has a duration to learn.
    await pool.query(`update visits set started_at = now() - interval '32 minutes' where id = $1`, [visitId]);
    expect((await repo.apply(visitId!, { type: "complete" }, BARBER)).ok).toBe(true);

    expect(await statusOf(visitId!)).toMatchObject({ status: "completed", outcome: "served" });

    const { rows: avg } = await pool.query(
      `select avg_duration_seconds, sample_count from barber_service_averages
        where barber_id = $1 and service_id = $2`,
      [fx.barberId, fx.adultCut],
    );
    // First real sample replaces the 35-minute shop default outright.
    expect(avg[0].sample_count).toBe(1);
    expect(avg[0].avg_duration_seconds).toBeGreaterThan(31 * 60);
    expect(avg[0].avg_duration_seconds).toBeLessThan(33 * 60);

    const { rows: loyalty } = await pool.query(
      `select visit_count, first_visit_at, last_visit_at from barber_customers
        where barber_id = $1 and customer_id = $2`,
      [fx.barberId, fx.customers[0]],
    );
    expect(loyalty[0].visit_count).toBe(1);
    expect(loyalty[0].first_visit_at).not.toBeNull();
  });

  it("writes an audit row for every transition", async () => {
    const [visitId] = await walkIns(1);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(visitId!, { type: "start" }, BARBER);
    await pool.query(`update visits set started_at = now() - interval '30 minutes' where id = $1`, [visitId]);
    await repo.apply(visitId!, { type: "complete" }, BARBER);

    const { rows } = await pool.query(
      `select event, from_status, to_status from visit_events where visit_id = $1 order by id`,
      [visitId],
    );
    expect(rows.map((r) => r.event)).toEqual(["join", "call_next", "start", "complete"]);
    expect(rows[0].from_status).toBeNull();
    expect(rows.at(-1).to_status).toBe("completed");
  });

  it("does not learn a duration from a cut the barber forgot to close", async () => {
    const [visitId] = await walkIns(1);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(visitId!, { type: "start" }, BARBER);
    await pool.query(`update visits set started_at = now() - interval '7 hours' where id = $1`, [visitId]);
    await repo.apply(visitId!, { type: "complete" }, BARBER);

    const { rowCount } = await pool.query(
      `select 1 from barber_service_averages where barber_id = $1`, [fx.barberId],
    );
    expect(rowCount).toBe(0);
    const { rows } = await pool.query(
      `select 1 from visit_events where visit_id = $1 and event = 'duration_outlier_rejected'`,
      [visitId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("remote joins", () => {
  it("holds a position without being in the shop, and Call next skips past", async () => {
    const remote = await repo.join({
      barberId: fx.barberId,
      customerId: fx.customers[0]!,
      serviceId: fx.adultCut,
      joinMethod: "remote",
    });
    expect(remote.ok).toBe(true);
    const walkIn = await repo.join({
      barberId: fx.barberId,
      customerId: fx.customers[1]!,
      serviceId: fx.adultCut,
      joinMethod: "walk_in",
    });
    expect(walkIn.ok && walkIn.position).toBe(2);

    // The remote customer keeps position 1 ...
    const view = await repo.barberQueue(fx.barberId);
    expect(view!.entries[0]!.id).toBe(remote.ok ? remote.visitId : "");
    expect(view!.heldRemotelyCount).toBe(1);
    expect(view!.checkedInCount).toBe(1);

    // ... but the barber calls the person who is actually there.
    const called = await repo.callNext(fx.barberId, BARBER);
    expect(called).toMatchObject({ ok: true, visitId: walkIn.ok ? walkIn.visitId : "" });
  });

  it("keeps the held position through check-in", async () => {
    const remote = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    for (let i = 1; i < 4; i++) {
      await repo.join({
        barberId: fx.barberId, customerId: fx.customers[i]!, serviceId: fx.adultCut, joinMethod: "walk_in",
      });
    }
    const visitId = remote.ok ? remote.visitId : "";
    expect((await repo.apply(visitId, { type: "check_in" }, CUSTOMER)).ok).toBe(true);

    const view = await repo.barberQueue(fx.barberId);
    expect(view!.entries.find((e) => e.id === visitId)!.position).toBe(1);
    expect((await repo.callNext(fx.barberId, BARBER)) as { visitId: string }).toMatchObject({ visitId });
  });

  it("caps concurrent holds but always lets a walk-in in", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await repo.join({
        barberId: fx.barberId, customerId: fx.customers[i]!, serviceId: fx.adultCut, joinMethod: "remote",
      });
      expect(r.ok).toBe(true);
    }
    const overCap = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[3]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    expect(overCap).toMatchObject({ ok: false, code: "remote_cap_reached" });

    const walkIn = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[3]!, serviceId: fx.adultCut, joinMethod: "walk_in",
    });
    expect(walkIn.ok).toBe(true);
  });

  it("frees a slot back to the cap when a remote customer arrives", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await repo.join({
        barberId: fx.barberId, customerId: fx.customers[i]!, serviceId: fx.adultCut, joinMethod: "remote",
      });
      if (r.ok) ids.push(r.visitId);
    }
    await repo.apply(ids[0]!, { type: "check_in" }, CUSTOMER);
    const nowAllowed = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[3]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    expect(nowAllowed.ok).toBe(true);
  });
});

describe("no-shows", () => {
  it("drops exactly two places rather than taking the spot", async () => {
    const ids = await walkIns(5);
    await repo.callNext(fx.barberId, BARBER);

    const result = await repo.apply(ids[0]!, { type: "no_show", reason: "barber_marked" }, BARBER);
    expect(result).toMatchObject({ ok: true, to: "queued_present" });

    const view = await repo.barberQueue(fx.barberId);
    expect(view!.entries.map((e) => e.id)).toEqual([ids[1], ids[2], ids[0], ids[3], ids[4]]);
    expect(view!.entries[2]!.position).toBe(3);
    expect(await statusOf(ids[0]!)).toMatchObject({ no_show_count: 1 });

    const { rows } = await pool.query(
      `select no_show_count from barber_customers where barber_id = $1 and customer_id = $2`,
      [fx.barberId, fx.customers[0]],
    );
    expect(rows[0].no_show_count).toBe(1);
  });

  it("removes them on the second miss", async () => {
    const ids = await walkIns(5);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(ids[0]!, { type: "no_show", reason: "barber_marked" }, BARBER);
    // They are now third; work down to them and miss again.
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(ids[1]!, { type: "no_show", reason: "barber_marked" }, BARBER);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(ids[2]!, { type: "no_show", reason: "barber_marked" }, BARBER);
    await repo.callNext(fx.barberId, BARBER);

    const second = await repo.apply(ids[0]!, { type: "no_show", reason: "barber_marked" }, BARBER);
    expect(second).toMatchObject({ ok: true, to: "no_show" });
    expect(await statusOf(ids[0]!)).toMatchObject({ status: "no_show", outcome: "no_show" });
  });

  it("holds the grace period against the sweeper", async () => {
    const ids = await walkIns(3);
    await repo.callNext(fx.barberId, BARBER);

    expect(await repo.sweep(fx.shopId)).toMatchObject({ noShows: 0 });
    await pool.query(`update visits set called_at = now() - interval '5 minutes' where id = $1`, [ids[0]]);
    expect(await repo.sweep(fx.shopId)).toMatchObject({ noShows: 1 });
    expect(await statusOf(ids[0]!)).toMatchObject({ status: "queued_present", no_show_count: 1 });
  });
});

describe("the remote customer who never arrives", () => {
  it("arms a timer, then demotes, without touching a busy barber's queue", async () => {
    const remote = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    const visitId = remote.ok ? remote.visitId : "";
    for (let i = 1; i < 4; i++) {
      await repo.join({
        barberId: fx.barberId, customerId: fx.customers[i]!, serviceId: fx.adultCut, joinMethod: "walk_in",
      });
    }

    // First sweep only starts the clock.
    expect(await repo.sweep(fx.shopId)).toMatchObject({ timersArmed: 1, noArrivals: 0 });
    let { rows } = await pool.query(`select head_since_at from visits where id = $1`, [visitId]);
    expect(rows[0].head_since_at).not.toBeNull();

    // While the grace runs, nothing happens.
    expect(await repo.sweep(fx.shopId)).toMatchObject({ noArrivals: 0 });

    await pool.query(`update visits set head_since_at = now() - interval '11 minutes' where id = $1`, [visitId]);
    expect(await repo.sweep(fx.shopId)).toMatchObject({ noArrivals: 1 });

    const view = await repo.barberQueue(fx.barberId);
    expect(view!.entries.findIndex((e) => e.id === visitId)).toBe(2);
    ({ rows } = await pool.query(`select head_since_at from visits where id = $1`, [visitId]));
    expect(rows[0].head_since_at).toBeNull();
  });

  it("stops the clock while the barber is busy", async () => {
    const remote = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    const walkIn = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[1]!, serviceId: fx.adultCut, joinMethod: "walk_in",
    });
    await repo.sweep(fx.shopId);

    // Barber picks up the walk-in: the remote hold is no longer costing anyone
    // anything, so its grace must stop accruing.
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(walkIn.ok ? walkIn.visitId : "", { type: "start" }, BARBER);
    await repo.sweep(fx.shopId);

    const { rows } = await pool.query(`select head_since_at from visits where id = $1`, [
      remote.ok ? remote.visitId : "",
    ]);
    expect(rows[0].head_since_at).toBeNull();
  });
});

describe("invariants the database enforces", () => {
  it("refuses a second active visit for the same customer at the shop", async () => {
    await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "walk_in",
    });
    const second = await repo.join({
      barberId: fx.otherBarberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "walk_in",
    });
    expect(second).toMatchObject({ ok: false, code: "customer_already_queued" });
  });

  it("refuses a second active hold from the same device", async () => {
    const device = await fx.deviceFor(fx.customers[0]!);
    const first = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut,
      joinMethod: "remote", deviceId: device,
    });
    expect(first.ok).toBe(true);
    // A different customer, same phone: exactly the abuse the cap invites while
    // there is no SMS verification.
    const second = await repo.join({
      barberId: fx.otherBarberId, customerId: fx.customers[1]!, serviceId: fx.adultCut,
      joinMethod: "remote", deviceId: device,
    });
    expect(second.ok).toBe(false);
  });

  it("will not let two customers occupy one chair", async () => {
    const ids = await walkIns(2);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(ids[0]!, { type: "start" }, BARBER);

    // Direct write, bypassing the machine: the index has to hold on its own.
    await expect(
      pool.query(`update visits set status = 'in_progress', started_at = now(), called_at = now() where id = $1`, [ids[1]]),
    ).rejects.toMatchObject({ constraint: "visits_one_in_progress_per_barber" });
  });

  it("will not let a customer be called who was never checked in", async () => {
    const remote = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[0]!, serviceId: fx.adultCut, joinMethod: "remote",
    });
    await expect(
      pool.query(`update visits set status = 'called', called_at = now() where id = $1`, [
        remote.ok ? remote.visitId : "",
      ]),
    ).rejects.toMatchObject({ constraint: "present_states_are_checked_in" });
  });

  it("keeps terminal states and outcomes in step", async () => {
    const [visitId] = await walkIns(1);
    await expect(
      pool.query(`update visits set status = 'left', outcome = null where id = $1`, [visitId]),
    ).rejects.toMatchObject({ constraint: "outcome_iff_terminal" });
  });
});

describe("presence", () => {
  it("blocks calling while on a break and quotes the rest of it", async () => {
    await walkIns(2);
    await pool.query(
      `update barbers set presence = 'on_break', break_until = now() + interval '20 minutes' where id = $1`,
      [fx.barberId],
    );
    expect(await repo.callNext(fx.barberId, BARBER)).toMatchObject({ code: "barber_unavailable" });

    const view = await repo.barberQueue(fx.barberId);
    // 2 adult cuts at the 35-minute shop default, plus the rest of the break.
    expect(view!.waitToJoinSeconds).toBeGreaterThan(70 * 60 + 19 * 60);
  });

  it("turns nobody away from a barber who is merely busy", async () => {
    const ids = await walkIns(1);
    await repo.callNext(fx.barberId, BARBER);
    await repo.apply(ids[0]!, { type: "start" }, BARBER);
    const joined = await repo.join({
      barberId: fx.barberId, customerId: fx.customers[1]!, serviceId: fx.adultCut, joinMethod: "walk_in",
    });
    expect(joined.ok).toBe(true);
  });
});

describe("close-out", () => {
  it("ends everything still waiting when the shop closes", async () => {
    await walkIns(3);
    await repo.callNext(fx.barberId, BARBER);
    expect(await repo.closeOut(fx.shopId)).toBe(3);

    const { rows } = await pool.query(
      `select count(*)::int as n from visits where shop_id = $1 and status = 'closed_out'`,
      [fx.shopId],
    );
    expect(rows[0].n).toBe(3);
  });
});
