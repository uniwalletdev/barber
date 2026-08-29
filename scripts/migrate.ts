import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import "dotenv/config";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url).pathname;

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      // Each migration file opens its own transaction.
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return applied;
}

export async function seed(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const sql = await readFile(new URL("../db/seed/dev.sql", import.meta.url).pathname, "utf8");
    await client.query(sql);

    // Development PINs. Hashing needs Node, so it cannot live in the SQL file.
    // Only ever applied to barbers that have no PIN set.
    const { hashPin } = await import("../src/domain/pin");
    const { rows } = await client.query<{ id: string }>(
      "select id from barbers where pin_hash is null",
    );
    for (const row of rows) {
      await client.query("update barbers set pin_hash = $2 where id = $1", [
        row.id,
        await hashPin("1234"),
      ]);
    }
    if (rows.length > 0) {
      console.log(`Set the development PIN 1234 on ${rows.length} barber(s). Change it before real use.`);
    }
  } finally {
    await client.end();
  }
}

const isEntrypoint = process.argv[1]?.endsWith("migrate.ts");
if (isEntrypoint) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.");
    process.exit(1);
  }
  let applied: string[];
  try {
    applied = await migrate(url);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      console.error(
        `Cannot reach the database at ${url.replace(/:[^:@/]*@/, ":***@")}\n` +
          "  - On Vercel: check DATABASE_URL is set for this environment and uses the\n" +
          "    Railway public connection string, not the internal one.\n" +
          "  - Locally: is Postgres running?",
      );
      process.exit(1);
    }
    throw error;
  }
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
  if (process.argv.includes("--seed")) {
    await seed(url);
    console.log("Seeded development data.");
  }
}
