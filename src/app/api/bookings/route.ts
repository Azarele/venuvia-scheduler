import { errorResponse } from "@/lib/api.ts";
import { getBookings } from "@/lib/bookings.ts";

// GET /api/bookings?userId=1
export async function GET(request: Request) {
  try {
    const userId = Number(new URL(request.url).searchParams.get("userId"));
    return Response.json({ bookings: await getBookings(userId) });
  } catch (error) {
    return errorResponse(error);
  }
}
