// Data access for users, clients and bookings. Plain SQL via `pg`.
// Write functions run a few simple checks and throw BookingError with a
// message the AI can relay to the user.
import type pg from "pg";
import { pool } from "./db.ts";
import { formatDay, formatLocal, formatTime, now, parseLocal } from "./time.ts";

export class BookingError extends Error {}

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

export type Client = {
  id: number;
  name: string;
  bookingCount: number;
  nextBooking: string | null;
};

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
  if (!filters.includeCancelled) where.push("b.status = 'confirmed'");
  const params: unknown[] = [userId];
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
    `${SELECT_BOOKINGS} where ${where.join(" and ")} order by b.start_at limit 100`,
    params,
  );
  return rows.map(toBooking);
}

export async function getBooking(id: number): Promise<Booking | null> {
  const { rows } = await pool.query<BookingRow>(`${SELECT_BOOKINGS} where b.id = $1`, [id]);
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

export async function createBooking(input: CreateInput): Promise<Booking> {
  const checked = await checkCreate(input); // re-checked at execution time
  const db = await pool.connect();
  try {
    await db.query("begin");
    const clientId = await findOrCreateClient(db, checked.clientName);
    const { rows } = await db.query<{ id: number }>(
      `insert into bookings (user_id, client_id, service, start_at, end_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [checked.userId, clientId, checked.service, checked.start, checked.end],
    );
    await db.query("commit");
    return (await getBooking(rows[0].id))!;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function updateBooking(input: UpdateInput): Promise<{ before: Booking; after: Booking }> {
  const checked = await checkUpdate(input); // re-checked at execution time
  const db = await pool.connect();
  try {
    await db.query("begin");
    const clientId = await findOrCreateClient(db, checked.clientName);
    await db.query(
      `update bookings set client_id = $2, service = $3, start_at = $4, end_at = $5, updated_at = now()
       where id = $1`,
      [checked.bookingId, clientId, checked.service, checked.start, checked.end],
    );
    await db.query("commit");
    return { before: checked.before, after: (await getBooking(checked.bookingId))! };
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

/** Validates a cancel request without writing anything. */
export async function checkCancel(input: CancelInput): Promise<Booking> {
  const booking = await findOwnBooking(input.userId, input.bookingId);
  if (booking.status === "cancelled") throw new BookingError(`Booking #${booking.id} is already cancelled.`);
  if (parseLocal(booking.end)! <= now()) throw new BookingError(`Booking #${booking.id} has already happened, so it can't be cancelled.`);
  return booking;
}

/** Marks a booking as cancelled. The row is kept for history; the time slot becomes free. */
export async function cancelBooking(input: CancelInput): Promise<Booking> {
  const booking = await checkCancel(input); // re-checked at execution time
  await pool.query(
    `update bookings set status = 'cancelled', cancelled_at = now(), updated_at = now()
     where id = $1 and status = 'confirmed'`,
    [booking.id],
  );
  return (await getBooking(booking.id))!;
}

// ---------- Simple checks ----------

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

async function checkNoOverlap(userId: number, start: Date, end: Date, ignoreBookingId?: number) {
  const { rows } = await pool.query<BookingRow>(
    `${SELECT_BOOKINGS}
     where b.user_id = $1 and b.status = 'confirmed' and b.start_at < $3 and b.end_at > $2 and b.id <> $4
     order by b.start_at`,
    [userId, start, end, ignoreBookingId ?? -1],
  );
  if (rows.length) {
    const clash = rows
      .map((r) => `#${r.id} ${r.client_name} ${formatTime(r.start_at)}–${formatTime(r.end_at)}`)
      .join(", ");
    throw new BookingError(`That overlaps an existing booking (${clash}).`);
  }
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

export function describeBooking(b: { clientName: string; start: string; end: string; service?: string | null }): string {
  const start = parseLocal(b.start)!.toJSDate();
  const end = parseLocal(b.end)!.toJSDate();
  return `${b.clientName}${b.service ? ` (${b.service})` : ""}, ${formatDay(start)}, ${formatTime(start)}–${formatTime(end)}`;
}

