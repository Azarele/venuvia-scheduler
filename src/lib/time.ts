import { DateTime } from "luxon";

// All dates the AI and the UI see are local salon time, e.g. "2026-11-02 14:00".
// Postgres stores real timestamps (timestamptz); conversion happens only here.
export const TIMEZONE = process.env.BUSINESS_TIMEZONE ?? "Europe/Warsaw";

export function now(): DateTime {
  return DateTime.now().setZone(TIMEZONE);
}

/** "2026-11-02 14:00" or "2026-11-02T14:00" (local) -> DateTime, or null if invalid. */
export function parseLocal(value: unknown): DateTime | null {
  if (typeof value !== "string") return null;
  const dt = DateTime.fromISO(value.trim().replace(" ", "T"), { zone: TIMEZONE });
  return dt.isValid ? dt.setZone(TIMEZONE) : null;
}

/** Date -> "2026-11-02 14:00" in salon time. */
export function formatLocal(date: Date): string {
  return DateTime.fromJSDate(date).setZone(TIMEZONE).toFormat("yyyy-MM-dd HH:mm");
}

/** Date -> "Mon 2 Nov, 14:00" for messages shown to people. */
export function formatHuman(date: Date): string {
  return DateTime.fromJSDate(date).setZone(TIMEZONE).toFormat("ccc d LLL, HH:mm");
}

export function formatTime(date: Date): string {
  return DateTime.fromJSDate(date).setZone(TIMEZONE).toFormat("HH:mm");
}
