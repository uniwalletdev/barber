import "server-only";
import { unstable_noStore as noStore } from "next/cache";
import { getPool } from "./db";

/**
 * Owner view: shop-wide aggregates only. No per-barber drill-down and no
 * client-level detail — in a chair-renter shop those belong to the barber.
 */
export interface OwnerMetrics {
  servedToday: number;
  servedAllTime: number;
  waitingNow: number;
  averageServiceMinutes: number | null;
  /** Looks at the wait, joins anyway. */
  impressionsToday: number;
  conversionsToday: number;
  walkOutsToday: number;
  averageTicketCents: number;
  recoveredCents: number;
  lostCents: number;
  quoteAccuracy: { samples: number; medianErrorMinutes: number | null };
}

export async function ownerMetrics(shopId: string): Promise<OwnerMetrics> {
  noStore();
  const pool = getPool();
  const today = `(now() at time zone (select timezone from shops where id = $1))::date`;

  const [served, waiting, impressions, ticket, recovered, accuracy] = await Promise.all([
    pool.query(
      `select
         count(*) filter (where business_date = ${today}) as today,
         count(*) as all_time,
         -- Same plausibility band the estimator learns from, so a cut the
         -- barber forgot to close does not quietly move the shop average.
         avg(actual_duration_seconds) filter (
           where actual_duration_seconds between 240 and 5400
         ) as avg_seconds
       from visits where shop_id = $1 and status = 'completed'`,
      [shopId],
    ),
    pool.query(
      `select count(*) as n from visits
        where shop_id = $1
          and status in ('queued_remote','queued_present','called','in_progress')`,
      [shopId],
    ),
    pool.query(
      `select count(*) as shown,
              count(converted_visit_id) as converted
         from queue_impressions
        where shop_id = $1 and business_date = ${today}`,
      [shopId],
    ),
    // Prefer what customers actually bought; before the first cut is completed,
    // fall back to the price list so the lost-revenue figure is not stuck at $0.
    pool.query(
      `select coalesce(
                (select avg(sv.price_cents)
                   from visits v join services sv on sv.id = v.service_id
                  where v.shop_id = $1 and v.status = 'completed'),
                (select avg(price_cents) from services where shop_id = $1 and active),
                0
              )::int as avg_ticket`,
      [shopId],
    ),
    // The conservative reading of "recovered": customers who saw the wait and
    // held a spot from their phone instead of walking away, and were served.
    pool.query(
      `select coalesce(sum(sv.price_cents), 0)::int as cents
         from visits v join services sv on sv.id = v.service_id
        where v.shop_id = $1 and v.status = 'completed'
          and v.join_method = 'remote' and v.business_date = ${today}`,
      [shopId],
    ),
    // How good the quote was: promised wait vs. what they actually waited.
    pool.query(
      `select count(*) as n,
              percentile_cont(0.5) within group (
                order by abs(extract(epoch from (started_at - joined_at)) - quoted_wait_seconds)
              ) as median_error
         from visits
        where shop_id = $1 and started_at is not null and quoted_wait_seconds is not null`,
      [shopId],
    ),
  ]);

  const shown = Number(impressions.rows[0]?.shown ?? 0);
  const converted = Number(impressions.rows[0]?.converted ?? 0);
  const walkOuts = Math.max(0, shown - converted);
  const averageTicketCents = Number(ticket.rows[0]?.avg_ticket ?? 0);
  const medianError = accuracy.rows[0]?.median_error;

  return {
    servedToday: Number(served.rows[0]?.today ?? 0),
    servedAllTime: Number(served.rows[0]?.all_time ?? 0),
    waitingNow: Number(waiting.rows[0]?.n ?? 0),
    averageServiceMinutes: served.rows[0]?.avg_seconds
      ? Math.round(Number(served.rows[0].avg_seconds) / 60)
      : null,
    impressionsToday: shown,
    conversionsToday: converted,
    walkOutsToday: walkOuts,
    averageTicketCents,
    recoveredCents: Number(recovered.rows[0]?.cents ?? 0),
    lostCents: walkOuts * averageTicketCents,
    quoteAccuracy: {
      samples: Number(accuracy.rows[0]?.n ?? 0),
      medianErrorMinutes: medianError === null || medianError === undefined
        ? null
        : Math.round(Number(medianError) / 60),
    },
  };
}

/**
 * Records that someone looked at the queue. A customer who sees a long wait and
 * leaves creates no other row anywhere, so this is the only evidence the shop's
 * central problem ever existed. Cannot be backfilled.
 */
export async function recordImpression(input: {
  shopId: string;
  barberId?: string | null;
  source: "kiosk" | "web";
  quotedWaitSeconds: number;
  deviceTokenHash?: string | null;
}): Promise<string> {
  const pool = getPool();

  // One look, not one page load. A customer who reloads while deciding is still
  // the same decision; counting each reload would inflate walk-outs without
  // bound. A genuine return trip half an hour later falls outside the window.
  if (input.deviceTokenHash) {
    const { rows: recent } = await pool.query<{ id: string }>(
      `select id from queue_impressions
        where shop_id = $1 and device_token_hash = $2
          and converted_visit_id is null
          and shown_at > now() - interval '10 minutes'
        order by shown_at desc limit 1`,
      [input.shopId, input.deviceTokenHash],
    );
    const existing = recent[0]?.id;
    if (existing) {
      await pool.query(`update queue_impressions set quoted_wait_seconds = $2 where id = $1`, [
        existing,
        input.quotedWaitSeconds,
      ]);
      return existing;
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `insert into queue_impressions
       (shop_id, barber_id, source, quoted_wait_seconds, device_token_hash, business_date)
     values ($1,$2,$3,$4,$5, (now() at time zone (select timezone from shops where id = $1))::date)
     returning id`,
    [
      input.shopId,
      input.barberId ?? null,
      input.source,
      input.quotedWaitSeconds,
      input.deviceTokenHash ?? null,
    ],
  );
  return rows[0]!.id;
}
