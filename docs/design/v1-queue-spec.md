# Barbershop Queue — v1 Design

Status: **awaiting approval.** No application code written yet.

Legend used throughout:

- **[seam]** — field or table that exists only so a later phase (appointments, multi-shop, cut club) drops in without a schema rework. Unused in v1.
- **[change]** — deliberate deviation from the brief. Reasoning is in §4.

---

## 1. Data model

### 1.1 `shops`

Every other table carries `shop_id`, even in v1.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | text | |
| `timezone` | text | IANA. Defines the business day for metrics and end-of-day close-out. **[change]** — not in the brief, but nothing dated works without it. |
| `remote_join_cap_per_barber` | int, default 3 | Counts *un-checked-in* remote holds only. |
| `call_grace_seconds` | int, default 180 | How long a called customer has to reach the chair. |
| `no_show_demotion_places` | int, default 2 | The "drop 2 places" rule, configurable. |
| `max_no_shows_per_visit` | int, default 2 | After this many, the visit is removed. |
| `remote_head_grace_seconds` | int, default 600 | How long an un-arrived remote may hold the head of a free barber's queue. **[change]** — see §4-D. |
| `chair_turnover_seconds` | int, default 90 | Per-person overhead between cuts. **[change]** — see §4-E. |
| `estimate_min_samples` | int, default 5 | Below this, blend the barber's average with the shop default. |
| `appointment_lead_minutes` | int, default 30 | **[seam]** — when a booking converts to a queue entry. |
| `opens_at`, `closes_at` | time, nullable | v1 uses these only to close out the queue. |
| `created_at` | timestamptz | |

### 1.2 `services` **[change — replaces the `service_type` enum]**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `shop_id` | fk → shops | |
| `code` | text | `adult_cut`, `kids_cut`, … unique per shop |
| `display_name` | text | |
| `default_duration_seconds` | int | Seeds `barber_service_averages`. |
| `price_cents` | int | **[change]** — required to express any revenue metric. See §4-A. |
| `active` | bool, default true | Retire a service without breaking historical visits. |
| `sort_order` | int | |

### 1.3 `barbers`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `shop_id` | fk → shops | |
| `name` | text | |
| `profile_image_url` | text, nullable | UI falls back to an initials avatar. |
| `phone_number` | text, unique | Login identity. **[change]** — auth was unspecified; see §4-L. |
| `pin_hash` | text, nullable | |
| `presence` | enum: `available` / `on_break` / `off` | **[change]** — `with_client` removed; it is derived. See §4-C. |
| `break_until` | timestamptz, nullable | Drives the public "back at ~2:40" badge. |
| `accepting_remote_joins` | bool, default true | Lets a barber close remote joins without going on break. |
| `active` | bool, default true | |
| `sort_order` | int | Display order on the customer-facing list. |
| `created_at` | timestamptz | |

**Public status is computed, never stored:**

```
public_status(barber) =
  if presence = off                            -> off
  if presence = on_break                       -> on_break (with break_until)
  if a visit exists with status in [called, in_progress] -> with_client
  else                                         -> available
```

### 1.4 `customers`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `phone_number` | text, unique **globally** | E.164. Not scoped to a shop — one person, one record, across shops. |
| `first_name` | text | |
| `last_name` | text, nullable | **[change]** — the barber dashboard shows "first name + last initial"; there was nowhere to get the initial from. |
| `created_at`, `last_seen_at` | timestamptz | |

### 1.5 `customer_devices` **[change]**

No password means the device *is* the credential.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `customer_id` | fk → customers | |
| `token_hash` | text | Issued at registration, stored hashed. |
| `verified_at` | timestamptz, nullable | **[seam]** — set by SMS verification in v1.1. Null in v1. |
| `created_at`, `last_used_at` | timestamptz | |

### 1.6 `barber_customers` — this is what "loyalty" means here

Primary key `(barber_id, customer_id)`. A barber sees their own history with a customer and never another barber's.

| Field | Type | Notes |
|---|---|---|
| `barber_id` | fk → barbers | |
| `customer_id` | fk → customers | |
| `shop_id` | fk → shops | Denormalized for scoping and metrics. |
| `first_visit_at`, `last_visit_at` | timestamptz | |
| `visit_count` | int, default 0 | Completed visits only. |
| `no_show_count` | int, default 0 | **[change]** — lifetime reputation with *this* barber; distinct from the per-visit counter. See §4-G. |
| `cancelled_count` | int, default 0 | |
| `notes` | text, nullable | **[seam]** — barber-private client notes. |

### 1.7 `visits`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `shop_id`, `barber_id`, `customer_id` | fks | |
| `service_id` | fk → services | |
| `status` | enum | `queued_remote` / `queued_present` / `called` / `in_progress` / `completed` / `left` / `no_show` / `closed_out` |
| `join_method` | enum: `remote` / `walk_in` | |
| `priority` | smallint, default 0 | Higher sorts earlier. **[seam]** — appointment elevation and cut-club priority. |
| `sort_key` | numeric(20,6) | **[change]** — replaces a stored `queue_position`. See §4-B. |
| `business_date` | date | Shop-local. Indexes the daily queue and all metrics. |
| `joined_at` | timestamptz | |
| `checked_in_at` | timestamptz, nullable | Physical arrival. Equals `joined_at` for walk-ins. |
| `called_at`, `started_at`, `completed_at`, `ended_at` | timestamptz, nullable | |
| `no_show_count` | smallint, default 0 | Demotions **within this visit**. |
| `outcome` | enum, nullable | `served` / `left` / `no_show` / `closed_out`. Null while active. |
| `quoted_wait_seconds` | int, nullable | The estimate shown at join. Kept so the estimator can be graded against reality. |
| `payment_type` | enum, nullable | **[seam]** — v2 cut-club billing. Unused. |
| `appointment_id` | uuid, nullable fk | **[seam]** — set when a booking converts into this visit. |
| `created_at`, `updated_at` | timestamptz | |

Indexes:

- `(barber_id, status)` partial, where `status in (queued_remote, queued_present, called, in_progress)` — the hot path.
- Unique partial on `(barber_id)` where `status = 'in_progress'` — one chair, one client.
- Unique partial on `(customer_id, shop_id)` where status is active — one active visit per customer per shop. See §4-K.
- `(shop_id, business_date)` — metrics.

### 1.8 `barber_service_averages`

Primary key `(barber_id, service_id)`.

| Field | Type | Notes |
|---|---|---|
| `barber_id`, `service_id` | fks | |
| `shop_id` | fk | |
| `avg_duration_seconds` | int | Seeded from `services.default_duration_seconds`. |
| `sample_count` | int, default 0 | |
| `updated_at` | timestamptz | |

### 1.9 `visit_events` **[change]**

Append-only audit of every status transition: `id`, `visit_id`, `shop_id`, `from_status`, `to_status`, `at`, `actor_type` (`customer` / `barber` / `system`), `actor_id`, `meta` jsonb.

Cheap now, impossible to reconstruct later. It is what makes no-show disputes, demotion history, and estimator accuracy answerable.

### 1.10 `queue_impressions` **[change — see §4-A]**

Every view of a shop's barber list, kiosk or web. Without this, "recovered walk-out revenue" has no data source at all.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `shop_id` | fk | |
| `barber_id` | fk, nullable | Set if the viewer opened a specific barber. |
| `source` | enum: `kiosk` / `web` | |
| `quoted_wait_seconds` | int | What the wait said at the moment they looked. |
| `device_token_hash` | text, nullable | Ties an impression to a later join. |
| `shown_at` | timestamptz | |
| `converted_visit_id` | uuid, nullable fk | Null = they looked and did not join. |

### 1.11 `appointments` **[seam — table created in v1, no code paths]**

`id`, `shop_id`, `barber_id`, `customer_id`, `service_id`, `scheduled_start_at`, `scheduled_end_at`, `status` (`booked` / `converted` / `cancelled` / `no_show`), `converted_visit_id` nullable fk, `created_at`.

Confirmed: `visits.priority` supports this. At `scheduled_start_at - shop.appointment_lead_minutes`, a job creates a visit with `priority = 100` and `appointment_id` set. It sorts ahead of every walk-in but, per §2, cannot displace a customer already `called` or `in_progress`.

### 1.12 Relationships

```
shops 1─* barbers          shops 1─* services       shops 1─* visits
barbers 1─* visits         customers 1─* visits     services 1─* visits
barbers *─* customers  (via barber_customers — the loyalty record)
barbers *─* services   (via barber_service_averages — the timing record)
visits 1─* visit_events
queue_impressions 0..1─1 visits (converted_visit_id)
appointments 0..1─1 visits (converted_visit_id / appointment_id)
```

---

## 2. Queue state machine

### 2.1 States

| State | Meaning | Holds a position? |
|---|---|---|
| `queued_remote` | Joined from a phone, not physically present. | Yes |
| `queued_present` | In the shop. Walk-in on arrival, or a remote who checked in. | Yes |
| `called` | The barber tapped **Call next**. Grace timer running. | Yes |
| `in_progress` | In the chair. | Occupies the chair |
| `completed` | Terminal. `outcome = served` | — |
| `left` | Terminal. Customer left or the barber removed them. | — |
| `no_show` | Terminal. Exceeded the demotion limit. | — |
| `closed_out` | Terminal. Still queued when the shop closed. | — |

### 2.2 Queue order

```
queue(barber) =
  visits where barber_id = barber
          and status in [queued_remote, queued_present, called]
  ordered by priority DESC, sort_key ASC

position(visit)  = index in queue(visit.barber) + 1     # displayed, never stored
head(barber)     = queue(barber)[0]
callable(barber) = first v in queue(barber) where v.status = queued_present
```

`head` and `callable` are deliberately different. A remote customer at position 1 who has not arrived keeps position 1; **Call next** targets the first customer who is actually in the shop. The barber's "Next up" card shows the head, tagged *hasn't arrived*, and the Call next button names who it will actually call.

### 2.3 Transitions

| # | Event | From → To | Guards | Effects |
|---|---|---|---|---|
| 1 | `join_remote` | — → `queued_remote` | remote holds for this barber < cap; `accepting_remote_joins`; `presence != off`; customer has no active visit at this shop | `sort_key = now_ms`; snapshot `quoted_wait_seconds`; link the impression |
| 2 | `join_walk_in` | — → `queued_present` | `presence != off`; no active visit | `sort_key = now_ms`; `checked_in_at = now` |
| 3 | `check_in` | `queued_remote` → `queued_present` | — | `checked_in_at = now`; **`sort_key` unchanged — the position was held** |
| 4 | `call_next` | `queued_present` → `called` | barber has no visit in `called` or `in_progress`; this visit is `callable(barber)`; `presence = available` | `called_at = now` |
| 5 | `start` | `called` → `in_progress` | — | `started_at = now`; barber reads `with_client` |
| 6 | `no_show` | `called` → `queued_present` | `now - called_at >= call_grace_seconds`, or the barber taps *No-show* | `no_show_count += 1`; `barber_customers.no_show_count += 1`; `demote(visit, 2)` |
| 6b | `no_show` (limit) | `called` → `no_show` | as above **and** `no_show_count + 1 >= max_no_shows_per_visit` | terminal; `outcome = no_show` |
| 7 | `no_arrival` **[change]** | `queued_remote` → `queued_remote` | this visit is `head(barber)`, barber is `available` with nobody called, and it has been head for `remote_head_grace_seconds` | `demote(visit, 2)`; on the 2nd demotion → `left`, `outcome = no_show` |
| 8 | `complete` | `in_progress` → `completed` | — | `completed_at`; update the running average (§3.4); upsert `barber_customers` |
| 9 | `leave` | any of `queued_remote`, `queued_present`, `called` → `left` | — | customer taps *Leave*, or the barber removes them |
| 10 | `abort` | `in_progress` → `left` | — | no average update — an aborted cut is not a timing sample |
| 11 | `close_out` | any active → `closed_out` | shop closing job | system actor |

Every transition writes a `visit_events` row.

### 2.4 Demotion

```
demote(visit, places = 2):
  # operates within the visit's own priority tier, so the seam for
  # cut-club / appointment priority behaves correctly later
  tier   = queue(visit.barber) where priority = visit.priority, excluding visit
  i      = index visit would occupy in tier
  behind = tier[i + places - 1]      # the entry it should land behind
  ahead  = tier[i + places]          # the one it should land in front of, may be null

  if behind is null:  visit.sort_key = tier.last.sort_key + 1000   # not enough people behind: go to the tail
  else if ahead is null: visit.sort_key = behind.sort_key + 1000
  else:               visit.sort_key = (behind.sort_key + ahead.sort_key) / 2
```

Single-row update. No renumbering, no write contention across the queue.

### 2.5 Barber presence rules

- `start_break(until)` → `presence = on_break`, `break_until = until`. Blocks `call_next`. The queue holds; every estimate gains the remaining break time.
- `end_break` → `presence = available`, `break_until = null`.
- `go_off` → `presence = off`. Blocks new joins. The existing queue holds and the barber clears it manually. Reassigning a client to another barber is **not** a v1 action — under the chair-renter model that is another barber's book, and it needs the client's consent.

---

## 3. Wait-time estimation

### 3.1 Duration for one queued customer

```
duration(barber, service):
  a = barber_service_averages[barber, service]
  d = service.default_duration_seconds
  if a is null or a.sample_count = 0:
      return d
  if a.sample_count >= shop.estimate_min_samples:
      return a.avg_duration_seconds
  w = a.sample_count / shop.estimate_min_samples      # linear blend below the threshold
  return round(w * a.avg_duration_seconds + (1 - w) * d)
```

### 3.2 The customer currently in the chair

```
remaining_in_chair(barber):
  w = the barber's in_progress visit
  if w exists:
      est     = duration(barber, w.service)
      elapsed = now - w.started_at
      if elapsed >= est:
          return WRAPPING_UP_FLOOR        # 120s; the UI reads "wrapping up", not "0 min"
      return est - elapsed
  c = the barber's called visit
  if c exists:
      return duration(barber, c.service)  # chair is turning over
  return 0
```

### 3.3 Wait for a given position

```
wait_for(visit):
  b     = visit.barber
  ahead = queue(b) before visit, excluding the in_progress visit
  t  = remaining_in_chair(b)
  t += sum over u in ahead of ( duration(b, u.service) + shop.chair_turnover_seconds )
  t += shop.chair_turnover_seconds                     # this customer's own turnover
  if b.presence = on_break and b.break_until:
      t += max(0, b.break_until - now)
  return t

# the number on the barber list: what a new joiner would wait
wait_to_join(barber) = wait_for(a hypothetical entry at the tail)
```

Recomputed on every queue event and on a short poll, so it tracks live.

### 3.4 Learning after each completed visit

```
on_complete(visit):
  actual = visit.completed_at - visit.started_at
  a      = averages[barber, service]        # created from the service default if absent

  if actual < 240 or actual > max(5400, 3 * a.avg_duration_seconds):
      record the outlier in visit_events, do not average it
      # "forgot to tap complete" is the single largest source of corruption here
  else:
      alpha = max(1 / (a.sample_count + 1), 0.20)     # true mean early, EWMA once established
      a.avg_duration_seconds += alpha * (actual - a.avg_duration_seconds)
      a.sample_count += 1

  barber_customers: visit_count += 1, last_visit_at = now, first_visit_at ??= now
```

### 3.5 Display

- Round to 5 minutes.
- Above 20 minutes, show a band (`est` to `est × 1.25`, e.g. "35–45 min"). A point estimate at that length is false precision and generates complaints.
- `presence = off` shows no estimate — "not taking customers" — rather than a number nobody will honour.

---

## 4. What I would design differently, and why

**A. The walk-out metric cannot be computed from the schema as specced.** The stated business problem is customers who see a long wait and leave. A customer who does that creates no row anywhere — so "estimated recovered walk-out revenue" has no input. Two additions fix it, and neither can be backfilled: `queue_impressions` (§1.10) logs every look at the barber list with the wait that was quoted, and `services.price_cents` converts to money. Balk rate = impressions with no join within 15 minutes ÷ impressions. This must ship in v1 even though the owner dashboard is minimal, or the shop spends v1 collecting nothing. **The exact definition of "recovered" is yours to set** — my proposal is completed visits that joined remotely (people who held a spot instead of walking away) × average ticket.

**B. `queue_position` as a stored integer is a race-condition machine.** Every join, departure and demotion renumbers every row behind it, under concurrent writes from a kiosk, several phones and the barber's tablet. A sparse `sort_key` with position computed on read makes a demotion a one-row update, and makes the "drop 2 places" rule trivial to implement correctly.

**C. `with_client` does not belong in `barber.status`.** It has two writers — the barber's own break toggle and the visit lifecycle — and they will drift. The classic symptom is a barber showing *available* on the kiosk while mid-cut. Store presence only; derive `with_client` from the in-progress visit.

**D. The no-show rule covers the wrong no-show.** The spec handles a customer who does not respond when called. The more common case in a remote-join system is a remote customer who never arrives at all, sitting at position 1 while the barber is free and everyone behind them watches. I added transition 7: after `remote_head_grace_seconds` at the head of a free barber's queue, they take the same 2-place demotion; a second one drops them. **Confirm the grace value — I have defaulted to 10 minutes.**

**E. `max(0, avg - elapsed)` pins at zero.** Once a cut runs long, that formula reads "0 min" indefinitely — precisely when the waiting customer is most likely to walk. I floor it at 2 minutes with a "wrapping up" label. Separately, averages measured `started_at → completed_at` exclude payment, sweep-down, and greeting the next customer; without a per-person `chair_turnover_seconds` (~90s), a queue of six under-quotes by roughly nine minutes, which is exactly the error that makes customers stop trusting the number.

**F. Skipping SMS verification is not a v1.1 data-quality issue; it is a v1 availability hole.** With phone + first name and no verification, one person can burn every remote slot on every barber using invented numbers, and no-show counts attach to identities nobody proved. Minimum hardening for v1: bind remote joins to a device token, one active visit per device, rate-limit joins per device and IP, and give the barber one-tap removal. I would not raise the remote cap above ~3 until real SMS verification ships.

**G. `no_show_count` on `Visit` conflates two counters.** One is per-visit ("how many times have you been demoted today", resets each visit, drives removal). The other is reputation ("how often does this customer no-show on me", accumulates, and belongs to the barber relationship, not the shop). Both are in the model.

**H. The barber dashboard shows "first name + last initial", but `Customer` has only `first_name`.** Added a nullable `last_name`. Two Mikes in one queue is an ordinary Tuesday.

**I. `service_type` as an enum blocks the extensibility it promises.** A per-shop `services` table gives duration, price and retirement per service without a migration. Related: **the brief only fixes the adult-cut default (30–40 min). I need the real service list with durations and prices** — beard/lineup and cut+beard have very different durations and will otherwise land in `adult_cut` and poison that average.

**J. Priority sorts, it does not preempt.** Worth stating explicitly now so the appointment seam is safe: a priority insert must never move ahead of a customer already `called` or `in_progress`. Otherwise a cut-club member walking in mid-call pulls the chair out from under someone already standing at it.

**K. One active visit per customer per shop.** Not addressed in the brief. Without it, one person holds spots with three barbers, takes the first to open, and every barber's estimate is inflated by demand that does not exist. Enforced with a partial unique index. **Confirm you want this.**

**L. Barber authentication is unspecified.** Phone + PIN is the lowest-friction fit for a shop where barbers may not share an email convention. Needs your call.

**M. Shop timezone and business day are missing.** Every metric, the daily queue reset, and end-of-day close-out need them.

**N. Recommended for v1.1, in priority order:** SMS verification (F); push/SMS "you're next" notification — a held remote spot is worth much less if nobody tells the customer to start walking; barber-visible loyalty summary on the Next-up card ("14th visit, usual: adult cut").

---

## 5. Open questions blocking the build

1. **Stack and hosting.** Not covered in the brief and I will not assume it.
2. **Service list**, with durations and prices — including the kids-cut default.
3. **Defaults to confirm:** remote cap (3), call grace (3 min), demotion places (2), removal after 2 no-shows, remote head grace (10 min), chair turnover (90s).
4. **Barber auth** (§4-L).
5. **One-queue-at-a-time policy** (§4-K).
6. **Definition of "recovered walk-out revenue"** (§4-A).
