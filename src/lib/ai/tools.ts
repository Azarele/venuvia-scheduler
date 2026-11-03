// The functions the AI may call. Read tools run immediately; write tools only
// produce a preview, and run after the user clicks Approve (see agent.ts).
import {
  BookingError,
  cancelBooking,
  checkCancel,
  checkCreate,
  checkUndo,
  checkUpdate,
  createBooking,
  describeBooking,
  findFreeSlots,
  getBookings,
  getClients,
  undoLastChange,
  updateBooking,
} from "../bookings.ts";
import type { PendingDetails } from "../chat-types.ts";
import type { Lang } from "../lang.ts";
import { formatDay, formatLocal, parseLocal } from "../time.ts";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  kind: "read" | "write";
};

const LOCAL_TIME = 'Local salon time as "YYYY-MM-DD HH:mm", e.g. "2026-11-02 14:00".';
const APPROVAL = "Needs the user's approval in the app before it happens.";

export const TOOLS: ToolDef[] = [
  {
    name: "get_bookings",
    kind: "read",
    description:
      "List the current user's bookings (with ids), ordered by time. Optionally filter by date and/or client name. Cancelled bookings are left out unless include_cancelled is true. Call this before updating or cancelling a booking to find its id.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: 'Only bookings on this local date, "YYYY-MM-DD".' },
        client_name: { type: "string", description: "Only bookings for this client." },
        include_cancelled: { type: "boolean", description: "Also list cancelled bookings." },
      },
    },
  },
  {
    name: "get_clients",
    kind: "read",
    description: "List all clients with how many active bookings they have.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "find_free_slots",
    kind: "read",
    description:
      "Find free start times on a day within opening hours for the current user. Use it when a requested time is taken, or when the user asks when they're free.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: '"YYYY-MM-DD"' },
        duration_minutes: { type: "integer", description: "Length needed; defaults to 60." },
        near: { type: "string", description: 'Optional "HH:mm"; returns the free times closest to it.' },
      },
      required: ["date"],
    },
  },
  {
    name: "create_booking",
    kind: "write",
    description: `Create a booking for the current user. The client is created if they don't exist yet. ${APPROVAL}`,
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client's name." },
        start: { type: "string", description: LOCAL_TIME },
        end: { type: "string", description: `${LOCAL_TIME} Optional; defaults to 60 minutes after start.` },
        service: { type: "string", description: "Optional, e.g. Haircut." },
      },
      required: ["client_name", "start"],
    },
  },
  {
    name: "update_booking",
    kind: "write",
    description: `Change an existing booking: time, client or service. Only pass the fields that change; if only the start changes, the length stays the same. ${APPROVAL}`,
    parameters: {
      type: "object",
      properties: {
        booking_id: { type: "integer", description: "Id from get_bookings." },
        start: { type: "string", description: LOCAL_TIME },
        end: { type: "string", description: LOCAL_TIME },
        client_name: { type: "string" },
        service: { type: "string" },
      },
      required: ["booking_id"],
    },
  },
  {
    name: "cancel_booking",
    kind: "write",
    description: `Cancel an existing booking. It's kept in history as cancelled and its time slot becomes free. ${APPROVAL}`,
    parameters: {
      type: "object",
      properties: { booking_id: { type: "integer", description: "Id from get_bookings." } },
      required: ["booking_id"],
    },
  },
  {
    name: "undo_last_change",
    kind: "write",
    description: `Reverse the user's most recent change (create, change or cancel). Calling it again steps further back. ${APPROVAL}`,
    parameters: { type: "object", properties: {} },
  },
];

export const findTool = (name: string) => TOOLS.find((t) => t.name === name);

type Args = Record<string, unknown>;
type Ctx = { userId: number; lang?: Lang };
type WriteCtx = Ctx & { source: "ai" | "undo-button" };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function runReadTool(name: string, args: Args, ctx: Ctx): Promise<unknown> {
  if (name === "get_bookings") {
    const bookings = await getBookings(ctx.userId, {
      date: str(args.date),
      clientName: str(args.client_name),
      includeCancelled: args.include_cancelled === true,
    });
    return {
      bookings: bookings.map(({ id, clientName, service, start, end, status }) => ({
        id,
        client: clientName,
        service,
        start,
        end,
        day: formatDay(parseLocal(start)!.toJSDate()), // e.g. "Mon 2 Nov (tomorrow)"
        status,
      })),
    };
  }
  if (name === "get_clients") return { clients: await getClients() };
  if (name === "find_free_slots") {
    const slots = await findFreeSlots({
      userId: ctx.userId,
      date: String(args.date ?? ""),
      durationMinutes: Number(args.duration_minutes) || undefined,
      near: str(args.near),
      limit: 6,
    });
    return { free_slots: slots, note: slots.length ? undefined : "No free slots of that length that day." };
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

/** Text our own code shows the user (approval cards, confirmations), in the conversation's language. */
const TEXT = {
  en: {
    newBooking: "New booking",
    change: (id: number) => `Change booking #${id}`,
    cancel: (id: number) => `Cancel booking #${id}`,
    undo: (id: number) => `Undo last change to booking #${id}`,
    cancelled: "Cancelled: ",
    booked: (d: string, id: number) => `Done — booked ${d} (booking #${id}).`,
    updated: (id: number, d: string) => `Done — booking #${id} is now ${d}.`,
    cancelledDone: (id: number, d: string) => `Done — cancelled booking #${id} (${d}). The time slot is free again.`,
    undoCreated: (id: number, name: string) => `Done — undone: the new booking #${id} for ${name} is cancelled again.`,
    undoRestored: (id: number, d: string) => `Done — undone: booking #${id} is restored (${d}).`,
    undoBack: (id: number, d: string) => `Done — undone: booking #${id} is back to ${d}.`,
  },
  pl: {
    newBooking: "Nowa rezerwacja",
    change: (id: number) => `Zmiana rezerwacji #${id}`,
    cancel: (id: number) => `Odwołanie rezerwacji #${id}`,
    undo: (id: number) => `Cofnięcie ostatniej zmiany rezerwacji #${id}`,
    cancelled: "Odwołana: ",
    booked: (d: string, id: number) => `Gotowe — zarezerwowano: ${d} (rezerwacja #${id}).`,
    updated: (id: number, d: string) => `Gotowe — rezerwacja #${id} to teraz: ${d}.`,
    cancelledDone: (id: number, d: string) => `Gotowe — odwołano rezerwację #${id} (${d}). Termin jest znów wolny.`,
    undoCreated: (id: number, name: string) => `Gotowe — cofnięto: nowa rezerwacja #${id} (${name}) jest znów odwołana.`,
    undoRestored: (id: number, d: string) => `Gotowe — cofnięto: przywrócono rezerwację #${id} (${d}).`,
    undoBack: (id: number, d: string) => `Gotowe — cofnięto: rezerwacja #${id} wróciła do: ${d}.`,
  },
} satisfies Record<Lang, unknown>;

/**
 * Checks a write without performing it; returns the approval card text. `summary` is always
 * English (logs, tests); `details` is what the user sees, in their language.
 */
export async function previewWriteTool(name: string, args: Args, ctx: Ctx): Promise<{ summary: string; details: PendingDetails }> {
  const lang = ctx.lang ?? "en";
  const t = TEXT[lang];
  const d = (b: Parameters<typeof describeBooking>[0], l: Lang = lang) => describeBooking(b, l);
  if (name === "create_booking") {
    const c = await checkCreate(createInput(args, ctx));
    const booking = { clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) };
    return { summary: `Create booking: ${d(booking, "en")}`, details: { kind: "create", lang, title: t.newBooking, to: d(booking) } };
  }
  if (name === "update_booking") {
    const c = await checkUpdate(updateInput(args, ctx));
    const after = { clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) };
    return {
      summary: `Change booking #${c.bookingId}: ${d(c.before, "en")}  →  ${d(after, "en")}`,
      details: { kind: "update", lang, title: t.change(c.bookingId), from: d(c.before), to: d(after) },
    };
  }
  if (name === "cancel_booking") {
    const b = await checkCancel({ userId: ctx.userId, bookingId: args.booking_id });
    return { summary: `Cancel booking #${b.id}: ${d(b, "en")}`, details: { kind: "cancel", lang, title: t.cancel(b.id), from: d(b) } };
  }
  if (name === "undo_last_change") {
    const plan = await checkUndo(ctx.userId);
    const show = (b: typeof plan.restored) => `${b.status === "cancelled" ? t.cancelled : ""}${d(b)}`;
    return {
      summary: `Undo: ${plan.description}`,
      details: { kind: "undo", lang, title: t.undo(plan.current.id), from: show(plan.current), to: show(plan.restored) },
    };
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

/** Performs an approved write. The same checks run again inside, and an audit row is written. */
export async function runWriteTool(name: string, args: Args, ctx: WriteCtx): Promise<{ result: unknown; message: string; bookingId: number }> {
  const audit = { approvedBy: ctx.userId, source: ctx.source };
  const lang = ctx.lang ?? "en";
  const t = TEXT[lang];
  if (name === "create_booking") {
    const booking = await createBooking(createInput(args, ctx), audit);
    return { result: { ok: true, booking }, message: t.booked(describeBooking(booking, lang), booking.id), bookingId: booking.id };
  }
  if (name === "update_booking") {
    const { after } = await updateBooking(updateInput(args, ctx), audit);
    return { result: { ok: true, booking: after }, message: t.updated(after.id, describeBooking(after, lang)), bookingId: after.id };
  }
  if (name === "cancel_booking") {
    const booking = await cancelBooking({ userId: ctx.userId, bookingId: args.booking_id }, audit);
    return { result: { ok: true, booking }, message: t.cancelledDone(booking.id, describeBooking(booking, lang)), bookingId: booking.id };
  }
  if (name === "undo_last_change") {
    const { plan, after } = await undoLastChange(ctx.userId, audit);
    const message =
      plan.event.action === "created"
        ? t.undoCreated(after.id, after.clientName)
        : plan.event.action === "cancelled"
          ? t.undoRestored(after.id, describeBooking(after, lang))
          : t.undoBack(after.id, describeBooking(after, lang));
    return { result: { ok: true, undone: plan.description, booking: after }, message, bookingId: after.id };
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

const createInput = (args: Args, ctx: Ctx) => ({
  userId: ctx.userId,
  clientName: args.client_name,
  start: args.start,
  end: args.end,
  service: args.service,
});

const updateInput = (args: Args, ctx: Ctx) => ({
  userId: ctx.userId,
  bookingId: args.booking_id,
  start: args.start,
  end: args.end,
  clientName: args.client_name,
  service: args.service,
});
