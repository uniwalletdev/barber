# Barbershop queue

Queue and booking system for a chair-renter barbershop: barbers rent space and
run independent client books, so loyalty, client history and the daily queue
belong to the barber rather than to the shop.

The design this is built to — data model, queue state machine, wait-time
estimation, and the places it deviates from the original brief — is in
[`docs/design/v1-queue-spec.md`](docs/design/v1-queue-spec.md).

## Status

v1 is built: Next.js app on Vercel, Postgres on Railway.

| Piece | Where |
|---|---|
| Schema, with the queue invariants as partial unique indexes | `db/migrations/0001_init.sql` |
| Queue ordering, positions, demotion | `src/domain/order.ts` |
| Visit state machine (pure, no database) | `src/domain/machine.ts` |
| Wait-time estimation and average learning | `src/domain/estimate.ts` |
| Transactional persistence and the time-driven sweep | `src/db/queue-repo.ts` |
| Read models and server actions | `src/server/` |
| Customer, kiosk, barber and owner screens | `app/` |

Seam tables (`appointments`) and seam columns (`payment_type`,
`customer_devices.verified_at`) exist, but no code path touches them.

## Screens

| Route | Who | What |
|---|---|---|
| `/` | customer | Barbers, live waits, status badges. Add `?kiosk` for the in-shop tablet. |
| `/join/[barberId]` | customer | Name, phone, service; hold a spot remotely or join as a walk-in. |
| `/visit/[visitId]` | customer | Live position and wait, check in on arrival, leave. |
| `/barber/login` · `/barber` | barber | Own queue only: Next up, Call next, breaks, checked-in vs held-remotely. |
| `/admin` | owner | Shop-wide totals, walk-outs, recovered and lost revenue. |

## Running it locally

Requires Node 20+ and Postgres 14+.

```bash
npm install
cp .env.example .env          # point DATABASE_URL and TEST_DATABASE_URL at local databases
npm run migrate -- --seed     # schema, a development shop, three barbers
npm run dev
```

The seed sets every barber's PIN to `1234`. Change it before real use.

Integration tests truncate every table, so they use `TEST_DATABASE_URL` and
refuse to run unless that database name contains `test`.

```bash
npm test          # 71 tests: pure domain logic plus Postgres invariants
npm run typecheck
```

## Deploying

**Postgres on Railway.** Create a Postgres service and copy its *public*
connection string (`postgresql://...@<host>.proxy.rlwy.net:<port>/railway`).
The internal `.railway.internal` host is only reachable from inside Railway, so
Vercel cannot use it. Nothing in this repo deploys *to* Railway — it is the
database only.

**App on Vercel.** Import the repo and set these environment variables for
Production and Preview:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The Railway public connection string. |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `CRON_SECRET` | Any long random string; the sweep route checks it. |
| `SHOP_ID` | Optional. Defaults to the oldest shop row. |

`npm run build` runs the migrations and then `next build`. Migrations are
idempotent, so redeploys are no-ops — but note that a preview deploy will
migrate whatever `DATABASE_URL` it is given, so point previews at a separate
database if you do not want them touching production.

After the first deploy, create the shop and barbers. Running the seed against
production gives you the placeholder services and the PIN `1234`, which is fine
for a first look and must not survive contact with real customers:

```bash
DATABASE_URL="<railway public url>" npm run seed
```

### Keeping the queue moving

Time-driven transitions — the call grace expiring, a remote customer who never
arrives — are advanced by `/api/tick`, which open dashboards and customer pages
call every 12–15 seconds. `vercel.json` also registers a daily backstop on
`/api/cron/sweep` for when nobody has a page open; Vercel Cron on the Hobby plan
cannot fire more often than that. On Pro, change the schedule to `* * * * *` and
the sweep no longer depends on somebody watching.

## Notes for whoever picks this up

- **Position is computed, never stored.** `visits.sort_key` is a sparse
  ordering key; display position is a row number over `priority desc, sort_key`.
  A no-show demotion is therefore a one-row update rather than a renumbering.
- **`head` and `callable` are different customers.** A remote customer who has
  not arrived keeps position 1; "Call next" acts on the first person who is
  actually in the shop. Most queue bugs come from conflating the two.
- **The state machine is pure.** `src/domain/machine.ts` reads a snapshot and
  returns a patch. The repository applies it under a row lock on the barber, and
  the partial unique indexes catch anything that races past a guard.
- **Service durations in the seed are placeholders.** Only the adult cut
  (30–40 min) came from the brief. Replace them before the shop uses this, or
  every barber's running average starts from a wrong prior.
- **Impressions are recorded from the client, once per view.** A live page
  refreshes itself every 20 seconds; recording during the server render made a
  kiosk left open all day log thousands of walk-outs. `RecordImpression` fires
  on mount only, and `recordImpression` additionally collapses repeat looks from
  one device inside a 10-minute window.
- **There is still no SMS verification.** Remote joins are bound to a device
  token, rate-limited to one active visit per device, and capped per barber.
  That is a stopgap, not a substitute — see 4-F in the design.
