-- v1 schema for the barbershop queue.
--
-- Design reference: docs/design/v1-queue-spec.md
--
-- Two conventions run through this file:
--   [seam]   present only so a later phase (appointments, multi-shop, cut club)
--            drops in without a schema rework. Nothing in v1 reads or writes it.
--   Queue invariants are enforced by partial unique indexes rather than by
--   application code, because several writers (kiosk, customer phones, the
--   barber's tablet) race on the same queue.

begin;

create type visit_status as enum (
  'queued_remote', 'queued_present', 'called', 'in_progress',
  'completed', 'left', 'no_show', 'closed_out'
);
create type visit_outcome       as enum ('served', 'left', 'no_show', 'closed_out');
create type join_method         as enum ('remote', 'walk_in');
create type barber_presence     as enum ('available', 'on_break', 'off');
create type impression_source   as enum ('kiosk', 'web');
create type actor_type          as enum ('customer', 'barber', 'system');
create type appointment_status  as enum ('booked', 'converted', 'cancelled', 'no_show');
create type payment_type        as enum ('walk_in', 'cut_club'); -- [seam] v2 billing

-- ---------------------------------------------------------------- shops ----

create table shops (
  id                          uuid primary key default gen_random_uuid(),
  name                        text        not null,
  -- IANA zone. Defines the business day for metrics and the close-out sweep.
  timezone                    text        not null default 'UTC',

  -- Queue policy. All tunable per shop without a deploy.
  remote_join_cap_per_barber  int         not null default 3  check (remote_join_cap_per_barber >= 0),
  call_grace_seconds          int         not null default 180 check (call_grace_seconds > 0),
  no_show_demotion_places     int         not null default 2  check (no_show_demotion_places > 0),
  max_no_shows_per_visit      int         not null default 2  check (max_no_shows_per_visit > 0),
  -- How long an un-arrived remote may hold the head of an *idle* barber's queue.
  remote_head_grace_seconds   int         not null default 600 check (remote_head_grace_seconds > 0),
  -- Payment, sweep-down and greeting: real time between chairs that the
  -- measured cut duration (started_at -> completed_at) never captures.
  chair_turnover_seconds      int         not null default 90 check (chair_turnover_seconds >= 0),
  -- Below this many samples a barber's average is blended with the shop default.
  estimate_min_samples        int         not null default 5  check (estimate_min_samples > 0),

  appointment_lead_minutes    int         not null default 30, -- [seam]
  opens_at                    time,
  closes_at                   time,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ------------------------------------------------------------- services ----
-- A table rather than an enum: an enum cannot carry a price, and cannot be
-- retired without orphaning the visits that reference it.

create table services (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references shops (id) on delete cascade,
  code                     text not null,
  display_name             text not null,
  default_duration_seconds int  not null check (default_duration_seconds > 0),
  -- Required before any revenue figure can exist, walk-out recovery included.
  price_cents              int  not null default 0 check (price_cents >= 0),
  active                   bool not null default true,
  sort_order               int  not null default 0,
  created_at               timestamptz not null default now(),
  unique (shop_id, code)
);

-- ------------------------------------------------------------- barbers -----

create table barbers (
  id                     uuid primary key default gen_random_uuid(),
  shop_id                uuid not null references shops (id) on delete cascade,
  name                   text not null,
  profile_image_url      text,                    -- null -> initials avatar in the UI
  phone_number           text not null unique,    -- login identity
  pin_hash               text,
  -- 'with_client' is deliberately absent: it is derived from the barber's
  -- in-flight visit. Storing it would give the field two writers that drift.
  presence               barber_presence not null default 'off',
  break_until            timestamptz,
  accepting_remote_joins bool not null default true,
  active                 bool not null default true,
  sort_order             int  not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint break_until_only_on_break
    check (break_until is null or presence = 'on_break')
);

create index barbers_shop_idx on barbers (shop_id) where active;

-- ------------------------------------------------------------ customers ----

create table customers (
  id           uuid primary key default gen_random_uuid(),
  -- E.164, unique globally rather than per shop: one person, one record,
  -- so a multi-shop phase does not have to merge duplicates later.
  phone_number text not null unique,
  first_name   text not null,
  -- The barber dashboard shows "first name + last initial"; without this
  -- there is nowhere to get the initial from.
  last_name    text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- With no password, the device is the credential. Remote joins bind to a
-- device so that the per-barber remote cap cannot be exhausted from one phone.
create table customer_devices (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers (id) on delete cascade,
  token_hash   text not null unique,
  verified_at  timestamptz,          -- [seam] set by SMS verification in v1.1
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index customer_devices_customer_idx on customer_devices (customer_id);

-- ------------------------------------------------------ barber_customers ---
-- The loyalty record. Keyed on the barber-customer edge, never on the shop:
-- in a chair-renter shop the client book belongs to the barber.

create table barber_customers (
  barber_id       uuid not null references barbers (id) on delete cascade,
  customer_id     uuid not null references customers (id) on delete cascade,
  shop_id         uuid not null references shops (id) on delete cascade,
  first_visit_at  timestamptz,
  last_visit_at   timestamptz,
  visit_count     int  not null default 0 check (visit_count >= 0),
  -- Lifetime reputation with *this* barber. Distinct from visits.no_show_count,
  -- which counts demotions inside a single visit and resets with it.
  no_show_count   int  not null default 0 check (no_show_count >= 0),
  cancelled_count int  not null default 0 check (cancelled_count >= 0),
  notes           text,                       -- [seam] barber-private client notes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (barber_id, customer_id)
);

create index barber_customers_customer_idx on barber_customers (customer_id);

-- --------------------------------------------------------- appointments ----
-- [seam] Created in v1, no code path touches it. Confirms visits.priority
-- carries time-slot bookings: at scheduled_start_at - appointment_lead_minutes
-- a job creates a visit with priority > 0, which sorts ahead of walk-ins but
-- (see the queue ordering rules) cannot displace anyone already called.

create table appointments (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references shops (id) on delete cascade,
  barber_id           uuid not null references barbers (id) on delete cascade,
  customer_id         uuid not null references customers (id) on delete cascade,
  service_id          uuid not null references services (id),
  scheduled_start_at  timestamptz not null,
  scheduled_end_at    timestamptz not null,
  status              appointment_status not null default 'booked',
  converted_visit_id  uuid,
  created_at          timestamptz not null default now(),
  constraint appointment_ends_after_start check (scheduled_end_at > scheduled_start_at)
);

create index appointments_barber_start_idx on appointments (barber_id, scheduled_start_at);

-- --------------------------------------------------------------- visits ----

create table visits (
  id                     uuid primary key default gen_random_uuid(),
  shop_id                uuid not null references shops (id) on delete cascade,
  barber_id              uuid not null references barbers (id) on delete cascade,
  customer_id            uuid not null references customers (id) on delete cascade,
  service_id             uuid not null references services (id),

  status                 visit_status not null,
  join_method            join_method  not null,
  outcome                visit_outcome,

  -- Higher sorts earlier. 0 for every v1 visit.
  -- [seam] appointment elevation and cut-club priority.
  priority               smallint     not null default 0,
  -- Sparse ordering key, not a dense position. A demotion is then a one-row
  -- update instead of renumbering every row behind it under concurrent writes.
  -- double precision rather than numeric so the value round-trips through
  -- JavaScript exactly; the gaps involved are far coarser than float64 error.
  sort_key               double precision not null,

  business_date          date not null,   -- shop-local; set from shops.timezone

  joined_at              timestamptz not null default now(),
  checked_in_at          timestamptz,     -- physical arrival
  called_at              timestamptz,
  started_at             timestamptz,
  completed_at           timestamptz,
  ended_at               timestamptz,     -- terminal, non-completed
  -- Continuously at the head of an *idle* barber's queue since this time.
  -- Cleared whenever that stops being true. Drives the no-arrival sweep.
  head_since_at          timestamptz,

  no_show_count          smallint not null default 0 check (no_show_count >= 0),
  -- The estimate shown at join, kept so the estimator can be graded later.
  quoted_wait_seconds    int,
  actual_duration_seconds int generated always as
    (extract(epoch from (completed_at - started_at))::int) stored,

  payment_type           payment_type,    -- [seam] v2 cut-club billing
  appointment_id         uuid references appointments (id), -- [seam]
  -- Which device created a remote join, so one phone cannot hold several spots.
  created_by_device_id   uuid references customer_devices (id) on delete set null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Terminal states carry an outcome; active states never do.
  constraint outcome_iff_terminal check (
    (status in ('completed','left','no_show','closed_out')) = (outcome is not null)
  ),
  -- Anything the barber can act on is physically present.
  constraint present_states_are_checked_in check (
    status not in ('queued_present','called','in_progress') or checked_in_at is not null
  ),
  constraint walk_in_is_checked_in check (
    join_method <> 'walk_in' or checked_in_at is not null
  ),
  constraint started_implies_called    check (started_at    is null or called_at  is not null),
  constraint completed_implies_started check (completed_at  is null or started_at is not null),
  constraint completed_iff_status      check ((status = 'completed') = (completed_at is not null))
);

-- The hot path: every queue read for a barber.
create index visits_barber_active_idx
  on visits (barber_id, priority desc, sort_key)
  where status in ('queued_remote','queued_present','called','in_progress');

-- One chair, one client.
create unique index visits_one_in_progress_per_barber
  on visits (barber_id) where status = 'in_progress';

-- One outstanding call at a time, so "Call next" cannot double-fire.
create unique index visits_one_called_per_barber
  on visits (barber_id) where status = 'called';

-- One active visit per customer per shop. Without this a customer holds spots
-- with three barbers, takes whichever opens first, and every barber's estimate
-- is inflated by demand that does not exist.
create unique index visits_one_active_per_customer_shop
  on visits (customer_id, shop_id)
  where status in ('queued_remote','queued_present','called','in_progress');

-- Device-token hardening: one active visit per device (see design 4-F).
create unique index visits_one_active_per_device
  on visits (created_by_device_id)
  where created_by_device_id is not null
    and status in ('queued_remote','queued_present','called','in_progress');

create index visits_shop_date_idx    on visits (shop_id, business_date);
create index visits_barber_date_idx  on visits (barber_id, business_date);

alter table appointments
  add constraint appointments_converted_visit_fk
  foreign key (converted_visit_id) references visits (id) on delete set null;

-- ----------------------------------------------- barber_service_averages ---

create table barber_service_averages (
  barber_id            uuid not null references barbers (id) on delete cascade,
  service_id           uuid not null references services (id) on delete cascade,
  shop_id              uuid not null references shops (id) on delete cascade,
  avg_duration_seconds int  not null check (avg_duration_seconds > 0),
  sample_count         int  not null default 0 check (sample_count >= 0),
  updated_at           timestamptz not null default now(),
  primary key (barber_id, service_id)
);

-- --------------------------------------------------------- visit_events ----
-- Append-only. Cheap to write now, impossible to reconstruct later; it is what
-- makes no-show disputes and estimator accuracy answerable questions.

create table visit_events (
  id          bigserial primary key,
  visit_id    uuid not null references visits (id) on delete cascade,
  shop_id     uuid not null references shops (id) on delete cascade,
  from_status visit_status,
  to_status   visit_status not null,
  event       text not null,
  at          timestamptz not null default now(),
  actor       actor_type not null,
  actor_id    uuid,
  meta        jsonb not null default '{}'::jsonb
);

create index visit_events_visit_idx on visit_events (visit_id, at);
create index visit_events_shop_at_idx on visit_events (shop_id, at);

-- ---------------------------------------------------- queue_impressions ----
-- Every look at the barber list. A customer who sees a long wait and leaves
-- creates no other row anywhere, so without this the walk-out problem the
-- shop is trying to solve cannot be measured at all. Cannot be backfilled.

create table queue_impressions (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references shops (id) on delete cascade,
  barber_id           uuid references barbers (id) on delete set null,
  source              impression_source not null,
  quoted_wait_seconds int  not null,
  device_token_hash   text,
  shown_at            timestamptz not null default now(),
  business_date       date not null,
  converted_visit_id  uuid references visits (id) on delete set null
);

create index queue_impressions_shop_date_idx on queue_impressions (shop_id, business_date);
create index queue_impressions_unconverted_idx
  on queue_impressions (shop_id, shown_at) where converted_visit_id is null;

-- ------------------------------------------------------------ updated_at ---

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger shops_updated_at            before update on shops            for each row execute function set_updated_at();
create trigger barbers_updated_at          before update on barbers          for each row execute function set_updated_at();
create trigger visits_updated_at           before update on visits           for each row execute function set_updated_at();
create trigger barber_customers_updated_at before update on barber_customers for each row execute function set_updated_at();

commit;
