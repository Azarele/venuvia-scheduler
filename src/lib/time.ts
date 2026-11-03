import { DateTime } from "luxon";
import type { Lang } from "./lang.ts";

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

/** Date -> "Mon 2 Nov (tomorrow)" / "pon 2 lis (jutro)" so it's obvious which day is meant. */
export function formatDay(date: Date, lang: Lang = "en"): string {
  const day = DateTime.fromJSDate(date).setZone(TIMEZONE).setLocale(lang === "pl" ? "pl" : "en-GB");
  return `${day.toFormat("ccc d LLL")} (${relativeDay(day, lang)})`;
}

/** "today", "tomorrow", "in 3 days"… (or Polish) — in salon time. */
export function relativeDay(day: DateTime, lang: Lang = "en"): string {
  const diff = Math.round(day.startOf("day").diff(now().startOf("day"), "days").days);
  if (lang === "pl") {
    if (diff === 0) return "dzisiaj";
    if (diff === 1) return "jutro";
    if (diff === -1) return "wczoraj";
    return diff > 0 ? `za ${diff} dni` : `${-diff} dni temu`;
  }
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

export function formatTime(date: Date): string {
  return DateTime.fromJSDate(date).setZone(TIMEZONE).toFormat("HH:mm");
}
