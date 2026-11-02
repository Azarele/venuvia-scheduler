"use client";

import { useState } from "react";
import type { Booking, BookingEvent, Client } from "@/lib/bookings.ts";
import { longDate, relativeDayLabel } from "../ui.ts";

type Tab = "schedule" | "clients" | "activity";

export function SidePanel(props: {
  today: string;
  hours: { open: string; close: string };
  bookings: Booking[];
  clients: Client[];
  events: BookingEvent[];
  highlight: number | null;
  busy: boolean;
  canUndo: boolean;
  onUndo: () => void;
}) {
  const [tab, setTab] = useState<Tab>("schedule");
  const active = props.bookings.filter((b) => b.status === "confirmed");
  const cancelledCount = props.bookings.length - active.length;

  return (
    <aside className="panel side" aria-label="Bookings, clients and activity">
      <div className="tabs" role="tablist">
        {(
          [
            ["schedule", "Schedule", active.length],
            ["clients", "Clients", props.clients.length],
            ["activity", "Activity", props.events.length],
          ] as const
        ).map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
            <span className="count">{count}</span>
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "schedule" && <Schedule {...props} cancelledCount={cancelledCount} />}
        {tab === "clients" && <Clients clients={props.clients} today={props.today} />}
        {tab === "activity" && <Activity {...props} />}
      </div>
    </aside>
  );
}

function Schedule(props: { today: string; hours: { open: string; close: string }; bookings: Booking[]; highlight: number | null; cancelledCount: number }) {
  const [showCancelled, setShowCancelled] = useState(true);
  const visible = props.bookings.filter((b) => showCancelled || b.status === "confirmed");
  const days = [...new Set(visible.map((b) => b.start.slice(0, 10)))].sort();

  return (
    <div>
      <div className="toolbar">
        <span className="muted">
          Opening hours {props.hours.open}–{props.hours.close}
        </span>
        {props.cancelledCount > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Show cancelled ({props.cancelledCount})
          </label>
        )}
      </div>
      {days.length === 0 && <p className="empty">No bookings yet. Ask the assistant to create one.</p>}
      {days.map((day) => {
        const rel = relativeDayLabel(day, props.today);
        const items = visible.filter((b) => b.start.startsWith(day));
        return (
          <section key={day} className={`day${day < props.today ? " past" : ""}`}>
            <h3>
              {rel && <span className="rel">{rel}</span>}
              {longDate(day)}
              <span className="muted"> · {items.filter((b) => b.status === "confirmed").length} booked</span>
            </h3>
            {items.map((b) => (
              <div key={`${b.id}-${b.start}-${b.status}`} className={`booking ${b.status}${b.id === props.highlight ? " highlight" : ""}`}>
                <div className="booking-time">
                  {b.start.slice(11)}
                  <span>{b.end.slice(11)}</span>
                </div>
                <div className="booking-main">
                  <div className="booking-client">{b.clientName}</div>
                  <div className="booking-service">{b.service ?? "No service set"}</div>
                </div>
                <div className="booking-meta">
                  {b.status === "cancelled" && <span className="tag danger">Cancelled</span>}
                  <span className="id">#{b.id}</span>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Clients(props: { clients: Client[]; today: string }) {
  return (
    <table className="clients">
      <thead>
        <tr>
          <th>Client</th>
          <th>Active bookings</th>
          <th>Next booking</th>
        </tr>
      </thead>
      <tbody>
        {props.clients.map((c) => {
          const rel = c.nextBooking ? relativeDayLabel(c.nextBooking.slice(0, 10), props.today) : "";
          return (
            <tr key={c.id}>
              <td>
                <span className="initial">{c.name.charAt(0).toUpperCase()}</span>
                {c.name}
              </td>
              <td>{c.bookingCount}</td>
              <td className="muted">{c.nextBooking ? `${rel || c.nextBooking.slice(0, 10)}, ${c.nextBooking.slice(11)}` : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ACTION_TEXT = { created: "Created", updated: "Changed", cancelled: "Cancelled", undone: "Undid a change to" } as const;

function Activity(props: { events: BookingEvent[]; busy: boolean; canUndo: boolean; onUndo: () => void; today: string }) {
  const short = (b: Booking) => `${b.status === "cancelled" ? "Cancelled: " : ""}${b.clientName}, ${relativeDayLabel(b.start.slice(0, 10), props.today) || b.start.slice(0, 10)} ${b.start.slice(11)}–${b.end.slice(11)}`;
  return (
    <div>
      <div className="toolbar">
        <span className="muted">Every approved change, newest first</span>
        <button className="ghost small" onClick={props.onUndo} disabled={props.busy || !props.canUndo} title="Proposes undoing your most recent change. You'll still approve it.">
          ↶ Undo last change
        </button>
      </div>
      {props.events.length === 0 && <p className="empty">No changes yet. Approved changes appear here with who approved them.</p>}
      <ol className="activity">
        {props.events.map((e) => (
          <li key={e.id} className={`${e.action}${e.undone ? " undone" : ""}`}>
            <div className="activity-head">
              <span className={`dot ${e.action}`} />
              <strong>
                {ACTION_TEXT[e.action]} booking #{e.bookingId}
              </strong>
              {e.undone && <span className="tag">Undone</span>}
              <span className="muted when">{e.at.slice(11)}</span>
            </div>
            <div className="activity-detail">
              {e.before && e.action !== "cancelled" && (
                <>
                  <span className="strike">{short(e.before)}</span>
                  <span className="arrow">→</span>
                </>
              )}
              <span>{short(e.after)}</span>
            </div>
            <div className="muted activity-by">
              Approved by {e.approvedBy} · {e.source === "ai" ? "proposed by the AI" : "Undo button"}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
