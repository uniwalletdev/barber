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
| `/barber` | barber | Own queue only: Next up, Call next, breaks, checked-in vs held-remotely. |
| `/admin` | owner | Shop-wide totals, walk-outs, recovered and lost revenue. |
| `/admin/staff` | owner | Link each barber's Clerk account to their chair. |
| `/setup` | first staff user | One-time claim of shop ownership. |

## Running it locally

Requires Node 20+ and Postgres 14+.

```bash
npm install
cp .env.example .env          # point DATABASE_URL and TEST_DATABASE_URL at local databases
npm run migrate -- --seed     # schema, a development shop, three barbers
npm run dev
```

Staff sign-in needs Clerk keys in `.env` (see below). Without them the customer
side runs normally and the staff pages explain what is missing.

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
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API keys. |
| `CLERK_SECRET_KEY` | Clerk dashboard → API keys. Never expose this to the client. |
| `SHOP_ID` | Optional. Defaults to the oldest shop row. |

**Migrations are a deliberate step, not part of the build.** `npm run build` is
`next build` and needs no database — a build must never fail because a database
is briefly unreachable, and a preview deploy must never silently migrate
production. Run migrations yourself against whichever database you mean:

```bash
DATABASE_URL="<railway public url>" npm run migrate
DATABASE_URL="<railway public url>" npm run seed    # first time only
```

The seed adds the placeholder services and the PIN `1234`. Both are fine for a
first look and must not survive contact with real customers.

### Keeping the queue moving

Time-driven transitions — the call grace expiring, a remote customer who never
arrives — are advanced by `/api/tick`, which open dashboards and customer pages
call every 12–15 seconds. `vercel.json` also registers a daily backstop on
`/api/cron/sweep` for when nobody has a page open; Vercel Cron on the Hobby plan
cannot fire more often than that. On Pro, change the schedule to `* * * * *` and
the sweep no longer depends on somebody watching.

## Staff authentication

Clerk authenticates **staff only** — barbers and the owner. Customers have no
accounts and never sign in: a signup in front of the queue would cost the shop
the walk-ins the remote-join flow exists to recover.

`proxy.ts` protects `/barber`, `/admin` and `/setup`. Everything else is open.

First run, in order:

1. Add the two Clerk keys and redeploy (`NEXT_PUBLIC_*` is inlined at build time).
2. Sign up through **Staff → Create account** in the top bar.
3. The first account to visit `/setup` claims the shop and becomes the owner.
   The claim closes permanently once used.
4. Each barber signs up for themselves, then the owner links their account to a
   chair at `/admin/staff`. Until linked, a barber sees "ask the shop owner" and
   can act on nothing.

A barber's chair is re-derived from their Clerk session on every action, so a
barber can only ever act on their own queue — the client never supplies a
barber id.

### If you want to run the Clerk CLI

The integration is already wired by hand, so `clerk init` is not needed and
would duplicate it. To verify the setup instead:

```bash
npm install -g clerk
clerk auth login
clerk doctor
```

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
