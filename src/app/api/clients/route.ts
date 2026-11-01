import { errorResponse } from "@/lib/api.ts";
import { getClients } from "@/lib/bookings.ts";

// GET /api/clients
export async function GET() {
  try {
    return Response.json({ clients: await getClients() });
  } catch (error) {
    return errorResponse(error);
  }
}
