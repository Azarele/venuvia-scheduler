import { proposeUndo } from "@/lib/ai/agent.ts";
import { errorResponse } from "@/lib/api.ts";

// POST { userId } -> proposes undoing the last change (still needs Approve)
export async function POST(request: Request) {
  try {
    const { userId } = await request.json();
    return Response.json(await proposeUndo(Number(userId)));
  } catch (error) {
    return errorResponse(error);
  }
}
