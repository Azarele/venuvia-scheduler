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
type Ctx = { userId: number };
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

/** Checks a write without performing it; returns the text for the approval card. */
export async function previewWriteTool(name: string, args: Args, ctx: Ctx): Promise<{ summary: string; details: PendingDetails }> {
  if (name === "create_booking") {
    const c = await checkCreate(createInput(args, ctx));
    const to = describeBooking({ clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) });
    return { summary: `Create booking: ${to}`, details: { kind: "create", title: "New booking", to } };
  }
  if (name === "update_booking") {
    const c = await checkUpdate(updateInput(args, ctx));
    const from = describeBooking(c.before);
    const to = describeBooking({ clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) });
    return { summary: `Change booking #${c.bookingId}: ${from}  →  ${to}`, details: { kind: "update", title: `Change booking #${c.bookingId}`, from, to } };
  }
  if (name === "cancel_booking") {
    const b = await checkCancel({ userId: ctx.userId, bookingId: args.booking_id });
    const from = describeBooking(b);
    return { summary: `Cancel booking #${b.id}: ${from}`, details: { kind: "cancel", title: `Cancel booking #${b.id}`, from } };
  }
  if (name === "undo_last_change") {
    const plan = await checkUndo(ctx.userId);
    return {
      summary: `Undo: ${plan.description}`,
      details: {
        kind: "undo",
        title: `Undo last change to booking #${plan.current.id}`,
        from: plan.current.status === "cancelled" ? `Cancelled: ${describeBooking(plan.current)}` : describeBooking(plan.current),
        to: plan.restored.status === "cancelled" ? `Cancelled: ${describeBooking(plan.restored)}` : describeBooking(plan.restored),
      },
    };
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

/** Performs an approved write. The same checks run again inside, and an audit row is written. */
export async function runWriteTool(name: string, args: Args, ctx: WriteCtx): Promise<{ result: unknown; message: string; bookingId: number }> {
  const audit = { approvedBy: ctx.userId, source: ctx.source };
  if (name === "create_booking") {
    const booking = await createBooking(createInput(args, ctx), audit);
    return { result: { ok: true, booking }, message: `Done — booked ${describeBooking(booking)} (booking #${booking.id}).`, bookingId: booking.id };
  }
  if (name === "update_booking") {
    const { after } = await updateBooking(updateInput(args, ctx), audit);
    return { result: { ok: true, booking: after }, message: `Done — booking #${after.id} is now ${describeBooking(after)}.`, bookingId: after.id };
  }
  if (name === "cancel_booking") {
    const booking = await cancelBooking({ userId: ctx.userId, bookingId: args.booking_id }, audit);
    return {
      result: { ok: true, booking },
      message: `Done — cancelled booking #${booking.id} (${describeBooking(booking)}). The time slot is free again.`,
      bookingId: booking.id,
    };
  }
  if (name === "undo_last_change") {
    const { plan, after } = await undoLastChange(ctx.userId, audit);
    const message =
      plan.event.action === "created"
        ? `Done — undone: the new booking #${after.id} for ${after.clientName} is cancelled again.`
        : plan.event.action === "cancelled"
          ? `Done — undone: booking #${after.id} is restored (${describeBooking(after)}).`
          : `Done — undone: booking #${after.id} is back to ${describeBooking(after)}.`;
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
