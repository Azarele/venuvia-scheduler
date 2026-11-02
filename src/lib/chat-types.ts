// Types shared by the server and the browser (no server imports here).

export type ToolEvent = { tool: string; kind: "read" | "write"; args: Record<string, unknown>; error?: string };

export type PendingDetails = {
  kind: "create" | "update" | "cancel" | "undo";
  title: string;
  from?: string;
  to?: string;
};

export type PendingAction = { id: string; tool: string; summary: string; details: PendingDetails };

/** One message as the user sees it in the chat. */
export type Bubble = {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  at: string; // ISO timestamp
  events?: ToolEvent[];
  pending?: PendingAction;
  decision?: "approved" | "rejected" | "failed";
  done?: boolean; // a change was applied
};
