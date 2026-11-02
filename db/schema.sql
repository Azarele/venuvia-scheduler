-- Studio Nova booking assistant schema.
-- Running this file drops and recreates everything (it's a prototype).

drop table if exists pending_actions, conversations, booking_events, bookings, clients, users cascade;

-- Lets a GiST index compare plain columns (user_id) alongside time ranges,
-- which the no-overlap constraint below needs. A "trusted" extension, so the
-- database owner can enable it without superuser rights.
create extension if not exists btree_gist;

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
  constraint bookings_end_after_start check (end_at > start_at),
  -- The database itself refuses two confirmed bookings for the same user whose
  -- times overlap, even if two requests arrive at the same moment. The app checks
  -- first to give a friendly message; this is the guarantee.
  constraint bookings_no_overlap exclude using gist (
    user_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status = 'confirmed')
);
create index bookings_user_start_idx on bookings (user_id, start_at);
create index bookings_client_idx on bookings (client_id);

-- Audit log: one row per approved change, written in the same transaction as the change.
-- "Every change the AI made, who approved it, and what it looked like before."
create table booking_events (
  id              serial primary key,
  booking_id      integer not null references bookings (id) on delete cascade,
  action          text not null check (action in ('created', 'updated', 'cancelled', 'undone')),
  before          jsonb,          -- booking as it was (null for 'created')
  after           jsonb not null, -- booking as it is now
  approved_by     integer not null references users (id),
  source          text not null default 'ai',  -- who proposed it: the AI, or the Undo button
  undoes_event_id integer references booking_events (id),
  created_at      timestamptz not null default now()
);
create index booking_events_user_idx on booking_events (approved_by, id desc);
-- Each change can be undone at most once.
create unique index booking_events_undo_once on booking_events (undoes_event_id) where undoes_event_id is not null;

-- Proposed changes waiting for Approve / Reject. Stored server-side so the browser
-- can only answer by id (it can't alter what runs) and a restart doesn't lose them.
create table pending_actions (
  id           uuid primary key,
  user_id      integer not null references users (id) on delete cascade,
  tool         text not null,
  args         jsonb not null,
  tool_call_id text,          -- null when proposed by the Undo button rather than the AI
  summary      text not null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- One running conversation per user, so a page refresh or server restart keeps the chat.
-- `history` is what the AI sees; `bubbles` is what the user sees.
create table conversations (
  user_id    integer primary key references users (id) on delete cascade,
  history    jsonb not null default '[]',
  bubbles    jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
