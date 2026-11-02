import { errorResponse } from "@/lib/api.ts";
import { clearConversation, loadConversation } from "@/lib/conversation.ts";

// GET /api/conversation?userId=1 -> { bubbles }   (the chat survives refreshes and restarts)
export async function GET(request: Request) {
  try {
    const userId = Number(new URL(request.url).searchParams.get("userId"));
    return Response.json({ bubbles: (await loadConversation(userId)).bubbles });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/conversation?userId=1 -> starts a new chat (open approvals are rejected)
export async function DELETE(request: Request) {
  try {
    await clearConversation(Number(new URL(request.url).searchParams.get("userId")));
    return Response.json({ bubbles: [] });
  } catch (error) {
    return errorResponse(error);
  }
}
