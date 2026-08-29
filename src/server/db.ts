import "server-only";
import pg from "pg";
import { QueueRepo } from "../db/queue-repo";

const { Pool, types } = pg;
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

function sslFor(connectionString: string): pg.PoolConfig["ssl"] {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (local || connectionString.includes("sslmode=disable")) return false;
  // Managed Postgres (Railway, Neon, Supabase) terminates TLS with a chain the
  // Node runtime does not carry. Encrypted, but not certificate-pinned.
  return { rejectUnauthorized: false };
}

// Next.js reloads modules in development; without a global the pool would leak
// a new set of connections on every edit.
const globalForDb = globalThis as unknown as { __pool?: pg.Pool };

export function getPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. On Vercel add it under Project Settings > Environment Variables, pointing at the Railway database.",
    );
  }
  globalForDb.__pool ??= new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 5, // serverless: many instances, few connections each
    idleTimeoutMillis: 10_000,
  });
  return globalForDb.__pool;
}

export function getRepo(): QueueRepo {
  return new QueueRepo(getPool());
}

/** v1 runs one shop. shop_id scoping already exists everywhere else. */
export async function currentShopId(): Promise<string> {
  if (process.env.SHOP_ID) return process.env.SHOP_ID;
  const { rows } = await getPool().query<{ id: string }>(
    `select id from shops order by created_at limit 1`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("No shop exists yet. Run `npm run seed`.");
  return id;
}

export type DatabaseStatus = "ready" | "no_url" | "unreachable" | "no_schema" | "no_shop";

/**
 * Why the app cannot serve, in terms an operator can act on.
 *
 * A platform that runs a start command migrates itself (see package.json), but
 * a serverless deploy has no start step — so an un-migrated database has to
 * produce a usable message rather than `relation "shops" does not exist`.
 */
export async function databaseStatus(): Promise<DatabaseStatus> {
  if (!process.env.DATABASE_URL) return "no_url";
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `select id from shops order by created_at limit 1`,
    );
    return rows[0] ? "ready" : "no_shop";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01") return "no_schema"; // undefined_table
    if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(code ?? "")) return "unreachable";
    throw error;
  }
}
