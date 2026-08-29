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
  const applied = await migrate(url);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
  if (process.argv.includes("--seed")) {
    await seed(url);
    console.log("Seeded development data.");
  }
}
