import { getProvider } from "@/lib/ai/providers.ts";
import { errorResponse } from "@/lib/api.ts";
import { BUSINESS_HOURS, getUsers } from "@/lib/bookings.ts";
import { now, TIMEZONE } from "@/lib/time.ts";

// GET /api/info -> users for the picker, which AI is configured, and salon time settings
export async function GET() {
  try {
    let ai: { name: string; model: string } | { error: string };
    try {
      const provider = getProvider();
      ai = { name: provider.name, model: provider.model };
    } catch (error) {
      ai = { error: (error as Error).message };
    }
    return Response.json({
      users: await getUsers(),
      ai,
      timezone: TIMEZONE,
      today: now().toFormat("yyyy-MM-dd"),
      hours: BUSINESS_HOURS,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
