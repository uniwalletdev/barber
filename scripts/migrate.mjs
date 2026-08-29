// Plain JavaScript on purpose.
//
// This runs at container start, where the platform has installed production
// dependencies only (`npm ci --omit=dev`). tsx and typescript are dev
// dependencies and are not there, so the migration runner cannot need them.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const SEED_FILE = fileURLToPath(new URL("../db/seed/dev.sql", import.meta.url));

/** Managed Postgres terminates TLS with a chain the Node runtime does not carry. */
function sslFor(connectionString) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (local || connectionString.includes("sslmode=disable")) return false;
  return { rejectUnauthorized: false };
}

function connect(connectionString) {
  return new Client({ connectionString, ssl: sslFor(connectionString) });
}

export async function migrate(connectionString) {
  const client = connect(connectionString);
  await client.connect();
  const applied = [];
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await client.query(
        "select 1 from schema_migrations where name = $1",
        [file],
      );
      if (rowCount) continue;
      // Each migration file opens its own transaction.
      await client.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return applied;
}

export async function seed(connectionString) {
  const client = connect(connectionString);
  await client.connect();
  try {
    await client.query(await readFile(SEED_FILE, "utf8"));
  } finally {
    await client.end();
  }
}

const isEntrypoint = process.argv[1]?.endsWith("migrate.mjs");
if (isEntrypoint) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set, so there is no database to migrate.\n" +
        "  - Railway: add a Postgres service and reference it as ${{Postgres.DATABASE_URL}}.\n" +
        "  - Locally: copy .env.example to .env.",
    );
    process.exit(1);
  }

  const redacted = url.replace(/:[^:@/]*@/, ":***@");
  try {
    const applied = await migrate(url);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Schema already up to date.");
    if (process.argv.includes("--seed")) {
      await seed(url);
      console.log("Seeded development data.");
    }
  } catch (error) {
    if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(error?.code)) {
      console.error(
        `Cannot reach the database at ${redacted}\n` +
          "  - Vercel: DATABASE_URL must be the Railway PUBLIC connection string;\n" +
          "    the .railway.internal host is only reachable from inside Railway.\n" +
          "  - Locally: is Postgres running?",
      );
      process.exit(1);
    }
    throw error;
  }
}
