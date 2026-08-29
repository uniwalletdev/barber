-- Development seed. Durations and prices are PLACEHOLDERS: the real service
-- list is still outstanding from the shop owner (design 4-I). Adult cut is the
-- one figure the brief fixed; everything else needs replacing before the shop
-- runs on this, or every barber's average starts from a wrong prior.

insert into shops (name, timezone, opens_at, closes_at)
values ('Fade Room', 'America/New_York', '09:00', '19:00')
on conflict do nothing;

with s as (select id from shops where name = 'Fade Room' limit 1)
insert into services (shop_id, code, display_name, default_duration_seconds, price_cents, sort_order)
select s.id, v.code, v.name, v.secs, v.price, v.ord
  from s, (values
    ('adult_cut', 'Adult cut',     35 * 60, 3500, 1),  -- brief: 30-40 min
    ('kids_cut',  'Kids cut',      45 * 60, 3000, 2),  -- PLACEHOLDER, unconfirmed
    ('lineup',    'Line-up',       15 * 60, 1500, 3),  -- PLACEHOLDER, unconfirmed
    ('cut_beard', 'Cut and beard', 50 * 60, 5000, 4)   -- PLACEHOLDER, unconfirmed
  ) as v(code, name, secs, price, ord)
on conflict (shop_id, code) do nothing;

with s as (select id from shops where name = 'Fade Room' limit 1)
insert into barbers (shop_id, name, phone_number, presence, sort_order)
select s.id, v.name, v.phone, 'available'::barber_presence, v.ord
  from s, (values
    ('Dre',  '+15551110001', 1),
    ('Kemi', '+15551110002', 2),
    ('Marc', '+15551110003', 3)
  ) as v(name, phone, ord)
on conflict (phone_number) do nothing;
