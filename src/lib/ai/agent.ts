// The agent loop:
//   1. Send the conversation + tools to the model.
//   2. Read tools (get_bookings, get_clients) run immediately and the loop continues.
//   3. A write tool (create/update) is checked, saved as a *pending action*, and the
//      loop stops. Nothing is written until the user clicks Approve (approvePending).
import { randomUUID } from "node:crypto";
import { BookingError, getUser, type User } from "../bookings.ts";
import { now, TIMEZONE } from "../time.ts";
import { getProvider, type AssistantMessage, type ChatMessage, type Provider } from "./providers.ts";
import { findTool, previewWriteTool, runReadTool, runWriteTool, TOOLS } from "./tools.ts";

const MAX_STEPS = 6;

export type ToolEvent = { tool: string; kind: "read" | "write"; args: Record<string, unknown>; error?: string };
export type PendingAction = { id: string; tool: string; summary: string };

export type AgentResult = {
  messages: ChatMessage[];
  reply: string | null;
  pending: PendingAction | null;
  events: ToolEvent[];
  changedBookingId?: number;
};

type StoredPending = PendingAction & { userId: number; toolCallId: string; args: Record<string, unknown>; createdAt: number };

// Pending actions live on the server, so the browser can only say approve/reject by id —
// it can't change what will be executed. (In memory: fine for a single-process prototype.)
const globalForAgent = globalThis as unknown as { pendingActions?: Map<string, StoredPending> };
const pendingActions = (globalForAgent.pendingActions ??= new Map());

function systemPrompt(user: User): string {
  const today = now();
  return `You are the booking assistant for Studio Nova, a beauty salon. You are talking to ${user.name} (user id ${user.id}), who manages their own bookings through you.

Current local time: ${today.toFormat("cccc yyyy-MM-dd HH:mm")} (${TIMEZONE}). Tomorrow is ${today.plus({ days: 1 }).toFormat("cccc yyyy-MM-dd")}.

How to work:
- Use the tools to read and change data. Never invent bookings, ids or results.
- Times are local salon time in the format "YYYY-MM-DD HH:mm". Bookings last 60 minutes unless the user says otherwise.
- To change or cancel a booking, first call get_bookings to find its id. If it's unclear which booking the user means, ask.
- Each booking from get_bookings has a "day" label like "Mon 2 Nov (tomorrow)"; use it to get relative days right.
- When the user asks to create, change or cancel something, call the tool directly. The app shows the user an Approve / Reject button for every change, so don't ask for confirmation in text first, and don't say it's done until a tool result says ok.
- If a tool returns an error, explain it briefly and suggest what to do.
- If asked for a random client name, invent a plausible first name.
- Keep replies short. List bookings one per line as "#id Client — date time–time".`;
}

/** Handles a new user message. `history` is the conversation so far (kept by the browser). */
export async function runAgent(opts: {
  userId: number;
  history: ChatMessage[];
  text: string;
  provider?: Provider;
}): Promise<AgentResult> {
  const user = await getUser(opts.userId);
  if (!user) throw new BookingError(`Unknown user ${opts.userId}.`);
  const messages: ChatMessage[] = [...opts.history, { role: "user", content: opts.text }];
  return continueAgent({ user, messages, provider: opts.provider ?? getProvider() });
}

async function continueAgent({ user, messages, provider }: { user: User; messages: ChatMessage[]; provider: Provider }): Promise<AgentResult> {
  const events: ToolEvent[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply: AssistantMessage = await provider.complete({ system: systemPrompt(user), messages, tools: TOOLS });
    messages.push(reply);
    if (!reply.tool_calls?.length) return { messages, reply: reply.content ?? "", pending: null, events };

    let pending: PendingAction | null = null;
    for (const call of reply.tool_calls) {
      const tool = findTool(call.function.name);
      const args = parseArgs(call.function.arguments);
      const event: ToolEvent = { tool: call.function.name, kind: tool?.kind ?? "read", args };
      events.push(event);
      const answer = (content: unknown) => messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

      try {
        if (!tool) throw new BookingError(`There is no tool called ${call.function.name}.`);
        if (tool.kind === "read") {
          answer(await runReadTool(tool.name, args, { userId: user.id }));
        } else if (pending) {
          answer({ error: "Only one change can be approved at a time. Propose this one again after the current change is approved or rejected." });
        } else {
          const summary = await previewWriteTool(tool.name, args, { userId: user.id });
          pending = { id: randomUUID(), tool: tool.name, summary };
          pendingActions.set(pending.id, { ...pending, userId: user.id, toolCallId: call.id, args, createdAt: Date.now() });
          // No tool result yet: it's added when the user approves or rejects.
        }
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        event.error = error.message;
        answer({ error: error.message }); // the model sees the problem and explains it
      }
    }
    if (pending) return { messages, reply: reply.content, pending, events };
  }
  return { messages, reply: "Sorry, I couldn't finish that request. Could you rephrase it?", pending: null, events };
}

/** Runs (or discards) a pending action after the user clicks Approve or Reject. */
export async function resolvePending(opts: {
  userId: number;
  history: ChatMessage[];
  pendingId: string;
  approved: boolean;
}): Promise<AgentResult> {
  const stored = pendingActions.get(opts.pendingId);
  if (!stored || stored.userId !== opts.userId)
    return { messages: opts.history, reply: "That change is no longer pending, so nothing was done.", pending: null, events: [] };
  pendingActions.delete(opts.pendingId);

  const messages = [...opts.history];
  const answer = (content: unknown) => messages.push({ role: "tool", tool_call_id: stored.toolCallId, content: JSON.stringify(content) });
  let text: string;
  let changedBookingId: number | undefined;

  if (!opts.approved) {
    answer({ error: "The user rejected this change. Nothing was changed." });
    text = "Okay — I didn't change anything.";
  } else {
    try {
      const { result, message, bookingId } = await runWriteTool(stored.tool, stored.args, { userId: opts.userId });
      answer(result);
      text = message;
      changedBookingId = bookingId;
    } catch (error) {
      if (!(error instanceof BookingError)) throw error;
      answer({ error: error.message });
      text = `I couldn't make that change: ${error.message} Nothing was changed.`;
    }
  }
  // The confirmation text comes from our code, not the model: it reports what actually happened.
  messages.push({ role: "assistant", content: text });
  return { messages, reply: text, pending: null, events: [], changedBookingId };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
