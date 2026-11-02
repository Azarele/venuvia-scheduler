// Conversations and pending approvals live in Postgres, so a page refresh or a
// server restart keeps the chat and any change still waiting for Approve/Reject.
import type { ChatMessage } from "./ai/providers.ts";
import type { Bubble, PendingAction } from "./chat-types.ts";
import { pool } from "./db.ts";

const MAX_HISTORY = 40; // messages sent to the AI; older ones are dropped to keep calls small
const MAX_BUBBLES = 200;

export type Conversation = { history: ChatMessage[]; bubbles: Bubble[] };

export async function loadConversation(userId: number): Promise<Conversation> {
  const { rows } = await pool.query<Conversation>("select history, bubbles from conversations where user_id = $1", [userId]);
  return rows[0] ?? { history: [], bubbles: [] };
}

export async function saveConversation(userId: number, { history, bubbles }: Conversation): Promise<void> {
  await pool.query(
    `insert into conversations (user_id, history, bubbles, updated_at) values ($1, $2, $3, now())
     on conflict (user_id) do update set history = excluded.history, bubbles = excluded.bubbles, updated_at = now()`,
    [userId, JSON.stringify(trimHistory(history)), JSON.stringify(bubbles.slice(-MAX_BUBBLES))],
  );
}

export async function clearConversation(userId: number): Promise<void> {
  await pool.query("update pending_actions set status = 'rejected', resolved_at = now() where user_id = $1 and status = 'pending'", [userId]);
  await pool.query("delete from conversations where user_id = $1", [userId]);
}

/**
 * Keeps the last ~MAX_HISTORY messages, cutting only at a user message so a tool
 * call is never separated from its result (providers reject that).
 */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_HISTORY) return history;
  for (let i = history.length - MAX_HISTORY; i < history.length; i++) {
    if (history[i].role === "user") return history.slice(i);
  }
  return history;
}

// ---------- Pending approvals ----------

export type StoredPending = PendingAction & { userId: number; args: Record<string, unknown>; toolCallId: string | null };

export async function createPending(p: StoredPending): Promise<void> {
  await pool.query(
    `insert into pending_actions (id, user_id, tool, args, tool_call_id, summary) values ($1, $2, $3, $4, $5, $6)`,
    [p.id, p.userId, p.tool, JSON.stringify({ args: p.args, details: p.details }), p.toolCallId, p.summary],
  );
}

/**
 * Atomically moves a pending action out of 'pending'. Returns null if it was already
 * resolved (e.g. a double click), so a change can never run twice.
 */
export async function claimPending(id: string, userId: number, status: "approved" | "rejected"): Promise<StoredPending | null> {
  const { rows } = await pool.query(
    `update pending_actions set status = $3, resolved_at = now()
     where id = $1 and user_id = $2 and status = 'pending'
     returning id, user_id, tool, args, tool_call_id, summary`,
    [id, userId, status],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function markPendingFailed(id: string): Promise<void> {
  await pool.query("update pending_actions set status = 'failed' where id = $1", [id]);
}

export async function openPendings(userId: number): Promise<StoredPending[]> {
  const { rows } = await pool.query(
    "select id, user_id, tool, args, tool_call_id, summary from pending_actions where user_id = $1 and status = 'pending'",
    [userId],
  );
  return rows.map(fromRow);
}

function fromRow(r: { id: string; user_id: number; tool: string; args: { args: Record<string, unknown>; details: PendingAction["details"] }; tool_call_id: string | null; summary: string }): StoredPending {
  return { id: r.id, userId: r.user_id, tool: r.tool, args: r.args.args, details: r.args.details, toolCallId: r.tool_call_id, summary: r.summary };
}
