-- Staff authentication moves to Clerk.
--
-- Only staff authenticate. Customers stay deliberately password-free: the
-- point of a remote join is that somebody on the pavement can hold a spot in
-- ten seconds, and an account signup in front of that would cost the shop the
-- very walk-ins this app exists to recover.

begin;

create type staff_role as enum ('barber', 'owner');

-- Maps a Clerk identity to what it may do in this shop. A barber row always
-- points at the barber whose queue they own; an owner may exist without
-- cutting hair.
create table staff (
  clerk_user_id text primary key,
  shop_id       uuid not null references shops (id) on delete cascade,
  barber_id     uuid references barbers (id) on delete set null,
  role          staff_role not null,
  email         text,
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint barber_role_needs_a_barber
    check (role <> 'barber' or barber_id is not null)
);

-- One account per barber: two people signed in as the same barber would each
-- think they owned that chair's queue.
create unique index staff_one_account_per_barber
  on staff (barber_id) where barber_id is not null;

create index staff_shop_idx on staff (shop_id);

create trigger staff_updated_at
  before update on staff for each row execute function set_updated_at();

-- The phone + PIN login this replaces. Phone number stays as contact detail.
alter table barbers drop column pin_hash;

commit;
