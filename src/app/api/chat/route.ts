import { runAgent } from "@/lib/ai/agent.ts";
import { errorResponse } from "@/lib/api.ts";

// POST { userId, text } -> { bubbles, pending, events }
export async function POST(request: Request) {
  try {
    const { userId, text } = await request.json();
    if (typeof text !== "string" || !text.trim()) return Response.json({ error: "Message is empty." }, { status: 400 });
    return Response.json(await runAgent({ userId: Number(userId), text: text.trim().slice(0, 2000) }));
  } catch (error) {
    return errorResponse(error);
  }
}
