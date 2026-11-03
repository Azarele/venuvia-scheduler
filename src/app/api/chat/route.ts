import { runAgent } from "@/lib/ai/agent.ts";
import { describeError } from "@/lib/api.ts";

// POST { userId, text, retry? } -> a stream of JSON lines (NDJSON):
//   {"type":"progress","label":"Looking up your bookings…"}   (zero or more, while the AI works)
//   {"type":"done", bubbles, pending, events, usage}           or   {"type":"error","error":"…"}
export async function POST(request: Request) {
  let body: { userId?: unknown; text?: unknown; retry?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  if (!text) return Response.json({ error: "Message is empty." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: object) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const result = await runAgent({
          userId: Number(body.userId),
          text,
          retry: body.retry === true,
          onProgress: (p) => send({ type: "progress", ...p }),
        });
        send({ type: "done", ...result });
      } catch (error) {
        send({ type: "error", error: describeError(error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" } });
}
