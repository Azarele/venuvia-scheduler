import { errorResponse } from "@/lib/api.ts";
import { getEvents } from "@/lib/bookings.ts";

// GET /api/events?userId=1 -> the audit log, newest first
export async function GET(request: Request) {
  try {
    const userId = Number(new URL(request.url).searchParams.get("userId"));
    return Response.json({ events: await getEvents(userId) });
  } catch (error) {
    return errorResponse(error);
  }
}
