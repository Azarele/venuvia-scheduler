// Scheduling domain logic. This is the only module that mutates the store.
// Planning functions are read-only and return what *would* happen; mutation
// functions re-validate their input and throw ScheduleError on any problem.
import { DateTime } from "luxon";
import { nextId } from "./store.js";
import { BUSINESS, fromIso, localDateTime, toIso, toLocal } from "./time.js";

export class ScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MAX_DAYS_AHEAD = 365;
const SLOT_STEP_MINUTES = 15;

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

export class ScheduleService {
  constructor({ store, now = () => DateTime.now() }) {
    this.store = store;
    this._now = now;
  }

  now() {
    return toLocal(this._now());
  }

  // ---------- Queries ----------

  getDay(dateStr) {
    const start = fromIso(dateStr).startOf("day");
    const end = start.plus({ days: 1 });
    const inDay = (item) => overlaps(fromIso(item.startAt), fromIso(item.endAt), start, end);
    const byStart = (a, b) => a.startAt.localeCompare(b.startAt);
    return {
      date: dateStr,
      appointments: this.store.appointments
        .filter((a) => a.status === "confirmed" && inDay(a))
        .sort(byStart),
      blocks: this.store.blocks.filter(inDay).sort(byStart),
    };
  }

  /** Confirmed appointments and blocks from today onwards (used as AI context and for lookups). */
  upcoming(days = 14) {
    const from = this.now().startOf("day");
    const to = from.plus({ days });
    const inWindow = (item) => overlaps(fromIso(item.startAt), fromIso(item.endAt), from, to);
    const byStart = (a, b) => a.startAt.localeCompare(b.startAt);
    return {
      appointments: this.store.appointments
        .filter((a) => a.status === "confirmed" && inWindow(a))
        .sort(byStart),
      blocks: this.store.blocks.filter(inWindow).sort(byStart),
    };
  }

  getAppointment(id) {
    return this.store.appointments.find((a) => a.id === id) ?? null;
  }

  getBlock(id) {
    return this.store.blocks.find((b) => b.id === id) ?? null;
  }

  /** Everything that overlaps [start, end). */
  findOverlaps(start, end, { excludeAppointmentId } = {}) {
    return {
      appointments: this.store.appointments.filter(
        (a) =>
          a.status === "confirmed" &&
          a.id !== excludeAppointmentId &&
          overlaps(start, end, fromIso(a.startAt), fromIso(a.endAt)),
      ),
      blocks: this.store.blocks.filter((b) =>
        overlaps(start, end, fromIso(b.startAt), fromIso(b.endAt)),
      ),
    };
  }

  /** Returns an error message, or null if the range is acceptable. */
  validateRange(start, end) {
    if (!start?.isValid || !end?.isValid) return "That isn't a valid date or time.";
    if (end <= start) return "The end time must be after the start time.";
    if (start < this.now()) return "That time is in the past — I can only change future time slots.";
    if (start > this.now().plus({ days: MAX_DAYS_AHEAD }))
      return "That's more than a year ahead — please pick a closer date.";
    return null;
  }

  // ---------- Planning (read-only) ----------

  planBlock(start, end) {
    const error = this.validateRange(start, end);
    if (error) return { ok: false, error };
    const conflicts = this.findOverlaps(start, end);
    return {
      ok: true,
      startAt: toIso(start),
      endAt: toIso(end),
      conflicts,
      alreadyBlocked: this.isFullyCovered(start, end, conflicts.blocks),
      freeSegments: subtract([[start, end]], conflicts.appointments).map(([s, e]) => ({
        startAt: toIso(s),
        endAt: toIso(e),
      })),
    };
  }

  planReschedule(appointmentId, newStart) {
    const appointment = this.getAppointment(appointmentId);
    if (!appointment || appointment.status !== "confirmed")
      return { ok: false, error: "I couldn't find that appointment." };
    const duration = fromIso(appointment.endAt).diff(fromIso(appointment.startAt));
    const newEnd = newStart.plus(duration);
    const error = this.validateRange(newStart, newEnd);
    if (error) return { ok: false, error, appointment };
    if (+newStart === +fromIso(appointment.startAt))
      return { ok: false, error: "The appointment is already at that time.", appointment };

    const date = newStart.toISODate();
    const open = localDateTime(date, BUSINESS.openTime);
    const close = localDateTime(date, BUSINESS.closeTime);
    const outsideHours = newStart < open || newEnd > close;
    const conflicts = this.findOverlaps(newStart, newEnd, { excludeAppointmentId: appointmentId });
    const hasConflict = conflicts.appointments.length > 0 || conflicts.blocks.length > 0;
    return {
      ok: true,
      appointment,
      newStartAt: toIso(newStart),
      newEndAt: toIso(newEnd),
      outsideHours,
      conflicts,
      hasConflict,
      suggestions:
        hasConflict || outsideHours ? this.suggestSlots(appointment, newStart, duration) : [],
    };
  }

  /** Up to `limit` free slots of the same length on the same day, nearest to the requested time. */
  suggestSlots(appointment, requested, duration, limit = 3) {
    const date = requested.toISODate();
    let cursor = localDateTime(date, BUSINESS.openTime);
    const close = localDateTime(date, BUSINESS.closeTime);
    const slots = [];
    while (cursor.plus(duration) <= close) {
      const end = cursor.plus(duration);
      const free =
        cursor >= this.now() &&
        !this.validateRange(cursor, end) &&
        Object.values(this.findOverlaps(cursor, end, { excludeAppointmentId: appointment.id })).every(
          (list) => list.length === 0,
        );
      if (free) slots.push(cursor);
      cursor = cursor.plus({ minutes: SLOT_STEP_MINUTES });
    }
    return slots
      .sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested))
      .slice(0, limit)
      .sort((a, b) => a - b)
      .map((s) => ({ startAt: toIso(s), endAt: toIso(s.plus(duration)) }));
  }

  isFullyCovered(start, end, blocks) {
    return blocks.length > 0 && subtract([[start, end]], blocks).length === 0;
  }

  // ---------- Mutations ----------

  /** Creates a block. Refuses to overlap confirmed appointments — callers must resolve those first. */
  createBlock({ startAt, endAt, reason }) {
    const start = fromIso(startAt);
    const end = fromIso(endAt);
    const error = this.validateRange(start, end);
    if (error) throw new ScheduleError("invalid_range", error);
    const { appointments } = this.findOverlaps(start, end);
    if (appointments.length > 0)
      throw new ScheduleError("conflict", "That time overlaps existing appointments.");
    const block = {
      id: nextId(this.store, "blk"),
      businessId: BUSINESS.id,
      startAt: toIso(start),
      endAt: toIso(end),
      ...(reason ? { reason } : {}),
    };
    this.store.blocks.push(block);
    return block;
  }

  cancelAppointment(id) {
    const appointment = this.getAppointment(id);
    if (!appointment) throw new ScheduleError("not_found", "Appointment not found.");
    if (appointment.status === "cancelled")
      throw new ScheduleError("already_cancelled", "That appointment is already cancelled.");
    appointment.status = "cancelled";
    return appointment;
  }

  rescheduleAppointment(id, newStartAt) {
    const plan = this.planReschedule(id, fromIso(newStartAt));
    if (!plan.ok) throw new ScheduleError("invalid", plan.error);
    if (plan.hasConflict) throw new ScheduleError("conflict", "The new time is no longer free.");
    if (plan.outsideHours) throw new ScheduleError("outside_hours", "That's outside opening hours.");
    plan.appointment.startAt = plan.newStartAt;
    plan.appointment.endAt = plan.newEndAt;
    return plan.appointment;
  }

  removeBlock(id) {
    const index = this.store.blocks.findIndex((b) => b.id === id);
    if (index === -1) throw new ScheduleError("not_found", "Blocked period not found.");
    return this.store.blocks.splice(index, 1)[0];
  }
}

/** Subtract busy items ({startAt, endAt}) from a list of [start, end) DateTime ranges. */
function subtract(ranges, items) {
  let result = ranges;
  for (const item of items) {
    const bs = fromIso(item.startAt);
    const be = fromIso(item.endAt);
    result = result.flatMap(([s, e]) => {
      if (!overlaps(s, e, bs, be)) return [[s, e]];
      const parts = [];
      if (s < bs) parts.push([s, bs]);
      if (be < e) parts.push([be, e]);
      return parts;
    });
  }
  return result;
}
