// The agent loop:
//   1. Send the conversation + tools to the model.
//   2. Read tools (get_bookings, get_clients, find_free_slots) run immediately and the loop continues.
//   3. A write tool (create/update/cancel/undo) is checked, saved as a *pending action*, and the
//      loop stops. Nothing is written until the user clicks Approve (resolvePending).
// The conversation and pending actions are stored in Postgres (see conversation.ts); each user's
// conversation is locked while a request works on it, so two tabs can't overwrite each other.
import { randomUUID } from "node:crypto";
import type { DateTime } from "luxon";
import { BookingError, BUSINESS_HOURS, getClients, getUser, type User } from "../bookings.ts";
import type { Bubble, PendingAction, Progress, ToolEvent } from "../chat-types.ts";
import {
  claimPending,
  createPending,
  loadConversation,
  markPendingFailed,
  openPendings,
  saveConversation,
  withConversationLock,
  type Conversation,
} from "../conversation.ts";
import { detectLanguage, type Lang } from "../lang.ts";
import { now, TIMEZONE } from "../time.ts";
import { addUsage, formatUsage, type TurnUsage } from "./pricing.ts";
import { getProvider, type AssistantMessage, type ChatMessage, type Provider } from "./providers.ts";
import { findTool, previewWriteTool, runReadTool, runWriteTool, TOOLS } from "./tools.ts";

const MAX_STEPS = 6;

export type AgentResult = {
  bubbles: Bubble[]; // the whole visible conversation
  pending: PendingAction | null;
  events: ToolEvent[];
  reply: string | null;
  changedBookingId?: number;
  usage?: TurnUsage;
};

/** What the user sees while the assistant works ("Looking up your bookings…"). */
const PROGRESS: Record<string, string> = {
  get_bookings: "Looking up your bookings…",
  get_clients: "Looking up clients…",
  find_free_slots: "Checking free times…",
  create_booking: "Checking the new booking…",
  update_booking: "Checking the change…",
  cancel_booking: "Checking the cancellation…",
  undo_last_change: "Working out what to undo…",
};

/** Messages our own code writes, in the conversation's language. */
const TEXT = {
  en: {
    rejected: "Okay — I didn't change anything.",
    failed: (msg: string) => `I couldn't make that change: ${msg} Nothing was changed.`,
    gone: "That change is no longer pending, so nothing was done.",
    undoAsk: "Undo your last change?",
    giveUp: "Sorry, I couldn't finish that request. Could you rephrase it?",
  },
  pl: {
    rejected: "W porządku — niczego nie zmieniłem.",
    failed: (msg: string) => `Nie udało się wprowadzić zmiany: ${msg} Nic nie zostało zmienione.`,
    gone: "Ta zmiana nie czeka już na zatwierdzenie, więc nic nie zrobiłem.",
    undoAsk: "Cofnąć ostatnią zmianę?",
    giveUp: "Przepraszam, nie udało mi się tego zrobić. Możesz napisać to inaczej?",
  },
} satisfies Record<Lang, unknown>;

async function systemPrompt(user: User): Promise<string> {
  const today = now();
  const clients = (await getClients()).slice(0, 100).map((c) => c.name);
  return `You are the booking assistant for Studio Nova, a beauty salon. You are talking to ${user.name} (user id ${user.id}), who manages their own bookings through you.

Current local time: ${today.toFormat("cccc yyyy-MM-dd HH:mm")} (${TIMEZONE}). Tomorrow is ${today.plus({ days: 1 }).toFormat("cccc yyyy-MM-dd")}.
Next 14 days: ${calendar(today)}.
Take dates from this list instead of calculating them. A weekday on its own ("Friday", "next Friday") means the first one after today.
Opening hours: ${BUSINESS_HOURS.open}–${BUSINESS_HOURS.close}. Bookings must fit inside them.
Existing clients: ${clients.join(", ") || "none"}.

How to work:
- Always reply in the language of the user's latest message (for example Polish or English). Tool arguments always use the formats below.
- Use the tools to read and change data. Never invent bookings, ids or results.
- Times are local salon time in the format "YYYY-MM-DD HH:mm". Bookings last 60 minutes unless the user says otherwise.
- To create a booking, call create_booking directly; don't look anything up first. The app checks for clashes and will tell you (with free times) if the slot is taken.
- To change or cancel a booking, first call get_bookings to find its id. If it's unclear which booking the user means, ask.
- If a request would change or cancel more than one booking (e.g. "delete everything", "cancel all my bookings"), don't call any write tool yet: list what would be affected and ask the user to confirm. Then propose the changes one at a time.
- Each booking from get_bookings has a "day" label like "Mon 2 Nov (tomorrow)"; use it to get relative days right.
- When the user asks to create, change, cancel or undo something, call the tool directly. The app shows the user an Approve / Reject button for every change, so don't ask for confirmation in text first, and don't say it's done until a tool result says ok.
- If a time is taken or outside opening hours, the error lists the nearest free times; offer those (or call find_free_slots) instead of just saying no.
- If a tool returns any other error, explain it briefly and suggest what to do.
- If asked for a random client name, invent a plausible first name that is NOT one of the existing clients.
- Keep replies short. List bookings one per line as "#id Client — Day date, time–time".`;
}

/** "Tue 2026-11-03 (today), Wed 2026-11-04 (tomorrow), Thu 2026-11-05, …" so the AI never does date maths. */
function calendar(today: DateTime): string {
  return Array.from({ length: 14 }, (_, i) => {
    const d = today.plus({ days: i });
    return `${d.toFormat("ccc yyyy-MM-dd")}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join(", ");
}

const bubble = (b: Omit<Bubble, "id" | "at">): Bubble => ({ id: randomUUID(), at: new Date().toISOString(), ...b });

/** The language of the user's most recent message in a conversation. */
function conversationLang(convo: Conversation): Lang {
  const lastUser = [...convo.bubbles].reverse().find((b) => b.role === "user");
  return lastUser ? detectLanguage(lastUser.text) : "en";
}

/**
 * Handles a new user message. `onProgress` receives live status lines while it works.
 * `retry` re-sends a message that failed (the old message and its error are replaced).
 */
export async function runAgent(opts: {
  userId: number;
  text: string;
  provider?: Provider;
  onProgress?: (p: Progress) => void;
  retry?: boolean;
}): Promise<AgentResult> {
  const user = await getUser(opts.userId);
  if (!user) throw new BookingError(`Unknown user ${opts.userId}.`);
  const provider = opts.provider ?? getProvider();

  return withConversationLock(user.id, async () => {
    const convo = await loadConversation(user.id);
    if (opts.retry) {
      const [prev, last] = convo.bubbles.slice(-2);
      if (last?.role === "error" && last.retryText === opts.text && prev?.role === "user") convo.bubbles.splice(-2, 2);
    }
    await dropOpenPendings(user.id, convo); // typing something new means "not that"

    const lang = detectLanguage(opts.text);
    const historyLength = convo.history.length;
    convo.history.push({ role: "user", content: opts.text });
    convo.bubbles.push(bubble({ role: "user", text: opts.text }));

    try {
      const result = await loop(user, convo.history, provider, lang, opts.onProgress ?? (() => {}));
      convo.bubbles.push(
        bubble({ role: "assistant", text: result.reply ?? "", events: result.events, pending: result.pending ?? undefined, usage: result.usage }),
      );
      await saveConversation(user.id, convo);
      if (process.env.AI_USAGE_LOG !== "0") console.log(`[ai] user ${user.id} · ${provider.name} ${provider.model} · ${formatUsage(result.usage)}`);
      return { ...result, bubbles: convo.bubbles };
    } catch (error) {
      // Roll the AI's transcript back to before this message (no half-finished tool calls),
      // but keep the visible chat so the user sees what failed, with a Retry button.
      convo.history.length = historyLength;
      convo.bubbles.push(bubble({ role: "error", text: (error as Error).message, retryText: opts.text }));
      await saveConversation(user.id, convo);
      throw error;
    }
  });
}

async function loop(user: User, history: ChatMessage[], provider: Provider, lang: Lang, onProgress: (p: Progress) => void) {
  const events: ToolEvent[] = [];
  let usage: TurnUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, model: provider.model };
  const system = await systemPrompt(user);
  for (let step = 0; step < MAX_STEPS; step++) {
    onProgress({ label: "Thinking…" });
    const { usage: callUsage, ...reply }: AssistantMessage = await provider.complete({ system, messages: history, tools: TOOLS });
    usage = addUsage(usage, callUsage);
    history.push(reply);
    if (!reply.tool_calls?.length) return { reply: reply.content ?? "", pending: null, events, usage };

    let pending: PendingAction | null = null;
    for (const call of reply.tool_calls) {
      const tool = findTool(call.function.name);
      const args = parseArgs(call.function.arguments);
      const event: ToolEvent = { tool: call.function.name, kind: tool?.kind ?? "read", args };
      events.push(event);
      onProgress({ label: PROGRESS[call.function.name] ?? "Working…" });
      const answer = (content: unknown) => history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

      try {
        if (!tool) throw new BookingError(`There is no tool called ${call.function.name}.`);
        if (tool.kind === "read") {
          answer(await runReadTool(tool.name, args, { userId: user.id }));
        } else if (pending) {
          answer({ error: "Only one change can be approved at a time. Propose this one again after the current change is approved or rejected." });
        } else {
          const { summary, details } = await previewWriteTool(tool.name, args, { userId: user.id, lang });
          pending = { id: randomUUID(), tool: tool.name, summary, details };
          await createPending({ ...pending, userId: user.id, args, toolCallId: call.id, lang });
          // No tool result yet: it's added when the user approves or rejects.
        }
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        event.error = error.message;
        answer({ error: error.message }); // the model sees the problem and explains it
      }
    }
    if (pending) return { reply: reply.content, pending, events, usage };
  }
  return { reply: TEXT[lang].giveUp, pending: null, events, usage };
}

/** Runs (or discards) a pending action after the user clicks Approve or Reject. */
export async function resolvePending(opts: { userId: number; pendingId: string; approved: boolean }): Promise<AgentResult> {
  return withConversationLock(opts.userId, async () => {
    const convo = await loadConversation(opts.userId);
    const stored = await claimPending(opts.pendingId, opts.userId, opts.approved ? "approved" : "rejected");
    if (!stored) {
      convo.bubbles.push(bubble({ role: "assistant", text: TEXT[conversationLang(convo)].gone }));
      await saveConversation(opts.userId, convo);
      return { bubbles: convo.bubbles, pending: null, events: [], reply: null };
    }

    const t = TEXT[stored.lang];
    let text: string;
    let toolResult: unknown;
    let decision: Bubble["decision"] = opts.approved ? "approved" : "rejected";
    let changedBookingId: number | undefined;

    if (!opts.approved) {
      toolResult = { error: "The user rejected this change. Nothing was changed." };
      text = t.rejected;
    } else {
      try {
        const source = stored.toolCallId ? "ai" : "undo-button";
        const { result, message, bookingId } = await runWriteTool(stored.tool, stored.args, { userId: opts.userId, source, lang: stored.lang });
        toolResult = result;
        text = message;
        changedBookingId = bookingId;
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        await markPendingFailed(stored.id);
        decision = "failed";
        toolResult = { error: error.message };
        text = t.failed(error.message);
      }
    }

    // Tell the AI what happened. The confirmation text comes from our code, not the model.
    if (stored.toolCallId) convo.history.push({ role: "tool", tool_call_id: stored.toolCallId, content: JSON.stringify(toolResult) });
    convo.history.push({ role: "assistant", content: stored.toolCallId ? text : `(The user used the Undo button.) ${text}` });
    convo.bubbles = convo.bubbles.map((b) => (b.pending?.id === stored.id ? { ...b, decision } : b));
    convo.bubbles.push(bubble({ role: "assistant", text, done: Boolean(changedBookingId) }));
    await saveConversation(opts.userId, convo);
    return { bubbles: convo.bubbles, pending: null, events: [], reply: text, changedBookingId };
  });
}

/** The Undo button: proposes undoing the last change directly, without asking the AI. */
export async function proposeUndo(userId: number): Promise<AgentResult> {
  return withConversationLock(userId, async () => {
    const convo = await loadConversation(userId);
    await dropOpenPendings(userId, convo);
    const lang = conversationLang(convo);
    let pending: PendingAction | null = null;
    try {
      const { summary, details } = await previewWriteTool("undo_last_change", {}, { userId, lang });
      pending = { id: randomUUID(), tool: "undo_last_change", summary, details };
      await createPending({ ...pending, userId, args: {}, toolCallId: null, lang });
      convo.bubbles.push(bubble({ role: "assistant", text: TEXT[lang].undoAsk, pending }));
    } catch (error) {
      if (!(error instanceof BookingError)) throw error;
      convo.bubbles.push(bubble({ role: "assistant", text: error.message }));
    }
    await saveConversation(userId, convo);
    return { bubbles: convo.bubbles, pending, events: [], reply: null };
  });
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
