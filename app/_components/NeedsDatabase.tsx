import type { DatabaseStatus } from "@/src/server/db";

const MESSAGES: Record<Exclude<DatabaseStatus, "ready">, { title: string; body: string; fix: string }> = {
  no_url: {
    title: "No database configured",
    body: "The app has no DATABASE_URL, so there is nothing to read the queue from.",
    fix: "Railway: reference your Postgres service as ${{Postgres.DATABASE_URL}}.\nVercel: add DATABASE_URL using Railway's PUBLIC connection string.",
  },
  unreachable: {
    title: "Can't reach the database",
    body: "DATABASE_URL is set, but nothing answered.",
    fix: "On Vercel the value must be Railway's PUBLIC connection string —\nthe .railway.internal host only resolves inside Railway.",
  },
  no_schema: {
    title: "Database has no tables yet",
    body: "The database is reachable but the schema has never been applied.",
    fix: 'DATABASE_URL="<your database url>" npm run migrate',
  },
  no_shop: {
    title: "No shop set up yet",
    body: "The schema is in place, but there is no shop, barbers or services to show.",
    fix: 'DATABASE_URL="<your database url>" npm run seed\n\nThe seed adds placeholder services — replace them with the real\nservice list and prices before customers use this.',
  },
};

/** Operator-facing, and deliberately says nothing a customer could act on. */
export default function NeedsDatabase({ status }: { status: Exclude<DatabaseStatus, "ready"> }) {
  const { title, body, fix } = MESSAGES[status];
  return (
    <main className="wrap" style={{ maxWidth: 620 }}>
      <p className="eyebrow">Setup needed</p>
      <h1>{title}</h1>
      <p className="lede">{body}</p>
      <div className="card">
        <p style={{ marginTop: 0, fontWeight: 600 }}>To fix it</p>
        <pre
          style={{
            background: "var(--sunk)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
            padding: "12px 14px",
            overflowX: "auto",
            fontSize: 13,
            margin: 0,
            whiteSpace: "pre-wrap",
          }}
        >
          <code>{fix}</code>
        </pre>
      </div>
    </main>
  );
}
