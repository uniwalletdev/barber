import pg from "pg";

const { Pool, types } = pg;

// Postgres returns bigint and numeric as strings to avoid silent precision
// loss. sort_key is double precision so it already arrives as a number; these
// two keep counters arriving as numbers rather than strings.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export type { Pool as PgPool, PoolClient } from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString, max: 10 });
}
