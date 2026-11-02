import { resolvePending } from "@/lib/ai/agent.ts";
import { errorResponse } from "@/lib/api.ts";

// POST { userId, pendingId, approved } -> { bubbles, changedBookingId }
export async function POST(request: Request) {
  try {
    const { userId, pendingId, approved } = await request.json();
    return Response.json(await resolvePending({ userId: Number(userId), pendingId: String(pendingId), approved: approved === true }));
  } catch (error) {
    return errorResponse(error);
  }
}
