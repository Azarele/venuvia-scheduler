-- Studio Nova booking assistant schema.
-- Running this file drops and recreates everything (it's a prototype).

drop table if exists bookings, clients, users cascade;

-- The people who use the app and own bookings (salon owner / staff).
create table users (
  id   serial primary key,
  name text not null
);

-- The salon's customers. Kept in their own table so one client can have many
-- bookings without their name being copied (and drifting) on every row.
create table clients (
  id         serial primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
-- One client per name, case-insensitive ("anna" and "Anna" are the same person).
create unique index clients_name_lower_key on clients (lower(name));

-- One row per booking, linking a user (who it's with) and a client (who booked).
create table bookings (
  id         serial primary key,
  user_id    integer not null references users (id) on delete cascade,
  client_id  integer not null references clients (id) on delete restrict,
  service    text,
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  -- Cancelled bookings are kept (for history) but no longer block the time slot.
  status       text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_end_after_start check (end_at > start_at)
);
create index bookings_user_start_idx on bookings (user_id, start_at);
create index bookings_client_idx on bookings (client_id);
