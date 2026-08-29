import pg from "pg";
import { migrate } from "../scripts/migrate.mjs";
import type { QueueEntry, VisitStatus } from "../src/domain/types";

export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://barber:barber@127.0.0.1:5432/barber_test";

// These tests truncate every table between cases. Refuse to run against a
// database that is not obviously a scratch one, so a stray DATABASE_URL in the
// environment cannot wipe the shop's real queue.
const databaseName = DATABASE_URL.split("/").pop()?.split("?")[0] ?? "";
if (!/test/i.test(databaseName) && process.env.ALLOW_DESTRUCTIVE_TESTS !== "1") {
  throw new Error(
    `Refusing to run destructive tests against database "${databaseName}". ` +
      `Point TEST_DATABASE_URL at a scratch database, or set ALLOW_DESTRUCTIVE_TESTS=1 if you are certain.`,
  );
}

let migrated = false;

export async function testPool(): Promise<pg.Pool> {
  if (!migrated) {
    await migrate(DATABASE_URL);
    migrated = true;
  }
  return new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
}

export async function reset(pool: pg.Pool): Promise<void> {
  await pool.query(`
    truncate visit_events, queue_impressions, appointments, visits,
             barber_service_averages, barber_customers, customer_devices,
             customers, services, barbers, shops
    restart identity cascade
  `);
}

export interface Fixture {
  shopId: string;
  barberId: string;
  otherBarberId: string;
  adultCut: string;
  kidsCut: string;
  customers: string[];
  deviceFor(customerId: string): Promise<string>;
  pool: pg.Pool;
}

export async function seedShop(pool: pg.Pool, customerCount = 6): Promise<Fixture> {
  const { rows: [shop] } = await pool.query(
    `insert into shops (name, timezone) values ('Fade Room', 'UTC') returning id`,
  );
  const shopId = shop.id as string;

  const service = async (code: string, name: string, seconds: number, price: number) => {
    const { rows } = await pool.query(
      `insert into services (shop_id, code, display_name, default_duration_seconds, price_cents)
       values ($1,$2,$3,$4,$5) returning id`,
      [shopId, code, name, seconds, price],
    );
    return rows[0].id as string;
  };
  // Placeholder durations: the real service list is still outstanding from the
  // shop owner (design 4-I). Adult cut is the one figure the brief fixed.
  const adultCut = await service("adult_cut", "Adult cut", 35 * 60, 3500);
  const kidsCut = await service("kids_cut", "Kids cut", 45 * 60, 3000);

  const barber = async (name: string, phone: string) => {
    const { rows } = await pool.query(
      `insert into barbers (shop_id, name, phone_number, presence)
       values ($1,$2,$3,'available') returning id`,
      [shopId, name, phone],
    );
    return rows[0].id as string;
  };
  const barberId = await barber("Dre", "+15550000001");
  const otherBarberId = await barber("Kemi", "+15550000002");

  const customers: string[] = [];
  for (let i = 0; i < customerCount; i++) {
    const { rows } = await pool.query(
      `insert into customers (phone_number, first_name, last_name)
       values ($1,$2,$3) returning id`,
      [`+1555100${String(i).padStart(4, "0")}`, `Cust${i}`, `L${i}`],
    );
    customers.push(rows[0].id as string);
  }

  return {
    shopId,
    barberId,
    otherBarberId,
    adultCut,
    kidsCut,
    customers,
    pool,
    async deviceFor(customerId: string) {
      const { rows } = await pool.query(
        `insert into customer_devices (customer_id, token_hash) values ($1,$2) returning id`,
        [customerId, `hash-${customerId}-${Math.random()}`],
      );
      return rows[0].id as string;
    },
  };
}

/** Builds a QueueEntry for the pure tests. */
export function entry(overrides: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    customerId: `cust-${overrides.id}`,
    serviceId: "adult",
    status: "queued_present" as VisitStatus,
    joinMethod: "walk_in",
    priority: 0,
    sortKey: 0,
    noShowCount: 0,
    checkedInAt: new Date(),
    calledAt: null,
    startedAt: null,
    headSinceAt: null,
    ...overrides,
  };
}
