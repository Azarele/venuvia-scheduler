import { resolvePending } from "@/lib/ai/agent.ts";
import { errorResponse } from "@/lib/api.ts";

// POST { userId, history, pendingId, approved } -> { messages, reply, changedBookingId }
export async function POST(request: Request) {
  try {
    const { userId, history, pendingId, approved } = await request.json();
    return Response.json(
      await resolvePending({ userId: Number(userId), history: Array.isArray(history) ? history : [], pendingId: String(pendingId), approved: approved === true }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
