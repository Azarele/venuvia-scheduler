"use client";

import { useCallback, useEffect, useState } from "react";
import type { Booking, BookingEvent, Client, User } from "@/lib/bookings.ts";
import type { Bubble, PendingAction } from "@/lib/chat-types.ts";
import { Chat } from "./components/Chat.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { api } from "./ui.ts";

type Info = {
  users: User[];
  ai: { name: string; model: string } | { error: string };
  timezone: string;
  today: string;
  hours: { open: string; close: string };
};
type AgentResponse = { bubbles: Bubble[]; changedBookingId?: number };

export default function Home() {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [events, setEvents] = useState<BookingEvent[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const user = info?.users.find((u) => u.id === userId);

  const refresh = useCallback(async (uid: number) => {
    const [b, c, e] = await Promise.all([
      api<{ bookings: Booking[] }>(`/api/bookings?userId=${uid}`),
      api<{ clients: Client[] }>("/api/clients"),
      api<{ events: BookingEvent[] }>(`/api/events?userId=${uid}`),
    ]);
    setBookings(b.bookings);
    setClients(c.clients);
    setEvents(e.events);
  }, []);

  useEffect(() => {
    api<Info>("/api/info")
      .then((data) => {
        setInfo(data);
        const saved = Number(localStorageGet("venuvia.userId"));
        setUserId(data.users.some((u) => u.id === saved) ? saved : (data.users[0]?.id ?? null));
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (userId == null) return;
    localStorageSet("venuvia.userId", String(userId));
    setHighlight(null);
    Promise.all([api<{ bubbles: Bubble[] }>(`/api/conversation?userId=${userId}`).then((r) => setBubbles(r.bubbles)), refresh(userId)]).catch((e) =>
      setLoadError(e.message),
    );
  }, [userId, refresh]);

  /** Runs a server call that returns the updated chat, then refreshes the side panel. */
  async function run(call: () => Promise<AgentResponse>, optimistic?: Bubble) {
    if (userId == null) return;
    if (optimistic) setBubbles((b) => [...b, optimistic]);
    setBusy(true);
    try {
      const res = await call();
      setBubbles(res.bubbles);
      if (res.changedBookingId) setHighlight(res.changedBookingId);
    } catch (e) {
      // The server saved the error in the chat; reload it (or show it locally if that fails too).
      const saved = await api<{ bubbles: Bubble[] }>(`/api/conversation?userId=${userId}`).catch(() => null);
      setBubbles(saved?.bubbles.length ? saved.bubbles : (b) => [...b, { id: crypto.randomUUID(), role: "error", text: (e as Error).message, at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
      refresh(userId).catch(() => {});
    }
  }

  const send = (text: string) =>
    run(() => api<AgentResponse>("/api/chat", { body: { userId, text } }), { id: crypto.randomUUID(), role: "user", text, at: new Date().toISOString() });
  const decide = (pending: PendingAction, approved: boolean) => {
    setBubbles((b) => b.map((x) => (x.pending?.id === pending.id ? { ...x, decision: approved ? "approved" : "rejected" } : x)));
    return run(() => api<AgentResponse>("/api/approve", { body: { userId, pendingId: pending.id, approved } }));
  };
  const undo = () => run(() => api<AgentResponse>("/api/undo", { body: { userId } }));
  async function newChat() {
    if (userId == null || !confirm("Start a new chat? Any change waiting for approval is rejected.")) return;
    setBubbles((await api<{ bubbles: Bubble[] }>(`/api/conversation?userId=${userId}`, { method: "DELETE" })).bubbles);
  }

  const aiError = info && "error" in info.ai ? info.ai.error : null;
  const canUndo = events.some((e) => e.action !== "undone" && !e.undone);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">V</span>
          <div>
            <div className="brand-title">Studio Nova</div>
            <div className="brand-sub">AI booking assistant · every change needs your approval</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`badge${aiError ? " warn" : ""}`} title={aiError ?? `${info?.timezone ?? ""}`}>
            <span className="pulse" />
            {!info ? "…" : aiError ? "AI not configured" : `${(info.ai as { name: string }).name} · ${(info.ai as { model: string }).model}`}
          </span>
          <button className="ghost" onClick={newChat} disabled={busy || bubbles.length === 0}>
            New chat
          </button>
          <label className="user-picker">
            <span className="initial">{user?.name.charAt(0) ?? "?"}</span>
            <select value={userId ?? ""} onChange={(e) => setUserId(Number(e.target.value))} disabled={busy} aria-label="Signed in as">
              {info?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loadError && <div className="banner">{loadError}</div>}
      {aiError && <div className="banner">{aiError}</div>}

      <main className="layout">
        <Chat userName={user?.name ?? ""} timezone={info?.timezone ?? ""} bubbles={bubbles} busy={busy} onSend={send} onDecide={decide} />
        <SidePanel
          today={info?.today ?? ""}
          hours={info?.hours ?? { open: "09:00", close: "19:00" }}
          bookings={bookings}
          clients={clients}
          events={events}
          highlight={highlight}
          busy={busy || bubbles.some((b) => b.pending && !b.decision)}
          canUndo={canUndo}
          onUndo={undo}
        />
      </main>
    </div>
  );
}

// localStorage can throw (private mode, blocked storage); the app works without it.
function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
