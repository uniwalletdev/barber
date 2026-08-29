/**
 * Persistence for the queue.
 *
 * Every mutation takes a row lock on the barber before reading their queue, so
 * the state machine always decides against a snapshot nobody else can move
 * underneath it. The partial unique indexes in the schema are the backstop: if
 * a race does slip past, the write fails rather than producing two people in
 * one chair.
 */

import type pg from "pg";
import type { PoolClient } from "pg";

import {
  planJoin,
  staleHeadTimers,
  transition,
  type Accepted,
  type QueueEvent,
  type Rejected,
  type SideEffect,
  type VisitPatch,
} from "../domain/machine.js";
import { callable, head, positionOf } from "../domain/order.js";
import {
  serviceDuration,
  updateAverage,
  waitFor,
  waitToJoin,
  type ServiceTiming,
  type TimingLookup,
} from "../domain/estimate.js";
import type {
  BarberSnapshot,
  JoinMethod,
  QueueEntry,
  ShopPolicy,
  VisitStatus,
} from "../domain/types.js";
import { ACTIVE_STATUSES } from "../domain/types.js";

const ACTIVE = ACTIVE_STATUSES as readonly VisitStatus[];

export type Actor = { type: "customer" | "barber" | "system"; id?: string | null };

export interface BarberContext {
  shopId: string;
  barber: BarberSnapshot;
  policy: ShopPolicy;
  queue: QueueEntry[];
  timings: TimingLookup;
  businessDate: string;
}

export interface JoinInput {
  barberId: string;
  customerId: string;
  serviceId: string;
  joinMethod: JoinMethod;
  deviceId?: string | null;
  impressionId?: string | null;
}

export interface JoinAccepted {
  ok: true;
  visitId: string;
  position: number;
  estimatedWaitSeconds: number;
}

export interface TransitionAccepted {
  ok: true;
  visitId: string;
  from: VisitStatus;
  to: VisitStatus;
}

const NOT_FOUND: Rejected = {
  ok: false,
  code: "invalid_transition",
  message: "Visit not found or already finished.",
};

/** Maps a partial-unique-index violation back to the guard it duplicates. */
function mapConstraint(error: unknown): Rejected | null {
  const e = error as { code?: string; constraint?: string };
  if (e?.code !== "23505") return null;
  switch (e.constraint) {
    case "visits_one_active_per_customer_shop":
      return { ok: false, code: "customer_already_queued", message: "You are already in a queue at this shop." };
    case "visits_one_active_per_device":
      return { ok: false, code: "customer_already_queued", message: "This device already holds a spot." };
    case "visits_one_in_progress_per_barber":
    case "visits_one_called_per_barber":
      return { ok: false, code: "barber_busy", message: "Finish with your current customer first." };
    default:
      return null;
  }
}

export class QueueRepo {
  constructor(private readonly pool: pg.Pool) {}

  // ------------------------------------------------------------- reading ---

  private async loadContext(client: PoolClient, barberId: string): Promise<BarberContext | null> {
    const { rows } = await client.query<{
      shop_id: string;
      presence: BarberSnapshot["presence"];
      break_until: Date | null;
      accepting_remote_joins: boolean;
      business_date: string;
      remote_join_cap_per_barber: number;
      call_grace_seconds: number;
      no_show_demotion_places: number;
      max_no_shows_per_visit: number;
      remote_head_grace_seconds: number;
      chair_turnover_seconds: number;
      estimate_min_samples: number;
    }>(
      `select b.shop_id, b.presence, b.break_until, b.accepting_remote_joins,
              ((now() at time zone s.timezone)::date)::text as business_date,
              s.remote_join_cap_per_barber, s.call_grace_seconds,
              s.no_show_demotion_places, s.max_no_shows_per_visit,
              s.remote_head_grace_seconds, s.chair_turnover_seconds,
              s.estimate_min_samples
         from barbers b
         join shops s on s.id = b.shop_id
        where b.id = $1
        for no key update of b`,
      [barberId],
    );
    const row = rows[0];
    if (!row) return null;

    const queue = await this.loadQueue(client, barberId);
    const timings = await this.loadTimings(client, barberId, row.shop_id);

    return {
      shopId: row.shop_id,
      barber: {
        id: barberId,
        presence: row.presence,
        breakUntil: row.break_until,
        acceptingRemoteJoins: row.accepting_remote_joins,
      },
      policy: {
        remoteJoinCapPerBarber: row.remote_join_cap_per_barber,
        callGraceSeconds: row.call_grace_seconds,
        noShowDemotionPlaces: row.no_show_demotion_places,
        maxNoShowsPerVisit: row.max_no_shows_per_visit,
        remoteHeadGraceSeconds: row.remote_head_grace_seconds,
        chairTurnoverSeconds: row.chair_turnover_seconds,
        estimateMinSamples: row.estimate_min_samples,
      },
      queue,
      timings,
      businessDate: row.business_date,
    };
  }

  private async loadQueue(client: PoolClient, barberId: string): Promise<QueueEntry[]> {
    const { rows } = await client.query(
      `select id, customer_id, service_id, status, join_method, priority,
              sort_key, no_show_count, checked_in_at, called_at, started_at, head_since_at
         from visits
        where barber_id = $1 and status = any($2::visit_status[])`,
      [barberId, ACTIVE],
    );
    return rows.map(
      (r): QueueEntry => ({
        id: r.id,
        customerId: r.customer_id,
        serviceId: r.service_id,
        status: r.status,
        joinMethod: r.join_method,
        priority: r.priority,
        sortKey: r.sort_key,
        noShowCount: r.no_show_count,
        checkedInAt: r.checked_in_at,
        calledAt: r.called_at,
        startedAt: r.started_at,
        headSinceAt: r.head_since_at,
      }),
    );
  }

  private async loadTimings(
    client: PoolClient,
    barberId: string,
    shopId: string,
  ): Promise<TimingLookup> {
    const { rows } = await client.query(
      `select s.id, s.default_duration_seconds, a.avg_duration_seconds, a.sample_count
         from services s
         left join barber_service_averages a
           on a.service_id = s.id and a.barber_id = $1
        where s.shop_id = $2`,
      [barberId, shopId],
    );
    const map = new Map<string, ServiceTiming>();
    for (const r of rows) {
      map.set(
        r.id,
        r.avg_duration_seconds === null
          ? { defaultDurationSeconds: r.default_duration_seconds }
          : {
              defaultDurationSeconds: r.default_duration_seconds,
              average: {
                avgDurationSeconds: r.avg_duration_seconds,
                sampleCount: r.sample_count,
              },
            },
      );
    }
    return (serviceId) => map.get(serviceId);
  }

  /** The barber's own queue, with positions and live estimates. */
  async barberQueue(barberId: string) {
    const client = await this.pool.connect();
    try {
      const ctx = await this.loadContext(client, barberId);
      if (!ctx) return null;
      const now = new Date();
      const entries = ctx.queue
        .filter((v) => v.status !== "in_progress")
        .map((v) => ({
          ...v,
          position: positionOf(ctx.queue, v.id),
          waitSeconds: waitFor(v.id, ctx.queue, {
            timings: ctx.timings,
            policy: ctx.policy,
            barber: ctx.barber,
            now,
          })?.seconds ?? null,
        }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

      return {
        barber: ctx.barber,
        inProgress: ctx.queue.find((v) => v.status === "in_progress") ?? null,
        entries,
        checkedInCount: entries.filter((v) => v.status !== "queued_remote").length,
        heldRemotelyCount: entries.filter((v) => v.status === "queued_remote").length,
        waitToJoinSeconds: waitToJoin(ctx.queue, {
          timings: ctx.timings,
          policy: ctx.policy,
          barber: ctx.barber,
          now,
        }).seconds,
      };
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------- joining ---

  async join(input: JoinInput): Promise<JoinAccepted | Rejected> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ctx = await this.loadContext(client, input.barberId);
      if (!ctx) {
        await client.query("rollback");
        return { ok: false, code: "invalid_transition", message: "Barber not found." };
      }

      const { rows: existing } = await client.query(
        `select 1 from visits
          where customer_id = $1 and shop_id = $2 and status = any($3::visit_status[]) limit 1`,
        [input.customerId, ctx.shopId, ACTIVE],
      );

      const now = new Date();
      const plan = planJoin(
        { joinMethod: input.joinMethod },
        {
          now,
          policy: ctx.policy,
          barber: ctx.barber,
          queue: ctx.queue,
          customerHasActiveVisit: existing.length > 0,
        },
      );
      if (!plan.ok) {
        await client.query("rollback");
        return plan;
      }

      const quoted = waitToJoin(ctx.queue, {
        timings: ctx.timings,
        policy: ctx.policy,
        barber: ctx.barber,
        now,
      });

      const { rows } = await client.query<{ id: string }>(
        `insert into visits (shop_id, barber_id, customer_id, service_id, status,
                             join_method, priority, sort_key, business_date,
                             joined_at, checked_in_at, quoted_wait_seconds,
                             created_by_device_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13)
         returning id`,
        [
          ctx.shopId,
          input.barberId,
          input.customerId,
          input.serviceId,
          plan.status,
          input.joinMethod,
          plan.priority,
          plan.sortKey,
          ctx.businessDate,
          now,
          plan.checkedInAt,
          quoted.seconds,
          input.deviceId ?? null,
        ],
      );
      const visitId = rows[0]!.id;

      await this.logEvent(client, {
        visitId,
        shopId: ctx.shopId,
        from: null,
        to: plan.status,
        event: "join",
        actor: { type: "customer", id: input.customerId },
        meta: { joinMethod: input.joinMethod, quotedWaitSeconds: quoted.seconds },
      });

      if (input.impressionId) {
        await client.query(
          `update queue_impressions set converted_visit_id = $1 where id = $2`,
          [visitId, input.impressionId],
        );
      }

      await client.query(
        `insert into barber_customers (barber_id, customer_id, shop_id)
         values ($1,$2,$3) on conflict do nothing`,
        [input.barberId, input.customerId, ctx.shopId],
      );

      await client.query("commit");

      const withNew = await this.barberQueue(input.barberId);
      const position = withNew?.entries.find((e) => e.id === visitId)?.position ?? 1;
      return { ok: true, visitId, position, estimatedWaitSeconds: quoted.seconds };
    } catch (error) {
      await client.query("rollback");
      const mapped = mapConstraint(error);
      if (mapped) return mapped;
      throw error;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------- transitions ---

  /** Runs one event against one visit under the barber's lock. */
  async apply(
    visitId: string,
    event: QueueEvent,
    actor: Actor,
  ): Promise<TransitionAccepted | Rejected> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ barber_id: string }>(
        `select barber_id from visits where id = $1`,
        [visitId],
      );
      const barberId = rows[0]?.barber_id;
      if (!barberId) {
        await client.query("rollback");
        return NOT_FOUND;
      }

      const ctx = await this.loadContext(client, barberId);
      const visit = ctx?.queue.find((v) => v.id === visitId);
      if (!ctx || !visit) {
        await client.query("rollback");
        return NOT_FOUND;
      }

      const result = transition(visit, event, {
        now: new Date(),
        policy: ctx.policy,
        barber: ctx.barber,
        queue: ctx.queue,
      });
      if (!result.ok) {
        await client.query("rollback");
        return result;
      }

      await this.persist(client, ctx, visit, result, actor);
      await client.query("commit");
      return { ok: true, visitId, from: result.from, to: result.to };
    } catch (error) {
      await client.query("rollback");
      const mapped = mapConstraint(error);
      if (mapped) return mapped;
      throw error;
    } finally {
      client.release();
    }
  }

  /** "Call next" — acts on whoever is genuinely callable, never on the raw head. */
  async callNext(barberId: string, actor: Actor): Promise<TransitionAccepted | Rejected> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ctx = await this.loadContext(client, barberId);
      if (!ctx) {
        await client.query("rollback");
        return { ok: false, code: "invalid_transition", message: "Barber not found." };
      }
      const next = callable(ctx.queue);
      if (!next) {
        await client.query("rollback");
        return {
          ok: false,
          code: "not_callable",
          message: "Nobody in the queue has arrived yet.",
        };
      }
      const result = transition(next, { type: "call_next" }, {
        now: new Date(),
        policy: ctx.policy,
        barber: ctx.barber,
        queue: ctx.queue,
      });
      if (!result.ok) {
        await client.query("rollback");
        return result;
      }
      await this.persist(client, ctx, next, result, actor);
      await client.query("commit");
      return { ok: true, visitId: next.id, from: result.from, to: result.to };
    } catch (error) {
      await client.query("rollback");
      const mapped = mapConstraint(error);
      if (mapped) return mapped;
      throw error;
    } finally {
      client.release();
    }
  }

  private async persist(
    client: PoolClient,
    ctx: BarberContext,
    visit: QueueEntry,
    result: Accepted,
    actor: Actor,
  ): Promise<void> {
    const { sets, values } = buildPatch(result.patch);
    values.push(visit.id);
    await client.query(
      `update visits set ${sets.join(", ")} where id = $${values.length}`,
      values,
    );

    await this.logEvent(client, {
      visitId: visit.id,
      shopId: ctx.shopId,
      from: result.from,
      to: result.to,
      event: result.event,
      actor,
      meta: {
        bookkeepingOnly: result.bookkeepingOnly,
        ...(result.patch.sortKey !== undefined ? { demotedTo: result.patch.sortKey } : {}),
        ...(result.patch.noShowCount !== undefined
          ? { noShowCount: result.patch.noShowCount }
          : {}),
      },
    });

    for (const effect of result.effects) {
      await this.applyEffect(client, ctx, visit, effect);
    }
  }

  private async applyEffect(
    client: PoolClient,
    ctx: BarberContext,
    visit: QueueEntry,
    effect: SideEffect,
  ): Promise<void> {
    switch (effect.kind) {
      case "increment_no_shows":
        await client.query(
          `update barber_customers set no_show_count = no_show_count + 1
            where barber_id = $1 and customer_id = $2`,
          [ctx.barber.id, visit.customerId],
        );
        return;

      case "increment_cancellations":
        await client.query(
          `update barber_customers set cancelled_count = cancelled_count + 1
            where barber_id = $1 and customer_id = $2`,
          [ctx.barber.id, visit.customerId],
        );
        return;

      case "record_completion": {
        const { rows } = await client.query<{ actual: number | null }>(
          `select actual_duration_seconds as actual from visits where id = $1`,
          [visit.id],
        );
        const actual = rows[0]?.actual ?? null;
        const timing = ctx.timings(visit.serviceId);
        if (actual !== null && timing) {
          const current = timing.average ?? {
            avgDurationSeconds: timing.defaultDurationSeconds,
            sampleCount: 0,
          };
          const next = updateAverage(current, actual);
          if (next.accepted) {
            await client.query(
              `insert into barber_service_averages
                 (barber_id, service_id, shop_id, avg_duration_seconds, sample_count, updated_at)
               values ($1,$2,$3,$4,$5, now())
               on conflict (barber_id, service_id) do update
                 set avg_duration_seconds = excluded.avg_duration_seconds,
                     sample_count = excluded.sample_count,
                     updated_at = now()`,
              [ctx.barber.id, visit.serviceId, ctx.shopId, next.avgDurationSeconds, next.sampleCount],
            );
          } else {
            // Rejected as a mistap. Recorded so it is visible, never averaged.
            await this.logEvent(client, {
              visitId: visit.id,
              shopId: ctx.shopId,
              from: "in_progress",
              to: "completed",
              event: "duration_outlier_rejected",
              actor: { type: "system" },
              meta: { actualDurationSeconds: actual },
            });
          }
        }
        await client.query(
          `insert into barber_customers
             (barber_id, customer_id, shop_id, first_visit_at, last_visit_at, visit_count)
           values ($1,$2,$3, now(), now(), 1)
           on conflict (barber_id, customer_id) do update
             set visit_count    = barber_customers.visit_count + 1,
                 last_visit_at  = now(),
                 first_visit_at = coalesce(barber_customers.first_visit_at, now())`,
          [ctx.barber.id, visit.customerId, ctx.shopId],
        );
        return;
      }
    }
  }

  private async logEvent(
    client: PoolClient,
    e: {
      visitId: string;
      shopId: string;
      from: VisitStatus | null;
      to: VisitStatus;
      event: string;
      actor: Actor;
      meta: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `insert into visit_events (visit_id, shop_id, from_status, to_status, event, actor, actor_id, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [e.visitId, e.shopId, e.from, e.to, e.event, e.actor.type, e.actor.id ?? null, JSON.stringify(e.meta)],
    );
  }

  // -------------------------------------------------------------- sweeps ---

  /**
   * Time-driven transitions: expired call grace, and remote customers who never
   * arrived. Safe to run every minute; every decision is re-derived from state.
   */
  async sweep(shopId: string): Promise<{ noShows: number; noArrivals: number; timersArmed: number }> {
    const counts = { noShows: 0, noArrivals: 0, timersArmed: 0 };
    const { rows: barbers } = await this.pool.query<{ id: string }>(
      `select id from barbers where shop_id = $1 and active`,
      [shopId],
    );

    for (const { id: barberId } of barbers) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const ctx = await this.loadContext(client, barberId);
        if (!ctx) {
          await client.query("rollback");
          continue;
        }

        const stale = staleHeadTimers(ctx.barber, ctx.queue);
        if (stale.length > 0) {
          await client.query(
            `update visits set head_since_at = null where id = any($1::uuid[])`,
            [stale],
          );
          for (const entry of ctx.queue) {
            if (stale.includes(entry.id)) entry.headSinceAt = null;
          }
        }

        const now = new Date();
        const called = ctx.queue.find((v) => v.status === "called");
        if (called) {
          const result = transition(called, { type: "no_show", reason: "grace_expired" }, {
            now,
            policy: ctx.policy,
            barber: ctx.barber,
            queue: ctx.queue,
          });
          if (result.ok) {
            await this.persist(client, ctx, called, result, { type: "system" });
            counts.noShows += 1;
          }
        } else {
          const first = head(ctx.queue);
          if (first && first.status === "queued_remote") {
            const result = transition(first, { type: "no_arrival" }, {
              now,
              policy: ctx.policy,
              barber: ctx.barber,
              queue: ctx.queue,
            });
            if (result.ok) {
              await this.persist(client, ctx, first, result, { type: "system" });
              if (result.bookkeepingOnly) counts.timersArmed += 1;
              else counts.noArrivals += 1;
            }
          }
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return counts;
  }

  /** End of the business day: nothing stays active overnight. */
  async closeOut(shopId: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; barber_id: string }>(
      `select id, barber_id from visits
        where shop_id = $1 and status = any($2::visit_status[])`,
      [shopId, ACTIVE],
    );
    let closed = 0;
    for (const row of rows) {
      const result = await this.apply(row.id, { type: "close_out" }, { type: "system" });
      if (result.ok) closed += 1;
    }
    return closed;
  }
}

const PATCH_COLUMNS: Record<keyof VisitPatch, string> = {
  status: "status",
  outcome: "outcome",
  checkedInAt: "checked_in_at",
  calledAt: "called_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  endedAt: "ended_at",
  sortKey: "sort_key",
  noShowCount: "no_show_count",
  headSinceAt: "head_since_at",
};

function buildPatch(patch: VisitPatch): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof VisitPatch, string][]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}${key === "status" ? "::visit_status" : ""}${key === "outcome" ? "::visit_outcome" : ""}`);
  }
  return { sets, values };
}
