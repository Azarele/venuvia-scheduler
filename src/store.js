// In-memory data store. Data is re-seeded on every server start (and via
// POST /api/reset), so all changes are lost when the process restarts.
import { DateTime } from "luxon";
import { BUSINESS, localDateTime, toIso, toLocal } from "./time.js";

/**
 * @typedef {{ id: string, businessId: string, clientName: string, serviceName: string,
 *   startAt: string, endAt: string, status: "confirmed" | "cancelled" }} Appointment
 * @typedef {{ id: string, businessId: string, startAt: string, endAt: string, reason?: string }} AvailabilityBlock
 */

export function createStore({ now = DateTime.now() } = {}) {
  const tomorrow = toLocal(now).plus({ days: 1 }).toISODate();
  const at = (time) => toIso(localDateTime(tomorrow, time));
  const appt = (id, clientName, serviceName, start, end) => ({
    id,
    businessId: BUSINESS.id,
    clientName,
    serviceName,
    startAt: at(start),
    endAt: at(end),
    status: "confirmed",
  });

  return {
    /** @type {Appointment[]} */
    appointments: [
      appt("apt_001", "Anna", "Haircut", "10:00", "10:45"),
      appt("apt_002", "Marta", "Coloring", "11:00", "13:00"),
      appt("apt_003", "Julia", "Manicure", "15:00", "16:00"),
    ],
    /** @type {AvailabilityBlock[]} */
    blocks: [
      {
        id: "blk_001",
        businessId: BUSINESS.id,
        startAt: at("13:00"),
        endAt: at("13:30"),
        reason: "Lunch break",
      },
    ],
    counters: { blk: 1, apt: 3 },
  };
}

export function nextId(store, prefix) {
  store.counters[prefix] += 1;
  return `${prefix}_${String(store.counters[prefix]).padStart(3, "0")}`;
}
