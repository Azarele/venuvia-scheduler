// Conversations and pending approvals live in Postgres, so a page refresh or a
// server restart keeps the chat and any change still waiting for Approve/Reject.
import type { ChatMessage } from "./ai/providers.ts";
import type { Bubble, PendingAction } from "./chat-types.ts";
import { pool } from "./db.ts";
import type { Lang } from "./lang.ts";

const MAX_HISTORY = 40; // messages sent to the AI; older ones are dropped to keep calls small
const MAX_BUBBLES = 200;

export type Conversation = { history: ChatMessage[]; bubbles: Bubble[] };

const LOCK_NAMESPACE = 4242; // arbitrary; keeps these advisory locks apart from any others

/**
 * Runs `work` while holding a per-user Postgres advisory lock, so two tabs (or a double
 * submit) can't load the same chat, change it in parallel, and overwrite each other's
 * messages. A second request simply waits until the first has saved, then builds on it.
 */
export async function withConversationLock<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const lock = await pool.connect();
  try {
    await lock.query("select set_config('lock_timeout', '150s', false)"); // longer than one AI turn
    await lock.query("select pg_advisory_lock($1, $2)", [LOCK_NAMESPACE, userId]);
    try {
      return await work();
    } finally {
      await lock.query("select pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, userId]);
    }
  } finally {
    await lock.query("reset lock_timeout").catch(() => {});
    lock.release();
  }
}

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
  await withConversationLock(userId, async () => {
    await pool.query("update pending_actions set status = 'rejected', resolved_at = now() where user_id = $1 and status = 'pending'", [userId]);
    await pool.query("delete from conversations where user_id = $1", [userId]);
  });
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

export type StoredPending = PendingAction & { userId: number; args: Record<string, unknown>; toolCallId: string | null; lang: Lang };

export async function createPending(p: StoredPending): Promise<void> {
  await pool.query(
    `insert into pending_actions (id, user_id, tool, args, tool_call_id, summary) values ($1, $2, $3, $4, $5, $6)`,
    [p.id, p.userId, p.tool, JSON.stringify({ args: p.args, details: p.details, lang: p.lang }), p.toolCallId, p.summary],
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

function fromRow(r: { id: string; user_id: number; tool: string; args: { args: Record<string, unknown>; details: PendingAction["details"]; lang?: Lang }; tool_call_id: string | null; summary: string }): StoredPending {
  return { id: r.id, userId: r.user_id, tool: r.tool, args: r.args.args, details: r.args.details, toolCallId: r.tool_call_id, summary: r.summary, lang: r.args.lang ?? "en" };
}
