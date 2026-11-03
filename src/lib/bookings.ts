// Data access for users, clients and bookings. Plain SQL via `pg`.
// Every write: runs simple checks (throwing BookingError with a message the AI
// can relay), then changes the booking AND writes an audit row in one transaction.
import type pg from "pg";
import { pool } from "./db.ts";
import type { Lang } from "./lang.ts";
import { formatDay, formatLocal, formatTime, now, parseLocal } from "./time.ts";

export class BookingError extends Error {}

export const BUSINESS_HOURS = {
  open: process.env.BUSINESS_OPEN ?? "09:00",
  close: process.env.BUSINESS_CLOSE ?? "19:00",
};

export type User = { id: number; name: string };

export type Booking = {
  id: number;
  userId: number;
  userName: string;
  clientId: number;
  clientName: string;
  service: string | null;
  start: string; // local "YYYY-MM-DD HH:mm"
  end: string;
  status: "confirmed" | "cancelled";
};

export type Client = { id: number; name: string; bookingCount: number; nextBooking: string | null };

export type BookingEvent = {
  id: number;
  bookingId: number;
  action: "created" | "updated" | "cancelled" | "undone";
  before: Booking | null;
  after: Booking;
  approvedBy: string;
  source: "ai" | "undo-button";
  undone: boolean; // a later 'undone' event reversed this one
  at: string; // local "YYYY-MM-DD HH:mm"
};

/** Who approved a write and how it was proposed; recorded in booking_events. */
export type Audit = { approvedBy: number; source?: "ai" | "undo-button" };

type Db = pg.Pool | pg.PoolClient;

type BookingRow = {
  id: number;
  user_id: number;
  user_name: string;
  client_id: number;
  client_name: string;
  service: string | null;
  start_at: Date;
  end_at: Date;
  status: "confirmed" | "cancelled";
};

const SELECT_BOOKINGS = `
  select b.id, b.user_id, u.name as user_name, b.client_id, c.name as client_name,
         b.service, b.start_at, b.end_at, b.status
  from bookings b
  join users u on u.id = b.user_id
  join clients c on c.id = b.client_id`;

const DEFAULT_DURATION_MINUTES = 60;
const SLOT_STEP_MINUTES = 15;

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    clientId: row.client_id,
    clientName: row.client_name,
    service: row.service,
    start: formatLocal(row.start_at),
    end: formatLocal(row.end_at),
    status: row.status,
  };
}

// ---------- Reads ----------

export async function getUsers(): Promise<User[]> {
  const { rows } = await pool.query<User>("select id, name from users order by id");
  return rows;
}

export async function getUser(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>("select id, name from users where id = $1", [id]);
  return rows[0] ?? null;
}

/** A user's bookings, optionally filtered to one local date and/or a client name. Cancelled ones are left out unless asked for. */
export async function getBookings(
  userId: number,
  filters: { date?: string; clientName?: string; includeCancelled?: boolean } = {},
): Promise<Booking[]> {
  const where = ["b.user_id = $1"];
  const params: unknown[] = [userId];
  if (!filters.includeCancelled) where.push("b.status = 'confirmed'");
  if (filters.date) {
    const day = parseLocal(filters.date);
    if (!day) throw new BookingError(`"${filters.date}" isn't a valid date. Use YYYY-MM-DD.`);
    params.push(day.startOf("day").toJSDate(), day.startOf("day").plus({ days: 1 }).toJSDate());
    where.push(`b.start_at >= $${params.length - 1} and b.start_at < $${params.length}`);
  }
  if (filters.clientName) {
    params.push(filters.clientName.trim());
    where.push(`lower(c.name) = lower($${params.length})`);
  }
  const { rows } = await pool.query<BookingRow>(
    `${SELECT_BOOKINGS} where ${where.join(" and ")} order by b.start_at limit 200`,
    params,
  );
  return rows.map(toBooking);
}

export async function getBooking(id: number, db: Db = pool): Promise<Booking | null> {
  const { rows } = await db.query<BookingRow>(`${SELECT_BOOKINGS} where b.id = $1`, [id]);
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function getClients(): Promise<Client[]> {
  const { rows } = await pool.query<{ id: number; name: string; booking_count: string; next_booking: Date | null }>(
    `select c.id, c.name, count(b.id) as booking_count,
            min(b.start_at) filter (where b.start_at > now()) as next_booking
     from clients c
     left join bookings b on b.client_id = c.id and b.status = 'confirmed'
     group by c.id
     order by c.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bookingCount: Number(r.booking_count),
    nextBooking: r.next_booking ? formatLocal(r.next_booking) : null,
  }));
}

/** The audit log for one user's bookings, newest first. */
export async function getEvents(userId: number, limit = 50): Promise<BookingEvent[]> {
  const { rows } = await pool.query<{
    id: number; booking_id: number; action: BookingEvent["action"]; before: Booking | null; after: Booking;
    approver: string; source: BookingEvent["source"]; undone: boolean; created_at: Date;
  }>(
    `select e.id, e.booking_id, e.action, e.before, e.after, u.name as approver, e.source, e.created_at,
            exists (select 1 from booking_events x where x.undoes_event_id = e.id) as undone
     from booking_events e
     join bookings b on b.id = e.booking_id
     join users u on u.id = e.approved_by
     where b.user_id = $1
     order by e.id desc
     limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    bookingId: r.booking_id,
    action: r.action,
    before: r.before,
    after: r.after,
    approvedBy: r.approver,
    source: r.source,
    undone: r.undone,
    at: formatLocal(r.created_at),
  }));
}

/** Free start times on a day (within opening hours, not in the past), nearest to `near` first if given. */
export async function findFreeSlots(opts: {
  userId: number;
  date: string;
  durationMinutes?: number;
  near?: string; // "HH:mm"
  limit?: number;
  ignoreBookingId?: number;
}): Promise<{ start: string; end: string }[]> {
  const day = parseLocal(opts.date);
  if (!day) throw new BookingError(`"${opts.date}" isn't a valid date. Use YYYY-MM-DD.`);
  const date = day.toFormat("yyyy-MM-dd");
  const minutes = Math.min(Math.max(Number(opts.durationMinutes) || DEFAULT_DURATION_MINUTES, 5), 12 * 60);
  const open = parseLocal(`${date} ${BUSINESS_HOURS.open}`)!;
  const close = parseLocal(`${date} ${BUSINESS_HOURS.close}`)!;

  const { rows } = await pool.query<{ start_at: Date; end_at: Date }>(
    `select start_at, end_at from bookings
     where user_id = $1 and status = 'confirmed' and start_at < $3 and end_at > $2 and id <> $4`,
    [opts.userId, open.toJSDate(), close.toJSDate(), opts.ignoreBookingId ?? -1],
  );
  const busy = rows.map((r) => [r.start_at.getTime(), r.end_at.getTime()]);

  const slots = [];
  for (let t = open; t.plus({ minutes }) <= close; t = t.plus({ minutes: SLOT_STEP_MINUTES })) {
    const s = t.toMillis();
    const e = t.plus({ minutes }).toMillis();
    if (t >= now() && !busy.some(([bs, be]) => s < be && bs < e)) slots.push(t);
  }
  const target = opts.near ? parseLocal(`${date} ${opts.near}`) : null;
  const picked = target
    ? [...slots].sort((a, b) => Math.abs(+a - +target) - Math.abs(+b - +target)).slice(0, opts.limit ?? 5).sort((a, b) => +a - +b)
    : slots.slice(0, opts.limit ?? 5);
  return picked.map((t) => ({ start: t.toFormat("yyyy-MM-dd HH:mm"), end: t.plus({ minutes }).toFormat("yyyy-MM-dd HH:mm") }));
}

// ---------- Writes: check first, then apply ----------

export type CreateInput = { userId: number; clientName: unknown; start: unknown; end?: unknown; service?: unknown };
export type UpdateInput = { userId: number; bookingId: unknown; start?: unknown; end?: unknown; clientName?: unknown; service?: unknown };
export type CancelInput = { userId: number; bookingId: unknown };

type CheckedCreate = { userId: number; clientName: string; start: Date; end: Date; service: string | null };
type CheckedUpdate = CheckedCreate & { bookingId: number; before: Booking };

/** Validates a create request without writing anything. */
export async function checkCreate(input: CreateInput): Promise<CheckedCreate> {
  const clientName = cleanName(input.clientName);
  const { start, end } = checkTimes(input.start, input.end, DEFAULT_DURATION_MINUTES);
  await checkOpeningHours(input.userId, start, end);
  await checkNoOverlap(input.userId, start, end);
  return { userId: input.userId, clientName, start, end, service: cleanService(input.service) };
}

/** Validates an update request without writing anything. Omitted fields keep their current value. */
export async function checkUpdate(input: UpdateInput): Promise<CheckedUpdate> {
  const before = await findOwnBooking(input.userId, input.bookingId);
  const bookingId = before.id;
  if (before.status === "cancelled") throw new BookingError(`Booking #${bookingId} is cancelled, so it can't be changed. Create a new booking instead.`);

  const oldStart = parseLocal(before.start)!;
  const oldMinutes = parseLocal(before.end)!.diff(oldStart, "minutes").minutes;
  const hasStart = input.start != null && input.start !== "";
  const hasEnd = input.end != null && input.end !== "";
  // Moving the start keeps the same length unless a new end is given too.
  const { start, end } = checkTimes(
    hasStart ? input.start : before.start,
    hasEnd ? input.end : hasStart ? undefined : before.end,
    oldMinutes,
  );
  await checkOpeningHours(input.userId, start, end, bookingId);
  await checkNoOverlap(input.userId, start, end, bookingId);
  return {
    bookingId,
    before,
    userId: input.userId,
    clientName: input.clientName != null && input.clientName !== "" ? cleanName(input.clientName) : before.clientName,
    start,
    end,
    service: input.service !== undefined ? cleanService(input.service) : before.service,
  };
}

/** Validates a cancel request without writing anything. */
export async function checkCancel(input: CancelInput): Promise<Booking> {
  const booking = await findOwnBooking(input.userId, input.bookingId);
  if (booking.status === "cancelled") throw new BookingError(`Booking #${booking.id} is already cancelled.`);
  if (parseLocal(booking.end)! <= now()) throw new BookingError(`Booking #${booking.id} has already happened, so it can't be cancelled.`);
  return booking;
}

export async function createBooking(input: CreateInput, audit: Audit): Promise<Booking> {
  const checked = await checkCreate(input); // re-checked at execution time
  return withTransaction(async (db) => {
    const clientId = await findOrCreateClient(db, checked.clientName);
    const { rows } = await db.query<{ id: number }>(
      `insert into bookings (user_id, client_id, service, start_at, end_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [checked.userId, clientId, checked.service, checked.start, checked.end],
    );
    const after = (await getBooking(rows[0].id, db))!;
    await writeEvent(db, { bookingId: after.id, action: "created", before: null, after, audit });
    return after;
  });
}

export async function updateBooking(input: UpdateInput, audit: Audit): Promise<{ before: Booking; after: Booking }> {
  const checked = await checkUpdate(input); // re-checked at execution time
  return withTransaction(async (db) => {
    const clientId = await findOrCreateClient(db, checked.clientName);
    await db.query(
      `update bookings set client_id = $2, service = $3, start_at = $4, end_at = $5, updated_at = now()
       where id = $1`,
      [checked.bookingId, clientId, checked.service, checked.start, checked.end],
    );
    const after = (await getBooking(checked.bookingId, db))!;
    await writeEvent(db, { bookingId: after.id, action: "updated", before: checked.before, after, audit });
    return { before: checked.before, after };
  });
}

/** Marks a booking as cancelled. The row is kept for history; the time slot becomes free. */
export async function cancelBooking(input: CancelInput, audit: Audit): Promise<Booking> {
  const before = await checkCancel(input); // re-checked at execution time
  return withTransaction(async (db) => {
    await db.query(
      `update bookings set status = 'cancelled', cancelled_at = now(), updated_at = now()
       where id = $1 and status = 'confirmed'`,
      [before.id],
    );
    const after = (await getBooking(before.id, db))!;
    await writeEvent(db, { bookingId: after.id, action: "cancelled", before, after, audit });
    return after;
  });
}

// ---------- Undo ----------

export type UndoPlan = {
  event: BookingEvent;
  current: Booking;
  restored: Pick<Booking, "clientName" | "service" | "start" | "end" | "status">;
  description: string;
};

/**
 * Works out how to reverse the user's most recent change that hasn't been undone yet.
 * Undoing repeatedly steps further back through the history.
 */
export async function checkUndo(userId: number): Promise<UndoPlan> {
  const { rows } = await pool.query<{ id: number }>(
    `select e.id from booking_events e
     join bookings b on b.id = e.booking_id
     where b.user_id = $1 and e.action <> 'undone'
       and not exists (select 1 from booking_events x where x.undoes_event_id = e.id)
     order by e.id desc limit 1`,
    [userId],
  );
  if (!rows.length) throw new BookingError("There's no change to undo.");
  const event = (await getEvents(userId, 200)).find((e) => e.id === rows[0].id)!;
  const current = (await getBooking(event.bookingId))!;

  // Only undo if the booking still looks exactly like that change left it.
  const same = (a: Partial<Booking>, b: Partial<Booking>) =>
    a.start === b.start && a.end === b.end && a.status === b.status && a.clientName === b.clientName && (a.service ?? null) === (b.service ?? null);
  if (!same(current, event.after))
    throw new BookingError(`Booking #${current.id} has changed since then, so the last change can't be undone automatically.`);

  let restored: UndoPlan["restored"];
  let description: string;
  if (event.action === "created") {
    restored = { ...pick(current), status: "cancelled" };
    description = `Cancel booking #${current.id} (${describeBooking(current)}), which was just created`;
  } else {
    const before = event.before!;
    restored = pick(before);
    description =
      event.action === "cancelled"
        ? `Restore cancelled booking #${current.id} (${describeBooking(before)})`
        : `Change booking #${current.id} back to ${describeBooking(before)} (it's now ${describeBooking(current)})`;
  }

  if (restored.status === "confirmed") {
    const start = parseLocal(restored.start)!;
    if (start < now()) throw new BookingError("The original time is now in the past, so this change can't be undone.");
    await checkNoOverlap(userId, start.toJSDate(), parseLocal(restored.end)!.toJSDate(), current.id);
  }
  return { event, current, restored, description };
}

export async function undoLastChange(userId: number, audit: Audit): Promise<{ plan: UndoPlan; after: Booking }> {
  const plan = await checkUndo(userId); // re-checked at execution time
  const { restored, current, event } = plan;
  const after = await withTransaction(async (db) => {
    const clientId = await findOrCreateClient(db, restored.clientName);
    await db.query(
      `update bookings set client_id = $2, service = $3, start_at = $4, end_at = $5, status = $6,
              cancelled_at = case when $6 = 'cancelled' then now() else null end, updated_at = now()
       where id = $1`,
      [current.id, clientId, restored.service, parseLocal(restored.start)!.toJSDate(), parseLocal(restored.end)!.toJSDate(), restored.status],
    );
    const after = (await getBooking(current.id, db))!;
    await writeEvent(db, { bookingId: current.id, action: "undone", before: current, after, audit, undoesEventId: event.id });
    return after;
  });
  return { plan, after };
}

// ---------- Helpers ----------

async function withTransaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const result = await work(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    const code = (error as { code?: string }).code;
    // 23P01 = the bookings_no_overlap constraint: someone took the slot between our check and the write.
    if (code === "23P01") throw new BookingError("That time was just taken by another booking. Nothing was changed.");
    if (code === "23505" && String((error as Error).message).includes("undo_once"))
      throw new BookingError("That change has already been undone.");
    throw error;
  } finally {
    db.release();
  }
}

async function writeEvent(
  db: pg.PoolClient,
  e: { bookingId: number; action: BookingEvent["action"]; before: Booking | null; after: Booking; audit: Audit; undoesEventId?: number },
) {
  await db.query(
    `insert into booking_events (booking_id, action, before, after, approved_by, source, undoes_event_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.bookingId, e.action, e.before, e.after, e.audit.approvedBy, e.audit.source ?? "ai", e.undoesEventId ?? null],
  );
}

async function findOwnBooking(userId: number, bookingId: unknown): Promise<Booking> {
  const id = Number(bookingId);
  const booking = Number.isInteger(id) ? await getBooking(id) : null;
  if (!booking || booking.userId !== userId)
    throw new BookingError(`Booking #${bookingId} doesn't exist for this user. Use get_bookings to find the right id.`);
  return booking;
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new BookingError("A client name is required.");
  if (name.length > 80) throw new BookingError("That client name is too long.");
  return name;
}

function cleanService(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function checkTimes(startValue: unknown, endValue: unknown, defaultMinutes: number) {
  const start = parseLocal(startValue);
  if (!start) throw new BookingError(`"${String(startValue)}" isn't a valid start time. Use "YYYY-MM-DD HH:mm".`);
  const end = endValue == null || endValue === "" ? start.plus({ minutes: defaultMinutes }) : parseLocal(endValue);
  if (!end) throw new BookingError(`"${String(endValue)}" isn't a valid end time. Use "YYYY-MM-DD HH:mm".`);
  if (end <= start) throw new BookingError("The end time must be after the start time.");
  if (start < now()) throw new BookingError("That time is in the past.");
  if (end.diff(start, "hours").hours > 12) throw new BookingError("A booking can't be longer than 12 hours.");
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Friendly overlap check with nearby free times. The database constraint is the real guarantee. */
async function checkNoOverlap(userId: number, start: Date, end: Date, ignoreBookingId?: number) {
  const { rows } = await pool.query<BookingRow>(
    `${SELECT_BOOKINGS}
     where b.user_id = $1 and b.status = 'confirmed' and b.start_at < $3 and b.end_at > $2 and b.id <> $4
     order by b.start_at`,
    [userId, start, end, ignoreBookingId ?? -1],
  );
  if (!rows.length) return;
  const clash = rows.map((r) => `#${r.id} ${r.client_name} ${formatTime(r.start_at)}–${formatTime(r.end_at)}`).join(", ");
  const startLocal = formatLocal(start);
  const free = await findFreeSlots({
    userId,
    date: startLocal.slice(0, 10),
    durationMinutes: (end.getTime() - start.getTime()) / 60_000,
    near: startLocal.slice(11),
    limit: 3,
    ignoreBookingId,
  });
  throw new BookingError(`That overlaps an existing booking (${clash}).${freeTimesHint(free)}`);
}

/** Bookings must start and end within opening hours on the same day. */
async function checkOpeningHours(userId: number, start: Date, end: Date, ignoreBookingId?: number) {
  const startLocal = formatLocal(start);
  const endLocal = formatLocal(end);
  const date = startLocal.slice(0, 10);
  const inside = endLocal.slice(0, 10) === date && startLocal.slice(11) >= BUSINESS_HOURS.open && endLocal.slice(11) <= BUSINESS_HOURS.close;
  if (inside) return;
  const free = await findFreeSlots({
    userId,
    date,
    durationMinutes: (end.getTime() - start.getTime()) / 60_000,
    near: startLocal.slice(11),
    limit: 3,
    ignoreBookingId,
  });
  throw new BookingError(`That's outside opening hours (${BUSINESS_HOURS.open}–${BUSINESS_HOURS.close}).${freeTimesHint(free)}`);
}

function freeTimesHint(free: { start: string }[]): string {
  return free.length
    ? ` Nearest free times that day: ${free.map((s) => s.start.slice(11)).join(", ")}.`
    : " There are no free slots of that length that day.";
}

async function findOrCreateClient(db: pg.PoolClient, name: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into clients (name) values ($1)
     on conflict ((lower(name))) do update set name = clients.name
     returning id`,
    [name],
  );
  return rows[0].id;
}

function pick(b: Booking) {
  return { clientName: b.clientName, service: b.service, start: b.start, end: b.end, status: b.status };
}

export function describeBooking(b: { clientName: string; start: string; end: string; service?: string | null }, lang: Lang = "en"): string {
  const start = parseLocal(b.start)!.toJSDate();
  const end = parseLocal(b.end)!.toJSDate();
  return `${b.clientName}${b.service ? ` (${b.service})` : ""}, ${formatDay(start, lang)}, ${formatTime(start)}–${formatTime(end)}`;
}
