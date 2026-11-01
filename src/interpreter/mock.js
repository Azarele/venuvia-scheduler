// Rule-based interpreter used when no LLM API key is configured (or the LLM call fails).
// It produces exactly the same intent objects as the LLM interpreter, so the rest of
// the app doesn't know or care which one ran. Deliberately small: it covers the
// common phrasings for the MVP flows, not the whole English language.
import { BUSINESS } from "../time.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const pad = (n) => String(n).padStart(2, "0");

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds a date expression. Returns { date: "YYYY-MM-DD" | null, rest } where `rest` is
 * the text with the date removed (so its numbers aren't mistaken for times).
 * Impossible dates like "February 30" are returned as-is ("2026-02-30") so the
 * backend can reject them with a clear message instead of silently "fixing" them.
 */
export function parseDate(text, now) {
  const today = now.startOf("day");
  const rules = [
    [/\bday after tomorrow\b/, () => today.plus({ days: 2 }).toISODate()],
    [/\b(tomorrow|tmrw|tmr)\b/, () => today.plus({ days: 1 }).toISODate()],
    [/\b(today|tonight)\b/, () => today.toISODate()],
    [/\byesterday\b/, () => today.minus({ days: 1 }).toISODate()],
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => `${m[1]}-${pad(m[2])}-${pad(m[3])}`],
    [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH_RE})\\b\\.?(?: (\\d{4}))?`),
      (m) => monthDay(+MONTHS[m[2]], +m[1], m[3], today),
    ],
    [
      new RegExp(`\\b(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`),
      (m) => monthDay(+MONTHS[m[1]], +m[2], m[3], today),
    ],
    [
      new RegExp(`\\b(?:(next|this|on) )?(${WEEKDAYS.join("|")})\\b`),
      (m) => {
        const target = WEEKDAYS.indexOf(m[2]) + 1;
        let diff = (target - today.weekday + 7) % 7;
        if (diff === 0 && m[1] !== "this") diff = 7;
        return today.plus({ days: diff }).toISODate();
      },
    ],
  ];
  for (const [re, toDate] of rules) {
    const m = text.match(re);
    if (m) return { date: toDate(m), rest: text.replace(m[0], " ") };
  }
  return { date: null, rest: text };
}

function monthDay(month, day, year, today) {
  let y = year ? +year : today.year;
  // "March 3" in November means next March.
  if (!year && (month < today.month || (month === today.month && day < today.day))) y += 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}

const TIME_RE =
  /\b(noon|midday|midnight)\b|\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\w:])/g;
const TIME_CUE = /(?:\bat|\bfrom|\bto|\buntil|\btill|\btil|\bbetween|\band|\bby|\bafter|\bbefore|\baround|\bmy|\bthe|\bat about|-)\s*$/;

/** Finds clock times in text. Returns [{ minutes, assumed, index }] in order of appearance. */
export function parseTimes(text) {
  const raw = [];
  for (const m of text.matchAll(TIME_RE)) {
    if (m[1]) {
      raw.push({ hour: m[1] === "midnight" ? 0 : 12, minute: 0, mer: "fixed", index: m.index });
      continue;
    }
    const hour = +m[2];
    const minute = m[3] ? +m[3] : 0;
    const mer = m[4] ? (m[4][0] === "a" ? "am" : "pm") : null;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    const looksLikeTime = mer || m[3] || TIME_CUE.test(before) || /^\s*(-|to|until|till|and)\s*\d/.test(after);
    if (!looksLikeTime || hour > 24 || minute > 59) continue;
    raw.push({ hour, minute, mer, index: m.index });
  }

  // "2-4pm": a bare start time inherits the meridiem of the end time.
  for (let i = 0; i < raw.length - 1; i++) {
    const [a, b] = [raw[i], raw[i + 1]];
    if (!a.mer && (b.mer === "am" || b.mer === "pm") && a.hour <= 12) {
      const candidate = to24(a.hour, b.mer);
      a.mer = candidate <= to24(b.hour, b.mer) ? b.mer : b.mer === "pm" ? "am" : "pm";
    }
  }

  return raw.map(({ hour, minute, mer, index }) => {
    let h = hour;
    let assumed = false;
    if (mer === "am" || mer === "pm") h = to24(hour, mer);
    else if (mer === null && hour >= 1 && hour <= 7) {
      h = hour + 12; // "block 3 to 5" during a salon's working day almost certainly means PM
      assumed = true;
    }
    return { minutes: (h % 24) * 60 + minute, assumed, index };
  });
}

function to24(hour, mer) {
  if (mer === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

const fmtMinutes = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function parseDuration(text) {
  const m = text.match(/\bfor (\d+(?:\.\d+)?|an?|one|two|three|half an?) ?(hours?|hrs?|h|minutes?|mins?)\b/);
  if (!m) return { minutes: null, rest: text };
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3 };
  const qty = m[1].startsWith("half") ? 0.5 : words[m[1]] ?? parseFloat(m[1]);
  const minutes = /^h/.test(m[2]) ? qty * 60 : qty;
  return { minutes: Math.round(minutes), rest: text.replace(m[0], " ") };
}

function findClientName(text, clientNames) {
  return clientNames.find((name) => new RegExp(`\\b${name.toLowerCase()}\\b`).test(text)) ?? null;
}

function stripIds(text) {
  const ids = [...text.matchAll(/\b(apt|blk)_\d+\b/g)].map((m) => m[0]);
  return { ids, rest: text.replace(/\b(apt|blk)_\d+\b/g, " ") };
}

function detectAction(t) {
  if (/\b(unblock|reopen|lift|free up)\b|\b(remove|delete|clear)\b.*\b(block|blocked|break)\b/.test(t))
    return "unblock";
  if (/\b(reschedule|move|push|shift|postpone|bring forward)\b/.test(t)) return "reschedule";
  if (/\bcancel\b/.test(t)) return "cancel_appointment";
  if (
    /\b(block|close|closed|unavailable|not available|day off|time off|nobody can book|no one can book|no bookings|stop bookings|off)\b/.test(t)
  )
    return "block_time";
  if (/\b(show|list|view|see|display|agenda|schedule|appointments?|bookings?|calendar|free|busy)\b|\bwhat'?s on\b/.test(t))
    return "show_schedule";
  return null;
}

/**
 * @param {string} text
 * @param {{ now: import("luxon").DateTime, clientNames: string[], partial?: object }} ctx
 */
export function interpretMock(text, ctx) {
  const t = normalize(text);
  let action = detectAction(t);
  let partial = null;
  if (ctx.partial && (!action || action === "show_schedule")) {
    // No new action verb: the owner is answering a clarifying question ("tomorrow",
    // "2 to 4 pm", "Anna's"), so merge the answer into the earlier partial request.
    action = ctx.partial.type;
    partial = ctx.partial;
  }

  switch (action) {
    case "block_time":
      return interpretBlock(t, ctx, partial);
    case "reschedule":
      return interpretReschedule(t, ctx, partial);
    case "cancel_appointment":
      return { type: "cancel_appointment", target: mergeTarget(partial?.target, parseTarget(t, ctx)) };
    case "unblock":
      return { type: "unblock", target: mergeTarget(partial?.target, parseTarget(t, ctx, "blk")) };
    case "show_schedule": {
      const { date } = parseDate(t, ctx.now);
      return { type: "show_schedule", date: date ?? ctx.now.toISODate() };
    }
    default:
      return { type: "unknown" };
  }
}

function interpretBlock(t, ctx, partial) {
  const { minutes: duration, rest: noDuration } = parseDuration(t);
  const { date: parsedDate, rest } = parseDate(noDuration, ctx.now);
  const date = parsedDate ?? partial?.date ?? null;
  const reasonMatch = t.match(/\b(?:for|because of|reason:?) (?:a |an |my |the )?([a-z][a-z ]{2,30}?)(?:[.!,]|$)/);
  const reason = reasonMatch && !/\b(hours?|minutes?|mins?|bookings?)\b/.test(reasonMatch[1])
    ? capitalize(reasonMatch[1].trim())
    : (partial?.reason ?? null);

  let startTime = partial?.startTime ?? null;
  let endTime = partial?.endTime ?? null;
  let assumed = false;

  if (/\b(all day|whole day|entire day|full day|day off)\b/.test(t)) {
    startTime = BUSINESS.openTime;
    endTime = BUSINESS.closeTime;
  } else {
    const times = parseTimes(rest);
    assumed = times.some((x) => x.assumed);
    if (times.length >= 2) {
      startTime = fmtMinutes(times[0].minutes);
      endTime = fmtMinutes(times[1].minutes);
    } else if (times.length === 1 && duration) {
      startTime = fmtMinutes(times[0].minutes);
      endTime = fmtMinutes(Math.min(times[0].minutes + duration, 23 * 60 + 59));
    } else if (times.length === 1) {
      if (/\b(until|till|til|to)\s*$/.test(rest.slice(0, times[0].index)) && startTime && !endTime)
        endTime = fmtMinutes(times[0].minutes);
      else startTime = fmtMinutes(times[0].minutes);
    }
  }

  const known = { type: "block_time", date, startTime, endTime, reason };
  const vague = t.match(/\b(morning|afternoon|evening|lunch ?time)\b/);
  if (!startTime && vague)
    return clarify(
      `What exact times should I block for the ${vague[1]}? For example "${vague[1] === "morning" ? "9 AM to 12 PM" : "2 PM to 5 PM"}".`,
      known,
    );
  if (!startTime) return clarify("What time period should I block? For example \"2 PM to 4 PM\".", known);
  if (!endTime) return clarify(`Until what time should I block from ${startTime}?`, known);
  if (!date) return clarify(`Which day should I block ${startTime}–${endTime}? (e.g. "tomorrow" or "Friday")`, known);
  return { ...known, assumedPm: assumed };
}

function interpretReschedule(t, ctx, partial) {
  if (partial) {
    // Follow-up answer. If we were missing the new time, the times here are the new time;
    // otherwise the answer narrows down which appointment was meant.
    const { date, rest } = parseDate(t, ctx.now);
    if (!partial.newTime) {
      const times = parseTimes(rest);
      const intent = { ...partial, newDate: date ?? partial.newDate, newTime: times.length ? fmtMinutes(times[0].minutes) : null };
      return intent.newTime ? intent : clarify("What time should I move it to?", intent);
    }
    return { ...partial, target: mergeTarget(partial.target, parseTarget(t, ctx)) };
  }

  // "Move my 3 PM appointment to 4 PM": the new time comes after the last " to ".
  const split = t.match(/^(.*)\b(?:to|until)\b(.*)$/);
  const [left, right] = split ? [split[1], split[2]] : [t, ""];
  const target = parseTarget(left, ctx);
  const { date: newDate, rest } = parseDate(right, ctx.now);
  const times = parseTimes(rest);
  const intent = {
    type: "reschedule",
    target,
    newDate,
    newTime: times.length ? fmtMinutes(times[times.length - 1].minutes) : null,
  };
  return intent.newTime ? intent : clarify("What time should I move it to?", intent);
}

function mergeTarget(previous = {}, next = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) if (value != null) merged[key] = value;
  return merged;
}

/** Describe which appointment/block the user means: by id, client name, date and/or time. */
function parseTarget(text, ctx, kind = "apt") {
  const { ids, rest: noIds } = stripIds(text);
  const { date, rest } = parseDate(noIds, ctx.now);
  const times = parseTimes(rest);
  const target = {
    date,
    time: times.length ? fmtMinutes(times[0].minutes) : null,
  };
  if (kind === "apt") {
    target.appointmentId = ids.find((id) => id.startsWith("apt")) ?? null;
    target.clientName = findClientName(text, ctx.clientNames);
  } else {
    target.blockId = ids.find((id) => id.startsWith("blk")) ?? null;
    target.reasonHint = /\blunch\b/.test(text) ? "lunch" : null;
  }
  return target;
}

function clarify(question, partial) {
  return { type: "clarify", question, partial };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
