// Time helpers. All business logic works in the business's local timezone;
// timestamps are stored as ISO 8601 strings with an explicit offset.
import { DateTime } from "luxon";

export const BUSINESS = {
  id: "biz_studio_nova",
  name: "Studio Nova",
  timezone: "Europe/Warsaw",
  openTime: "09:00",
  closeTime: "19:00",
};

const zone = BUSINESS.timezone;

export function toLocal(dt) {
  return dt.setZone(zone);
}

export function fromIso(iso) {
  return DateTime.fromISO(iso, { zone });
}

export function toIso(dt) {
  return dt.setZone(zone).toISO({ suppressMilliseconds: true });
}

/** "2026-11-02" -> true; "2026-02-30" -> false. */
export function isValidDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return DateTime.fromISO(dateStr, { zone }).isValid;
}

export function isValidTime(timeStr) {
  return typeof timeStr === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr);
}

/** Combine a local date and time ("2026-11-02", "14:00") into a zoned DateTime, or null. */
export function localDateTime(dateStr, timeStr) {
  if (!isValidDate(dateStr) || !isValidTime(timeStr)) return null;
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone });
  return dt.isValid ? dt : null;
}

export function fmtTime(dt) {
  return dt.setZone(zone).toFormat("HH:mm");
}

/** "tomorrow, Monday, November 2" relative to now. */
export function fmtDay(dt, now) {
  const d = dt.setZone(zone).startOf("day");
  const today = now.setZone(zone).startOf("day");
  const diff = Math.round(d.diff(today, "days").days);
  const label = d.toFormat("cccc, LLLL d");
  if (diff === 0) return `today, ${label}`;
  if (diff === 1) return `tomorrow, ${label}`;
  if (diff === -1) return `yesterday, ${label}`;
  return label;
}

export function fmtRange(startDt, endDt) {
  return `${fmtTime(startDt)}–${fmtTime(endDt)}`;
}
