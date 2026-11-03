// The agent loop:
//   1. Send the conversation + tools to the model.
//   2. Read tools (get_bookings, get_clients, find_free_slots) run immediately and the loop continues.
//   3. A write tool (create/update/cancel/undo) is checked, saved as a *pending action*, and the
//      loop stops. Nothing is written until the user clicks Approve (resolvePending).
// The conversation and pending actions are stored in Postgres (see conversation.ts).
import { randomUUID } from "node:crypto";
import { BookingError, BUSINESS_HOURS, getClients, getUser, type User } from "../bookings.ts";
import type { Bubble, PendingAction, ToolEvent } from "../chat-types.ts";
import {
  claimPending,
  createPending,
  loadConversation,
  markPendingFailed,
  openPendings,
  saveConversation,
  type Conversation,
} from "../conversation.ts";
import { now, TIMEZONE } from "../time.ts";
import { getProvider, type AssistantMessage, type ChatMessage, type Provider } from "./providers.ts";
import { findTool, previewWriteTool, runReadTool, runWriteTool, TOOLS } from "./tools.ts";

const MAX_STEPS = 6;

export type AgentResult = {
  bubbles: Bubble[]; // the whole visible conversation
  pending: PendingAction | null;
  events: ToolEvent[];
  reply: string | null;
  changedBookingId?: number;
};

async function systemPrompt(user: User): Promise<string> {
  const today = now();
  const clients = (await getClients()).slice(0, 100).map((c) => c.name);
  return `You are the booking assistant for Studio Nova, a beauty salon. You are talking to ${user.name} (user id ${user.id}), who manages their own bookings through you.

Current local time: ${today.toFormat("cccc yyyy-MM-dd HH:mm")} (${TIMEZONE}). Tomorrow is ${today.plus({ days: 1 }).toFormat("cccc yyyy-MM-dd")}.
Opening hours: ${BUSINESS_HOURS.open}–${BUSINESS_HOURS.close}.
Existing clients: ${clients.join(", ") || "none"}.

How to work:
- Use the tools to read and change data. Never invent bookings, ids or results.
- Times are local salon time in the format "YYYY-MM-DD HH:mm". Bookings last 60 minutes unless the user says otherwise.
- To create a booking, call create_booking directly; don't look anything up first. The app checks for clashes and will tell you (with free times) if the slot is taken.
- To change or cancel a booking, first call get_bookings to find its id. If it's unclear which booking the user means, ask.
- If a request would change or cancel more than one booking (e.g. "delete everything", "cancel all my bookings"), don't call any write tool yet: list what would be affected and ask the user to confirm. Then propose the changes one at a time.
- Each booking from get_bookings has a "day" label like "Mon 2 Nov (tomorrow)"; use it to get relative days right.
- When the user asks to create, change, cancel or undo something, call the tool directly. The app shows the user an Approve / Reject button for every change, so don't ask for confirmation in text first, and don't say it's done until a tool result says ok.
- If a time is taken, the error lists the nearest free times; offer those (or call find_free_slots) instead of just saying no.
- If a tool returns any other error, explain it briefly and suggest what to do.
- If asked for a random client name, invent a plausible first name that is NOT one of the existing clients.
- Keep replies short. List bookings one per line as "#id Client — Day date, time–time".`;
}

const bubble = (b: Omit<Bubble, "id" | "at">): Bubble => ({ id: randomUUID(), at: new Date().toISOString(), ...b });

/** Handles a new user message. */
export async function runAgent(opts: { userId: number; text: string; provider?: Provider }): Promise<AgentResult> {
  const user = await getUser(opts.userId);
  if (!user) throw new BookingError(`Unknown user ${opts.userId}.`);
  const convo = await loadConversation(user.id);
  await dropOpenPendings(user.id, convo); // typing something new means "not that"

  const historyLength = convo.history.length;
  convo.history.push({ role: "user", content: opts.text });
  convo.bubbles.push(bubble({ role: "user", text: opts.text }));

  try {
    const result = await loop(user, convo.history, opts.provider ?? getProvider());
    convo.bubbles.push(bubble({ role: "assistant", text: result.reply ?? "", events: result.events, pending: result.pending ?? undefined }));
    await saveConversation(user.id, convo);
    return { ...result, bubbles: convo.bubbles };
  } catch (error) {
    // Roll the AI's transcript back to before this message (no half-finished tool calls),
    // but keep the visible chat so the user sees what failed.
    convo.history.length = historyLength;
    convo.bubbles.push(bubble({ role: "error", text: (error as Error).message }));
    await saveConversation(user.id, convo);
    throw error;
  }
}

async function loop(user: User, history: ChatMessage[], provider: Provider) {
  const events: ToolEvent[] = [];
  const system = await systemPrompt(user);
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply: AssistantMessage = await provider.complete({ system, messages: history, tools: TOOLS });
    history.push(reply);
    if (!reply.tool_calls?.length) return { reply: reply.content ?? "", pending: null, events };

    let pending: PendingAction | null = null;
    for (const call of reply.tool_calls) {
      const tool = findTool(call.function.name);
      const args = parseArgs(call.function.arguments);
      const event: ToolEvent = { tool: call.function.name, kind: tool?.kind ?? "read", args };
      events.push(event);
      const answer = (content: unknown) => history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

      try {
        if (!tool) throw new BookingError(`There is no tool called ${call.function.name}.`);
        if (tool.kind === "read") {
          answer(await runReadTool(tool.name, args, { userId: user.id }));
        } else if (pending) {
          answer({ error: "Only one change can be approved at a time. Propose this one again after the current change is approved or rejected." });
        } else {
          const { summary, details } = await previewWriteTool(tool.name, args, { userId: user.id });
          pending = { id: randomUUID(), tool: tool.name, summary, details };
          await createPending({ ...pending, userId: user.id, args, toolCallId: call.id });
          // No tool result yet: it's added when the user approves or rejects.
        }
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        event.error = error.message;
        answer({ error: error.message }); // the model sees the problem and explains it
      }
    }
    if (pending) return { reply: reply.content, pending, events };
  }
  return { reply: "Sorry, I couldn't finish that request. Could you rephrase it?", pending: null, events };
}

/** Runs (or discards) a pending action after the user clicks Approve or Reject. */
export async function resolvePending(opts: { userId: number; pendingId: string; approved: boolean }): Promise<AgentResult> {
  const convo = await loadConversation(opts.userId);
  const stored = await claimPending(opts.pendingId, opts.userId, opts.approved ? "approved" : "rejected");
  if (!stored) {
    convo.bubbles.push(bubble({ role: "assistant", text: "That change is no longer pending, so nothing was done." }));
    await saveConversation(opts.userId, convo);
    return { bubbles: convo.bubbles, pending: null, events: [], reply: null };
  }

  let text: string;
  let toolResult: unknown;
  let decision: Bubble["decision"] = opts.approved ? "approved" : "rejected";
  let changedBookingId: number | undefined;

  if (!opts.approved) {
    toolResult = { error: "The user rejected this change. Nothing was changed." };
    text = "Okay — I didn't change anything.";
  } else {
    try {
      const source = stored.toolCallId ? "ai" : "undo-button";
      const { result, message, bookingId } = await runWriteTool(stored.tool, stored.args, { userId: opts.userId, source });
      toolResult = result;
      text = message;
      changedBookingId = bookingId;
    } catch (error) {
      if (!(error instanceof BookingError)) throw error;
      await markPendingFailed(stored.id);
      decision = "failed";
      toolResult = { error: error.message };
      text = `I couldn't make that change: ${error.message} Nothing was changed.`;
    }
  }

  // Tell the AI what happened. The confirmation text comes from our code, not the model.
  if (stored.toolCallId) convo.history.push({ role: "tool", tool_call_id: stored.toolCallId, content: JSON.stringify(toolResult) });
  convo.history.push({ role: "assistant", content: stored.toolCallId ? text : `(The user used the Undo button.) ${text}` });
  convo.bubbles = convo.bubbles.map((b) => (b.pending?.id === stored.id ? { ...b, decision } : b));
  convo.bubbles.push(bubble({ role: "assistant", text, done: Boolean(changedBookingId) }));
  await saveConversation(opts.userId, convo);
  return { bubbles: convo.bubbles, pending: null, events: [], reply: text, changedBookingId };
}

/** The Undo button: proposes undoing the last change directly, without asking the AI. */
export async function proposeUndo(userId: number): Promise<AgentResult> {
  const convo = await loadConversation(userId);
  await dropOpenPendings(userId, convo);
  let pending: PendingAction | null = null;
  try {
    const { summary, details } = await previewWriteTool("undo_last_change", {}, { userId });
    pending = { id: randomUUID(), tool: "undo_last_change", summary, details };
    await createPending({ ...pending, userId, args: {}, toolCallId: null });
    convo.bubbles.push(bubble({ role: "assistant", text: "Undo your last change?", pending }));
  } catch (error) {
    if (!(error instanceof BookingError)) throw error;
    convo.bubbles.push(bubble({ role: "assistant", text: error.message }));
  }
  await saveConversation(userId, convo);
  return { bubbles: convo.bubbles, pending, events: [], reply: null };
}

/** Rejects any change still waiting, so the AI's transcript stays valid when the user moves on. */
async function dropOpenPendings(userId: number, convo: Conversation) {
  for (const p of await openPendings(userId)) {
    if (!(await claimPending(p.id, userId, "rejected"))) continue;
    if (p.toolCallId)
      convo.history.push({ role: "tool", tool_call_id: p.toolCallId, content: JSON.stringify({ error: "The user moved on without approving. Nothing was changed." }) });
    convo.bubbles = convo.bubbles.map((b) => (b.pending?.id === p.id ? { ...b, decision: "rejected" } : b));
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
