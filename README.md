# Barbershop queue

Queue and booking system for a chair-renter barbershop: barbers rent space and
run independent client books, so loyalty, client history and the daily queue
belong to the barber rather than to the shop.

The design this is built to — data model, queue state machine, wait-time
estimation, and the places it deviates from the original brief — is in
[`docs/design/v1-queue-spec.md`](docs/design/v1-queue-spec.md).

## Status

Built and tested:

| Piece | Where |
|---|---|
| Schema, with the queue invariants as partial unique indexes | `db/migrations/0001_init.sql` |
| Queue ordering, positions, demotion | `src/domain/order.ts` |
| Visit state machine (pure, no database) | `src/domain/machine.ts` |
| Wait-time estimation and average learning | `src/domain/estimate.ts` |
| Transactional persistence and the time-driven sweep | `src/db/queue-repo.ts` |

Not built yet: the HTTP layer, the customer and kiosk views, the barber
dashboard, and the owner metrics. Seam tables (`appointments`) and seam columns
(`payment_type`) exist but no code path touches them.

## Running it

Requires Node 20+ and Postgres 14+.

```bash
npm install
cp .env.example .env          # then point DATABASE_URL at your database
npm run migrate -- --seed     # schema, plus development shop and barbers
npm test
```

The tests use the same `DATABASE_URL`. Integration tests truncate every table
between cases, so point them at a scratch database, never a real one.

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
