// The functions the AI may call. Read tools run immediately; write tools only
// produce a preview, and run after the user clicks Approve (see agent.ts).
import {
  BookingError,
  checkCreate,
  checkUpdate,
  createBooking,
  describeBooking,
  getBookings,
  getClients,
  updateBooking,
} from "../bookings.ts";
import { formatLocal } from "../time.ts";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  kind: "read" | "write";
};

const LOCAL_TIME = 'Local salon time as "YYYY-MM-DD HH:mm", e.g. "2026-11-02 14:00".';

export const TOOLS: ToolDef[] = [
  {
    name: "get_bookings",
    kind: "read",
    description:
      "List the current user's bookings (with ids), ordered by time. Optionally filter by date and/or client name. Call this before updating a booking to find its id.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: 'Only bookings on this local date, "YYYY-MM-DD".' },
        client_name: { type: "string", description: "Only bookings for this client." },
      },
    },
  },
  {
    name: "get_clients",
    kind: "read",
    description: "List all clients with how many bookings they have.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_booking",
    kind: "write",
    description:
      "Create a booking for the current user. The client is created if they don't exist yet. Needs the user's approval in the app before it happens.",
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
    description:
      "Change an existing booking: time, client or service. Only pass the fields that change; if only the start changes, the length stays the same. Needs the user's approval in the app before it happens.",
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
];

export const findTool = (name: string) => TOOLS.find((t) => t.name === name);

type Args = Record<string, unknown>;
type Ctx = { userId: number };

export async function runReadTool(name: string, args: Args, ctx: Ctx): Promise<unknown> {
  if (name === "get_bookings") {
    const bookings = await getBookings(ctx.userId, {
      date: typeof args.date === "string" && args.date ? args.date : undefined,
      clientName: typeof args.client_name === "string" && args.client_name ? args.client_name : undefined,
    });
    return {
      bookings: bookings.map(({ id, clientName, service, start, end }) => ({ id, client: clientName, service, start, end })),
    };
  }
  if (name === "get_clients") {
    return { clients: await getClients() };
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

/** Checks a write without performing it and returns a one-line summary for the approval card. */
export async function previewWriteTool(name: string, args: Args, ctx: Ctx): Promise<string> {
  if (name === "create_booking") {
    const c = await checkCreate(createInput(args, ctx));
    return `Create booking: ${describeBooking({ clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) })}`;
  }
  if (name === "update_booking") {
    const c = await checkUpdate(updateInput(args, ctx));
    const after = { clientName: c.clientName, service: c.service, start: formatLocal(c.start), end: formatLocal(c.end) };
    return `Change booking #${c.bookingId}: ${describeBooking(c.before)}  →  ${describeBooking(after)}`;
  }
  throw new BookingError(`Unknown tool ${name}.`);
}

/** Performs an approved write. Re-runs the same checks inside createBooking/updateBooking. */
export async function runWriteTool(name: string, args: Args, ctx: Ctx): Promise<{ result: unknown; message: string; bookingId: number }> {
  if (name === "create_booking") {
    const booking = await createBooking(createInput(args, ctx));
    return {
      result: { ok: true, booking },
      message: `Done — booked ${describeBooking(booking)} (booking #${booking.id}).`,
      bookingId: booking.id,
    };
  }
  if (name === "update_booking") {
    const { after } = await updateBooking(updateInput(args, ctx));
    return {
      result: { ok: true, booking: after },
      message: `Done — booking #${after.id} is now ${describeBooking(after)}.`,
      bookingId: after.id,
    };
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
