import "server-only";
import { unstable_noStore as noStore } from "next/cache";
import { getPool, getRepo } from "./db";
import { orderQueue, positionOf } from "../domain/order";
import { waitFor, waitToJoin, type ServiceTiming, type TimingLookup } from "../domain/estimate";
import { publicStatus, type BarberSnapshot, type PublicStatus, type QueueEntry, type ShopPolicy } from "../domain/types";
import { remoteHoldCount } from "../domain/machine";

export interface ShopRow {
  id: string;
  name: string;
  policy: ShopPolicy;
}

export interface BarberCard {
  id: string;
  name: string;
  profileImageUrl: string | null;
  status: PublicStatus;
  breakUntil: Date | null;
  acceptingRemoteJoins: boolean;
  remoteSlotsLeft: number;
  peopleWaiting: number;
  waitSeconds: number | null;
}

export interface ServiceOption {
  id: string;
  code: string;
  displayName: string;
  defaultDurationSeconds: number;
  priceCents: number;
}

/** Everything the customer-facing list needs, in one round trip. */
export async function shopOverview(shopId: string): Promise<{
  shop: ShopRow;
  barbers: BarberCard[];
  services: ServiceOption[];
}> {
  noStore();
  const pool = getPool();

  const [shopRes, barberRes, serviceRes, visitRes, avgRes] = await Promise.all([
    pool.query(`select * from shops where id = $1`, [shopId]),
    pool.query(
      `select id, name, profile_image_url, presence, break_until, accepting_remote_joins
         from barbers where shop_id = $1 and active order by sort_order, name`,
      [shopId],
    ),
    pool.query(
      `select id, code, display_name, default_duration_seconds, price_cents
         from services where shop_id = $1 and active order by sort_order`,
      [shopId],
    ),
    pool.query(
      `select id, barber_id, customer_id, service_id, status, join_method, priority,
              sort_key, no_show_count, checked_in_at, called_at, started_at, head_since_at
         from visits
        where shop_id = $1
          and status in ('queued_remote','queued_present','called','in_progress')`,
      [shopId],
    ),
    pool.query(
      `select barber_id, service_id, avg_duration_seconds, sample_count
         from barber_service_averages where shop_id = $1`,
      [shopId],
    ),
  ]);

  const s = shopRes.rows[0];
  if (!s) throw new Error("Shop not found.");
  const policy: ShopPolicy = {
    remoteJoinCapPerBarber: s.remote_join_cap_per_barber,
    callGraceSeconds: s.call_grace_seconds,
    noShowDemotionPlaces: s.no_show_demotion_places,
    maxNoShowsPerVisit: s.max_no_shows_per_visit,
    remoteHeadGraceSeconds: s.remote_head_grace_seconds,
    chairTurnoverSeconds: s.chair_turnover_seconds,
    estimateMinSamples: s.estimate_min_samples,
  };

  const services: ServiceOption[] = serviceRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    defaultDurationSeconds: r.default_duration_seconds,
    priceCents: r.price_cents,
  }));

  const now = new Date();
  const byBarber = new Map<string, QueueEntry[]>();
  for (const r of visitRes.rows) {
    const list = byBarber.get(r.barber_id) ?? [];
    list.push(toEntry(r));
    byBarber.set(r.barber_id, list);
  }

  const barbers: BarberCard[] = barberRes.rows.map((b) => {
    const queue = byBarber.get(b.id) ?? [];
    const snapshot: BarberSnapshot = {
      id: b.id,
      presence: b.presence,
      breakUntil: b.break_until,
      acceptingRemoteJoins: b.accepting_remote_joins,
    };
    const status = publicStatus(snapshot, queue);
    const timings = timingLookup(services, avgRes.rows, b.id);
    return {
      id: b.id,
      name: b.name,
      profileImageUrl: b.profile_image_url,
      status,
      breakUntil: b.break_until,
      acceptingRemoteJoins: b.accepting_remote_joins,
      remoteSlotsLeft: Math.max(0, policy.remoteJoinCapPerBarber - remoteHoldCount(queue)),
      peopleWaiting: orderQueue(queue).length,
      waitSeconds:
        status === "off"
          ? null
          : waitToJoin(queue, { timings, policy, barber: snapshot, now }).seconds,
    };
  });

  return { shop: { id: s.id, name: s.name, policy }, barbers, services };
}

export interface VisitView {
  id: string;
  status: QueueEntry["status"];
  joinMethod: QueueEntry["joinMethod"];
  barberId: string;
  barberName: string;
  serviceName: string;
  customerFirstName: string;
  position: number | null;
  waitSeconds: number | null;
  wrappingUp: boolean;
  canCheckIn: boolean;
}

/** The customer's own live view of where they stand. */
export async function visitView(visitId: string): Promise<VisitView | null> {
  noStore();
  const pool = getPool();
  const { rows } = await pool.query(
    `select v.id, v.barber_id, v.shop_id, v.status, v.join_method,
            b.name as barber_name, b.presence, b.break_until, b.accepting_remote_joins,
            sv.display_name as service_name, c.first_name
       from visits v
       join barbers b   on b.id = v.barber_id
       join services sv on sv.id = v.service_id
       join customers c on c.id = v.customer_id
      where v.id = $1`,
    [visitId],
  );
  const row = rows[0];
  if (!row) return null;

  const overview = await shopQueueFor(row.shop_id, row.barber_id);
  const position = positionOf(overview.queue, visitId);
  const estimate = waitFor(visitId, overview.queue, {
    timings: overview.timings,
    policy: overview.policy,
    barber: overview.barber,
    now: new Date(),
  });

  return {
    id: row.id,
    status: row.status,
    joinMethod: row.join_method,
    barberId: row.barber_id,
    barberName: row.barber_name,
    serviceName: row.service_name,
    customerFirstName: row.first_name,
    position,
    waitSeconds: estimate?.seconds ?? null,
    wrappingUp: estimate?.wrappingUp ?? false,
    canCheckIn: row.status === "queued_remote",
  };
}

export interface DashboardEntry {
  id: string;
  position: number;
  displayName: string;
  serviceName: string;
  status: QueueEntry["status"];
  joinMethod: QueueEntry["joinMethod"];
  waitSeconds: number | null;
  noShowCount: number;
  visitCount: number;
}

export interface Dashboard {
  barber: { id: string; name: string; presence: BarberSnapshot["presence"]; breakUntil: Date | null; acceptingRemoteJoins: boolean };
  nextUp: DashboardEntry | null;
  callableId: string | null;
  inChair: (DashboardEntry & { startedAt: Date | null }) | null;
  called: DashboardEntry | null;
  queue: DashboardEntry[];
  checkedInCount: number;
  heldRemotelyCount: number;
  /** What a customer walking in right now would be quoted. */
  waitToJoinSeconds: number;
}

/**
 * A barber sees only their own queue. No phone numbers, no other barber's
 * customers, no cross-barber metrics — that is the whole point of the model.
 */
export async function dashboard(barberId: string): Promise<Dashboard | null> {
  noStore();
  const pool = getPool();
  const { rows: barberRows } = await pool.query(
    `select id, shop_id, name, presence, break_until, accepting_remote_joins
       from barbers where id = $1`,
    [barberId],
  );
  const b = barberRows[0];
  if (!b) return null;

  const view = await shopQueueFor(b.shop_id, barberId);
  const { rows: display } = await pool.query(
    `select v.id, c.first_name, c.last_name, sv.display_name as service_name,
            coalesce(bc.visit_count, 0) as visit_count
       from visits v
       join customers c  on c.id = v.customer_id
       join services sv  on sv.id = v.service_id
       left join barber_customers bc
         on bc.barber_id = v.barber_id and bc.customer_id = v.customer_id
      where v.barber_id = $1
        and v.status in ('queued_remote','queued_present','called','in_progress')`,
    [barberId],
  );
  const info = new Map(display.map((r) => [r.id, r]));
  const now = new Date();

  const toEntryView = (v: QueueEntry): DashboardEntry => {
    const meta = info.get(v.id);
    const last = meta?.last_name ? ` ${String(meta.last_name)[0]!.toUpperCase()}.` : "";
    return {
      id: v.id,
      position: positionOf(view.queue, v.id) ?? 0,
      displayName: `${meta?.first_name ?? "Customer"}${last}`,
      serviceName: meta?.service_name ?? "",
      status: v.status,
      joinMethod: v.joinMethod,
      waitSeconds:
        waitFor(v.id, view.queue, { timings: view.timings, policy: view.policy, barber: view.barber, now })
          ?.seconds ?? null,
      noShowCount: v.noShowCount,
      visitCount: meta?.visit_count ?? 0,
    };
  };

  const line = orderQueue(view.queue);
  const inProgress = view.queue.find((v) => v.status === "in_progress");
  const calledEntry = view.queue.find((v) => v.status === "called");
  const waiting = line.filter((v) => v.status !== "called");

  return {
    barber: {
      id: b.id,
      name: b.name,
      presence: b.presence,
      breakUntil: b.break_until,
      acceptingRemoteJoins: b.accepting_remote_joins,
    },
    nextUp: line[0] ? toEntryView(line[0]) : null,
    callableId: line.find((v) => v.status === "queued_present")?.id ?? null,
    inChair: inProgress
      ? { ...toEntryView(inProgress), startedAt: inProgress.startedAt }
      : null,
    called: calledEntry ? toEntryView(calledEntry) : null,
    queue: waiting.map(toEntryView),
    checkedInCount: waiting.filter((v) => v.status !== "queued_remote").length,
    heldRemotelyCount: waiting.filter((v) => v.status === "queued_remote").length,
    waitToJoinSeconds: waitToJoin(view.queue, {
      timings: view.timings,
      policy: view.policy,
      barber: view.barber,
      now,
    }).seconds,
  };
}

/** Runs the time-driven sweep, then reports what it did. Safe to call often. */
export async function tick(shopId: string) {
  return getRepo().sweep(shopId);
}

// ------------------------------------------------------------- internals ---

function toEntry(r: Record<string, unknown>): QueueEntry {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    serviceId: r.service_id as string,
    status: r.status as QueueEntry["status"],
    joinMethod: r.join_method as QueueEntry["joinMethod"],
    priority: r.priority as number,
    sortKey: r.sort_key as number,
    noShowCount: r.no_show_count as number,
    checkedInAt: r.checked_in_at as Date | null,
    calledAt: r.called_at as Date | null,
    startedAt: r.started_at as Date | null,
    headSinceAt: r.head_since_at as Date | null,
  };
}

function timingLookup(
  services: ServiceOption[],
  averages: Array<{ barber_id: string; service_id: string; avg_duration_seconds: number; sample_count: number }>,
  barberId: string,
): TimingLookup {
  const map = new Map<string, ServiceTiming>();
  for (const s of services) map.set(s.id, { defaultDurationSeconds: s.defaultDurationSeconds });
  for (const a of averages) {
    if (a.barber_id !== barberId) continue;
    const base = map.get(a.service_id);
    if (!base) continue;
    map.set(a.service_id, {
      defaultDurationSeconds: base.defaultDurationSeconds,
      average: { avgDurationSeconds: a.avg_duration_seconds, sampleCount: a.sample_count },
    });
  }
  return (id) => map.get(id);
}

async function shopQueueFor(shopId: string, barberId: string) {
  const pool = getPool();
  const [shopRes, barberRes, serviceRes, visitRes, avgRes] = await Promise.all([
    pool.query(`select * from shops where id = $1`, [shopId]),
    pool.query(`select id, presence, break_until, accepting_remote_joins from barbers where id = $1`, [barberId]),
    pool.query(
      `select id, code, display_name, default_duration_seconds, price_cents
         from services where shop_id = $1`,
      [shopId],
    ),
    pool.query(
      `select id, barber_id, customer_id, service_id, status, join_method, priority,
              sort_key, no_show_count, checked_in_at, called_at, started_at, head_since_at
         from visits
        where barber_id = $1
          and status in ('queued_remote','queued_present','called','in_progress')`,
      [barberId],
    ),
    pool.query(
      `select barber_id, service_id, avg_duration_seconds, sample_count
         from barber_service_averages where barber_id = $1`,
      [barberId],
    ),
  ]);
  const s = shopRes.rows[0]!;
  const b = barberRes.rows[0]!;
  const services: ServiceOption[] = serviceRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    defaultDurationSeconds: r.default_duration_seconds,
    priceCents: r.price_cents,
  }));
  return {
    policy: {
      remoteJoinCapPerBarber: s.remote_join_cap_per_barber,
      callGraceSeconds: s.call_grace_seconds,
      noShowDemotionPlaces: s.no_show_demotion_places,
      maxNoShowsPerVisit: s.max_no_shows_per_visit,
      remoteHeadGraceSeconds: s.remote_head_grace_seconds,
      chairTurnoverSeconds: s.chair_turnover_seconds,
      estimateMinSamples: s.estimate_min_samples,
    } satisfies ShopPolicy,
    barber: {
      id: b.id,
      presence: b.presence,
      breakUntil: b.break_until,
      acceptingRemoteJoins: b.accepting_remote_joins,
    } satisfies BarberSnapshot,
    queue: visitRes.rows.map(toEntry),
    timings: timingLookup(services, avgRes.rows, barberId),
    services,
  };
}
