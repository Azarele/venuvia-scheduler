import { runAgent } from "@/lib/ai/agent.ts";
import { errorResponse } from "@/lib/api.ts";

// POST { userId, history, text } -> { messages, reply, pending, events }
export async function POST(request: Request) {
  try {
    const { userId, history, text } = await request.json();
    if (typeof text !== "string" || !text.trim()) return Response.json({ error: "Message is empty." }, { status: 400 });
    return Response.json(await runAgent({ userId: Number(userId), history: Array.isArray(history) ? history : [], text: text.trim().slice(0, 2000) }));
  } catch (error) {
    return errorResponse(error);
  }
}
