"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bubble, PendingAction } from "@/lib/chat-types.ts";
import { clockTime } from "../ui.ts";

const SUGGESTIONS = [
  { label: "Create a booking", text: "Create a booking for 2pm tomorrow under a random name" },
  { label: "Move it", text: "Change it to 4pm" },
  { label: "See everything", text: "Get all bookings" },
  { label: "Find a gap", text: "When am I free tomorrow afternoon?" },
  { label: "Cancel one", text: "Cancel Julia's booking" },
  { label: "Undo", text: "Undo my last change" },
];

const TOOL_LABELS: Record<string, string> = {
  get_bookings: "Looked up bookings",
  get_clients: "Looked up clients",
  find_free_slots: "Checked free times",
  create_booking: "Create booking",
  update_booking: "Change booking",
  cancel_booking: "Cancel booking",
  undo_last_change: "Undo",
};

export function Chat(props: {
  userName: string;
  timezone: string;
  bubbles: Bubble[];
  busy: boolean;
  onSend: (text: string) => void;
  onDecide: (pending: PendingAction, approved: boolean) => void;
}) {
  const { bubbles, busy } = props;
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const waiting = bubbles.some((b) => b.pending && !b.decision);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, busy]);

  useEffect(() => {
    if (!busy && !waiting) inputRef.current?.focus();
  }, [busy, waiting]);

  function submit(text: string) {
    if (!text.trim() || busy || waiting) return;
    props.onSend(text.trim());
    setInput("");
  }

  return (
    <section className="panel chat" aria-label="Chat with the assistant">
      <div className="messages">
        <div className="msg assistant intro">
          <div className="avatar">AI</div>
          <div className="bubble">
            Hi {props.userName}! I can look up, book, move and cancel your appointments, find free times, and undo changes. I&apos;ll always ask for
            your approval before changing anything.
          </div>
        </div>

        {bubbles.length === 0 && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.text} onClick={() => submit(s.text)} disabled={busy}>
                <strong>{s.label}</strong>
                <span>{s.text}</span>
              </button>
            ))}
          </div>
        )}

        {bubbles.map((b) => (
          <div key={b.id} className={`msg ${b.role}`}>
            {b.role !== "user" && <div className="avatar">{b.role === "error" ? "!" : "AI"}</div>}
            <div className="msg-body">
              {b.events && b.events.length > 0 && (
                <div className="events">
                  {b.events.map((e, i) => (
                    <span key={i} className={`event ${e.kind}${e.error ? " failed" : ""}`} title={`${e.tool} ${JSON.stringify(e.args)}${e.error ? `\n${e.error}` : ""}`}>
                      {e.kind === "read" ? "↳ " : "✎ "}
                      {TOOL_LABELS[e.tool] ?? e.tool}
                      {e.error ? " · refused" : ""}
                    </span>
                  ))}
                </div>
              )}
              {b.text && <div className={`bubble${b.done ? " done" : ""}`}>{formatText(b.text)}</div>}
              {b.pending && <ApprovalCard pending={b.pending} decision={b.decision} busy={busy} onDecide={props.onDecide} />}
              <div className="time">{clockTime(b.at, props.timezone)}</div>
            </div>
          </div>
        ))}

        {busy && (
          <div className="msg assistant">
            <div className="avatar">AI</div>
            <div className="bubble typing" aria-label="Assistant is thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {bubbles.length > 0 && (
        <div className="quick">
          {SUGGESTIONS.slice(0, 4).map((s) => (
            <button key={s.text} onClick={() => submit(s.text)} disabled={busy || waiting}>
              {s.text}
            </button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(input);
            }
          }}
          placeholder={waiting ? "Approve or reject the change above first…" : "Ask about or change your bookings…"}
          disabled={busy || waiting}
        />
        <button type="submit" disabled={busy || waiting || !input.trim()} aria-label="Send">
          Send
        </button>
      </form>
    </section>
  );
}

const KIND_ICON = { create: "+", update: "↻", cancel: "✕", undo: "↶" } as const;

function ApprovalCard(props: { pending: PendingAction; decision?: Bubble["decision"]; busy: boolean; onDecide: (p: PendingAction, approved: boolean) => void }) {
  const { pending, decision } = props;
  const d = pending.details;
  const danger = d.kind === "cancel";
  const status = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : decision === "failed" ? "Couldn't apply" : "Needs your approval";
  return (
    <div className={`approval ${d.kind} ${decision ?? "open"}`}>
      <div className="approval-head">
        <span className="approval-icon">{KIND_ICON[d.kind]}</span>
        <span className="approval-title">{d.title}</span>
        <span className="approval-status">{status}</span>
      </div>
      <div className="approval-rows">
        {d.from && (
          <div className="row">
            <span className="label">{d.to ? "From" : d.kind === "cancel" ? "Booking" : ""}</span>
            <span className={d.kind === "cancel" ? "strike" : ""}>{d.from}</span>
          </div>
        )}
        {d.to && (
          <div className="row">
            <span className="label">{d.from ? "To" : "Booking"}</span>
            <span className="strong">{d.to}</span>
          </div>
        )}
      </div>
      {!decision && (
        <div className="approval-actions">
          <button className={danger ? "danger" : "primary"} disabled={props.busy} onClick={() => props.onDecide(pending, true)}>
            {danger ? "Approve cancellation" : "Approve"}
          </button>
          <button className="ghost" disabled={props.busy} onClick={() => props.onDecide(pending, false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** Minimal formatting for AI replies: line breaks, "-" / "•" bullet lists and **bold**. */
function formatText(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul${out.length}`}>{list.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of lines) {
    const item = line.match(/^\s*(?:[-•*]|\d+\.)\s+(.*)$/);
    if (item) list.push(item[1]);
    else {
      flush();
      if (line.trim()) out.push(<p key={`p${out.length}`}>{bold(line)}</p>);
    }
  }
  flush();
  return out;
}

function bold(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}
