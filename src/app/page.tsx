"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolEvent, PendingAction } from "@/lib/ai/agent.ts";
import type { ChatMessage } from "@/lib/ai/providers.ts";
import type { Booking, Client, User } from "@/lib/bookings.ts";

type Info = { users: User[]; ai: { name: string; model: string } | { error: string } };
type Bubble = {
  role: "user" | "assistant" | "error";
  text: string;
  events?: ToolEvent[];
  pending?: PendingAction;
  decision?: "approved" | "rejected";
  done?: boolean;
};

const EXAMPLES = ["Create a booking for 2pm tomorrow under a random name", "Change it to 4pm", "Get all bookings", "Cancel Julia's booking"];

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export default function Home() {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]); // what the AI sees
  const [bubbles, setBubbles] = useState<Bubble[]>([]); // what the user sees
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const openPending = bubbles.find((b) => b.pending && !b.decision)?.pending ?? null;
  const user = info?.users.find((u) => u.id === userId);

  const refresh = useCallback(async (uid: number) => {
    const [b, c] = await Promise.all([get<{ bookings: Booking[] }>(`/api/bookings?userId=${uid}`), get<{ clients: Client[] }>("/api/clients")]);
    setBookings(b.bookings);
    setClients(c.clients);
  }, []);

  useEffect(() => {
    get<Info>("/api/info")
      .then((data) => {
        setInfo(data);
        setUserId(data.users[0]?.id ?? null);
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (userId == null) return;
    setHistory([]);
    setBubbles([]);
    refresh(userId).catch((e) => setLoadError(e.message));
  }, [userId, refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, busy]);

  async function send(text: string) {
    if (!text.trim() || busy || openPending || userId == null) return;
    setInput("");
    setBubbles((b) => [...b, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await post<{ messages: ChatMessage[]; reply: string | null; pending: PendingAction | null; events: ToolEvent[] }>(
        "/api/chat",
        { userId, history, text },
      );
      setHistory(res.messages);
      setBubbles((b) => [...b, { role: "assistant", text: res.reply ?? "", events: res.events, pending: res.pending ?? undefined }]);
      await refresh(userId);
    } catch (e) {
      setBubbles((b) => [...b, { role: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  async function decide(pending: PendingAction, approved: boolean) {
    if (userId == null) return;
    setBubbles((b) => b.map((x) => (x.pending?.id === pending.id ? { ...x, decision: approved ? "approved" : "rejected" } : x)));
    setBusy(true);
    try {
      const res = await post<{ messages: ChatMessage[]; reply: string; changedBookingId?: number }>("/api/approve", {
        userId,
        history,
        pendingId: pending.id,
        approved,
      });
      setHistory(res.messages);
      setBubbles((b) => [...b, { role: "assistant", text: res.reply, done: Boolean(res.changedBookingId) }]);
      setHighlight(res.changedBookingId ?? null);
      await refresh(userId);
    } catch (e) {
      setBubbles((b) => [...b, { role: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const aiLabel = !info ? "…" : "error" in info.ai ? "AI not configured" : `${info.ai.name} · ${info.ai.model}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">V</span>
          <div>
            <div className="brand-title">Studio Nova</div>
            <div className="brand-sub">AI booking assistant</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`badge ${info && "error" in info.ai ? "warn" : ""}`} title={info && "error" in info.ai ? info.ai.error : undefined}>
            {aiLabel}
          </span>
          <label className="user-picker">
            Signed in as
            <select value={userId ?? ""} onChange={(e) => setUserId(Number(e.target.value))} disabled={busy}>
              {info?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} (user {u.id})
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loadError && <div className="banner">{loadError}</div>}
      {info && "error" in info.ai && <div className="banner">{info.ai.error}</div>}

      <main className="layout">
        <section className="panel chat">
          <div className="messages">
            <div className="bubble assistant">
              Hi{user ? ` ${user.name}` : ""}! I can look up, create and change your bookings. I&apos;ll ask for your approval before changing anything.
            </div>
            {bubbles.map((b, i) => (
              <div key={i} className={`bubble ${b.role}${b.done ? " done" : ""}`}>
                {b.events && b.events.length > 0 && (
                  <div className="events">
                    {b.events.map((e, j) => (
                      <span key={j} className={`event ${e.kind}${e.error ? " failed" : ""}`} title={JSON.stringify(e.args)}>
                        {e.kind === "read" ? "🔍" : "✏️"} {e.tool}
                        {e.error ? " — rejected by checks" : ""}
                      </span>
                    ))}
                  </div>
                )}
                {b.text && <div className="text">{b.text}</div>}
                {b.pending && (
                  <div className={`approval ${b.decision ?? "open"}`}>
                    <div className="approval-title">
                      {b.decision === "approved" ? "✓ Approved" : b.decision === "rejected" ? "✕ Rejected" : "Approval needed"}
                    </div>
                    <div className="approval-summary">{b.pending.summary}</div>
                    {!b.decision && (
                      <div className="approval-actions">
                        <button
                          className={b.pending.tool === "cancel_booking" ? "danger" : "primary"}
                          disabled={busy}
                          onClick={() => decide(b.pending!, true)}
                        >
                          {b.pending.tool === "cancel_booking" ? "Approve cancellation" : "Approve"}
                        </button>
                        <button disabled={busy} onClick={() => decide(b.pending!, false)}>
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="bubble assistant typing">Thinking…</div>}
            <div ref={bottomRef} />
          </div>

          <div className="examples">
            {EXAMPLES.map((e) => (
              <button key={e} onClick={() => send(e)} disabled={busy || !!openPending}>
                {e}
              </button>
            ))}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={openPending ? "Approve or reject the change above first" : "Ask about or change your bookings…"}
              disabled={busy || !!openPending}
              autoFocus
            />
            <button type="submit" disabled={busy || !!openPending || !input.trim()}>
              Send
            </button>
          </form>
        </section>

        <aside className="side">
          <section className="panel">
            <h2>
              Bookings <span className="muted">· {user?.name ?? "…"} · {bookings.filter((b) => b.status === "confirmed").length} active</span>
            </h2>
            {bookings.length === 0 ? (
              <p className="empty">No bookings yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Client</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Service</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr
                      key={`${b.id}-${b.start}-${b.status}`}
                      className={[b.id === highlight ? "highlight" : "", b.status === "cancelled" ? "cancelled" : ""].join(" ")}
                    >
                      <td className="muted">{b.id}</td>
                      <td>{b.clientName}</td>
                      <td>{b.start.slice(0, 10)}</td>
                      <td>
                        {b.start.slice(11)}–{b.end.slice(11)}
                      </td>
                      <td className="muted">
                        {b.status === "cancelled" ? <span className="tag">cancelled</span> : (b.service ?? "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Clients</h2>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Bookings</th>
                  <th>Next booking</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={`${c.id}-${c.bookingCount}`}>
                    <td className="muted">{c.id}</td>
                    <td>{c.name}</td>
                    <td>{c.bookingCount}</td>
                    <td className="muted">{c.nextBooking ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </aside>
      </main>
    </div>
  );
}
