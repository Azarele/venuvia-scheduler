// Conversation orchestration. Flow for every change:
//   message -> interpreter (LLM or mock) -> intent -> validate + check conflicts
//   -> pending proposal (nothing changed yet) -> owner confirms -> re-validate -> mutate.
// Confirmation replies ("yes", "no", "1") are handled here in code, never by the LLM.
import { randomUUID } from "node:crypto";
import { ScheduleError } from "./scheduling.js";
import { BUSINESS, fmtDay, fmtRange, fmtTime, fromIso, isValidDate, isValidTime, localDateTime } from "./time.js";

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|confirm(ed)?|proceed|go ahead|do it|please do|correct|sounds good)\b/;
const NO = /^(n|no|nope|nah|cancel|stop|abort|never ?mind|don'?t|forget it|leave it)\b/;

const HELP =
  "I can block time so nobody can book you, reschedule or cancel appointments, remove a blocked period, or show your schedule. Try:\n" +
  "• “Block tomorrow from 2 PM to 4 PM”\n• “Reschedule my 3 PM appointment to 4 PM”\n• “Show me my appointments for tomorrow”";

export class Assistant {
  constructor({ schedule, interpreter }) {
    this.schedule = schedule;
    this.interpreter = interpreter;
    this.sessions = new Map();
  }

  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { pending: null, partial: null, history: [] });
    return this.sessions.get(id);
  }

  reset() {
    this.sessions.clear();
  }

  async handleMessage(sessionId, rawText) {
    const text = String(rawText ?? "").trim();
    if (!text) return reply("Please type a request — for example “Show me my schedule for tomorrow”.");
    if (text.length > 1000) return reply("That message is a bit long — could you shorten it to one request?");

    const session = this.session(sessionId);
    const lower = text.toLowerCase();
    let prefix = "";

    if (session.pending) {
      const optionId = matchPendingReply(lower, session.pending);
      if (optionId === "ambiguous") {
        return this.respond(session, text, {
          ...reply("Please pick one of the options so I know exactly what to do:\n" + listOptions(session.pending)),
          proposal: publicProposal(session.pending),
          focusDate: session.pending.focusDate,
        });
      }
      if (optionId) return this.respond(session, text, this.execute(session, optionId));
      // Anything else is a new request: the unconfirmed one is dropped, never executed.
      session.pending = null;
      prefix = "(I've set aside the previous unconfirmed request — nothing was changed.)\n\n";
    } else if (YES.test(lower) && text.split(" ").length <= 3) {
      return this.respond(session, text, reply("There's nothing waiting for confirmation right now. " + HELP));
    }

    const context = {
      now: this.schedule.now(),
      upcoming: this.schedule.upcoming(),
      clientNames: [...new Set(this.schedule.store.appointments.map((a) => a.clientName))],
      partial: session.partial,
    };
    const intent = await this.interpreter.interpret({ text, history: session.history, context });
    session.partial = null;

    const result = this.planFromIntent(session, intent);
    result.text = prefix + result.text;
    result.interpreter = intent.interpreter ?? this.interpreter.name;
    return this.respond(session, text, result);
  }

  /** Called by the Confirm / option buttons. */
  confirm(sessionId, proposalId, optionId) {
    const session = this.session(sessionId);
    if (!session.pending || session.pending.id !== proposalId)
      return reply("That request is no longer pending, so nothing was changed. Ask me again if you still need it.");
    if (!session.pending.options.some((o) => o.id === optionId)) return reply("Unknown option.");
    const label = session.pending.options.find((o) => o.id === optionId).label;
    return this.respond(session, label, this.execute(session, optionId));
  }

  respond(session, userText, result) {
    session.history.push({ role: "user", text: userText }, { role: "assistant", text: result.text });
    if (session.history.length > 20) session.history.splice(0, session.history.length - 20);
    return result;
  }

  // ---------- Intent -> proposal ----------

  planFromIntent(session, intent) {
    switch (intent.type) {
      case "show_schedule":
        return this.showSchedule(intent.date);
      case "block_time":
        return this.planBlock(session, intent);
      case "reschedule":
        return this.planReschedule(session, intent);
      case "cancel_appointment":
        return this.planCancel(session, intent);
      case "unblock":
        return this.planUnblock(session, intent);
      case "clarify":
        session.partial = intent.partial ?? null;
        return reply(intent.question);
      default:
        return reply(intent.message ?? `Sorry, I didn't understand that. ${HELP}`);
    }
  }

  showSchedule(date) {
    if (!isValidDate(date)) return reply(invalidDateText(date));
    const now = this.schedule.now();
    const day = this.schedule.getDay(date);
    const items = [
      ...day.appointments.map((a) => ({ startAt: a.startAt, line: `${span(a)} ${a.clientName} — ${a.serviceName}` })),
      ...day.blocks.map((b) => ({ startAt: b.startAt, line: `${span(b)} Blocked${b.reason ? ` (${b.reason})` : ""}` })),
    ].sort((a, b) => a.startAt.localeCompare(b.startAt));
    const heading = capitalize(fmtDay(fromIso(date), now));
    const text = items.length
      ? `Here's ${heading}:\n${items.map((i) => `• ${i.line}`).join("\n")}`
      : `${heading}: nothing booked or blocked yet.`;
    return { ...reply(text), focusDate: date };
  }

  planBlock(session, intent, { notice = "" } = {}) {
    const { date, startTime, endTime, reason } = intent;
    if (!isValidDate(date)) return reply(invalidDateText(date));
    if (!isValidTime(startTime) || !isValidTime(endTime))
      return reply("I couldn't work out the exact times. Could you say them like “2 PM to 4 PM”?");

    const start = localDateTime(date, startTime);
    let end = localDateTime(date, endTime);
    if (endTime === "00:00" && end <= start) end = end.plus({ days: 1 }); // "until midnight"
    return this.proposeBlock(session, { start, end, reason, assumedPm: intent.assumedPm, notice });
  }

  proposeBlock(session, { start, end, reason, assumedPm, notice = "" }) {
    const now = this.schedule.now();
    const plan = this.schedule.planBlock(start, end);
    if (!plan.ok) return { ...reply(`${notice}${plan.error} Would you like to try a different time?`), focusDate: start.toISODate() };

    const focusDate = start.toISODate();
    const what = `${fmtDay(start, now)}, from ${fmtTime(start)} to ${fmtTime(end)}`;
    if (plan.alreadyBlocked)
      return { ...reply(`${notice}That time is already blocked (${plan.conflicts.blocks.map(describeBlock).join(", ")}), so there's nothing to change.`), focusDate };

    const notes = [];
    if (assumedPm) notes.push("I assumed you meant the afternoon (PM).");
    if (plan.conflicts.blocks.length)
      notes.push(`This overlaps an existing block (${plan.conflicts.blocks.map(describeBlock).join(", ")}), which will stay as it is.`);
    if (start < localDateTime(focusDate, BUSINESS.openTime) || end > localDateTime(focusDate, BUSINESS.closeTime))
      notes.push(`Note: part of this is outside opening hours (${BUSINESS.openTime}–${BUSINESS.closeTime}).`);
    const notesText = notes.length ? `\n\n${notes.join(" ")}` : "";
    const params = { startAt: plan.startAt, endAt: plan.endAt, reason: reason || null };

    if (plan.conflicts.appointments.length) {
      const appts = plan.conflicts.appointments;
      const names = joinNames(appts.map((a) => `${a.clientName}'s`));
      const free = plan.freeSegments.filter((s) => fromIso(s.endAt).diff(fromIso(s.startAt), "minutes").minutes >= 5);
      const options = [];
      if (free.length)
        options.push({ id: "block_free", label: `Block only the free time (${free.map((s) => span(s)).join(", ")})`, tone: "primary" });
      options.push({
        id: "block_and_cancel",
        label: `Block all of it and cancel ${names} appointment${appts.length > 1 ? "s" : ""}`,
        tone: "danger",
      });
      options.push({ id: "abort", label: "Don't block anything", tone: "neutral" });
      const text =
        `${notice}⚠️ I can't simply block ${what}: it overlaps ${appts.length === 1 ? "a confirmed appointment" : `${appts.length} confirmed appointments`}:\n` +
        appts.map((a) => `• ${span(a)} ${a.clientName} — ${a.serviceName}`).join("\n") +
        `\n\nI won't cancel anything unless you tell me to. How would you like to proceed?\n` +
        options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") +
        notesText;
      return this.setPending(session, { kind: "block_conflict", params, options, focusDate, text });
    }

    const text =
      `${notice}I'll block ${what}${reason ? ` (${reason})` : ""}. No new appointments can be booked during this period. Would you like me to proceed?` +
      notesText;
    return this.setPending(session, {
      kind: "block",
      params,
      options: confirmOptions("Yes, block it"),
      focusDate,
      text,
    });
  }

  planReschedule(session, intent) {
    const now = this.schedule.now();
    const found = this.resolveAppointment(intent.target);
    if (found.none) return reply(`I couldn't find a matching upcoming appointment${describeTarget(intent.target)}. Which one did you mean?`);
    if (found.ambiguous) {
      session.partial = intent;
      return reply(`I found several appointments that could match — which one should I move?\n${found.ambiguous.map((a) => `• ${describeAppointment(a, now)}`).join("\n")}`);
    }
    const appt = found.match;
    const newDate = intent.newDate ?? fromIso(appt.startAt).toISODate();
    if (!isValidDate(newDate)) return reply(invalidDateText(newDate));
    if (!isValidTime(intent.newTime)) return reply("What time should I move it to?");

    const plan = this.schedule.planReschedule(appt.id, localDateTime(newDate, intent.newTime));
    if (!plan.ok) return { ...reply(plan.error), focusDate: newDate };

    const newStart = fromIso(plan.newStartAt);
    const newEnd = fromIso(plan.newEndAt);
    const target = `${fmtRange(newStart, newEnd)} on ${fmtDay(newStart, now)}`;
    if (plan.hasConflict || plan.outsideHours) {
      const reasons = [
        ...plan.conflicts.appointments.map((a) => `${a.clientName}'s ${a.serviceName} (${span(a)})`),
        ...plan.conflicts.blocks.map(describeBlock),
      ];
      const why = plan.hasConflict
        ? `it would overlap ${joinNames(reasons)}`
        : `that's outside opening hours (${BUSINESS.openTime}–${BUSINESS.closeTime})`;
      const suggestions = plan.suggestions.length
        ? `\n\nFree slots that day: ${plan.suggestions.map((s) => fmtTime(fromIso(s.startAt))).join(", ")}. Which time should I use?`
        : "\n\nThere are no free slots of that length that day — would another day work?";
      // Remember the appointment so a reply like "16:15" can be understood.
      session.partial = { type: "reschedule", target: { appointmentId: appt.id }, newDate, newTime: null };
      return { ...reply(`I can't move ${appt.clientName}'s ${appt.serviceName} to ${target} — ${why}.${suggestions}`), focusDate: newDate };
    }

    return this.setPending(session, {
      kind: "reschedule",
      params: { appointmentId: appt.id, newStartAt: plan.newStartAt },
      preview: { startAt: plan.newStartAt, endAt: plan.newEndAt },
      options: confirmOptions("Yes, move it"),
      focusDate: newDate,
      text:
        (fromIso(appt.startAt).hasSame(newStart, "day")
          ? `I'll move ${appt.clientName}'s ${appt.serviceName} (${fmtDay(newStart, now)}) from ${span(appt)} to ${fmtRange(newStart, newEnd)}. `
          : `I'll move ${appt.clientName}'s ${appt.serviceName} from ${span(appt)} on ${fmtDay(fromIso(appt.startAt), now)} to ${target}. `) +
        `Would you like me to proceed?`,
    });
  }

  planCancel(session, intent) {
    const now = this.schedule.now();
    const found = this.resolveAppointment(intent.target);
    if (found.none) return reply(`I couldn't find a matching upcoming appointment${describeTarget(intent.target)}.`);
    if (found.ambiguous) {
      session.partial = intent;
      return reply(`Several appointments could match — which one should I cancel?\n${found.ambiguous.map((a) => `• ${describeAppointment(a, now)}`).join("\n")}`);
    }
    const appt = found.match;
    return this.setPending(session, {
      kind: "cancel",
      params: { appointmentId: appt.id },
      preview: { startAt: appt.startAt, endAt: appt.endAt },
      options: [
        { id: "confirm", label: "Yes, cancel the appointment", tone: "danger" },
        { id: "abort", label: "No, keep it", tone: "neutral" },
      ],
      focusDate: fromIso(appt.startAt).toISODate(),
      text: `I'll cancel ${describeAppointment(appt, now)}. The slot will become bookable again. Are you sure?`,
    });
  }

  planUnblock(session, intent) {
    const now = this.schedule.now();
    const found = this.resolveBlock(intent.target ?? {});
    if (found.none) return reply("I couldn't find a matching blocked period. Which one should I remove?");
    if (found.ambiguous) {
      session.partial = intent;
      return reply(`Which blocked period should I remove?\n${found.ambiguous.map((b) => `• ${fmtDay(fromIso(b.startAt), now)}, ${describeBlock(b)}`).join("\n")}`);
    }
    const block = found.match;
    return this.setPending(session, {
      kind: "unblock",
      params: { blockId: block.id },
      options: confirmOptions("Yes, remove the block"),
      focusDate: fromIso(block.startAt).toISODate(),
      text: `I'll remove the blocked period on ${fmtDay(fromIso(block.startAt), now)}, ${describeBlock(block)}, so clients can book that time again. Proceed?`,
    });
  }

  setPending(session, { kind, params, options, focusDate, text, preview }) {
    session.pending = {
      id: randomUUID(),
      kind,
      params,
      options,
      focusDate,
      preview: preview ?? (params.startAt ? { startAt: params.startAt, endAt: params.endAt } : null),
    };
    return { ...reply(text), proposal: publicProposal(session.pending), focusDate };
  }

  // ---------- Execution (only after explicit confirmation) ----------

  execute(session, optionId) {
    const pending = session.pending;
    session.pending = null;
    const now = this.schedule.now();
    if (optionId === "abort") return { ...reply("No problem — I haven't changed anything."), focusDate: pending.focusDate };

    try {
      switch (pending.kind) {
        case "block":
        case "block_conflict":
          return this.executeBlock(session, pending, optionId);
        case "reschedule": {
          const appt = this.schedule.rescheduleAppointment(pending.params.appointmentId, pending.params.newStartAt);
          return done(`Done! ${appt.clientName}'s ${appt.serviceName} is now at ${span(appt)} on ${fmtDay(fromIso(appt.startAt), now)}.`, pending, appt.startAt);
        }
        case "cancel": {
          const appt = this.schedule.cancelAppointment(pending.params.appointmentId);
          return done(`Done. ${appt.clientName}'s ${appt.serviceName} (${span(appt)}) has been cancelled.`, pending);
        }
        case "unblock": {
          const block = this.schedule.removeBlock(pending.params.blockId);
          return done(`Done! ${span(block)} on ${fmtDay(fromIso(block.startAt), now)} is open for bookings again.`, pending);
        }
      }
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      return { ...reply(`I couldn't make that change: ${error.message} Nothing was modified.`), focusDate: pending.focusDate };
    }
    return reply("Something went wrong — nothing was changed.");
  }

  executeBlock(session, pending, optionId) {
    const now = this.schedule.now();
    const { startAt, endAt, reason } = pending.params;
    const start = fromIso(startAt);
    const end = fromIso(endAt);
    // Re-check: the schedule may have changed since the proposal was made.
    const plan = this.schedule.planBlock(start, end);
    if (!plan.ok) return { ...reply(`${plan.error} Nothing was changed.`), focusDate: pending.focusDate };
    const blockReason = reason ?? undefined;

    if (optionId === "confirm") {
      if (plan.conflicts.appointments.length)
        return this.proposeBlock(session, { start, end, reason, notice: "Heads up: the schedule changed since I asked. " });
      this.schedule.createBlock({ startAt, endAt, reason: blockReason });
      return done(`Done! Your availability is blocked ${fmtDay(start, now)}, ${fmtRange(start, end)}. Nobody can book during that time.`, pending);
    }

    if (optionId === "block_free") {
      const segments = plan.freeSegments.filter((s) => fromIso(s.endAt).diff(fromIso(s.startAt), "minutes").minutes >= 5);
      if (!segments.length) return { ...reply("There's no free time left in that period, so nothing was blocked."), focusDate: pending.focusDate };
      for (const s of segments) this.schedule.createBlock({ ...s, reason: blockReason });
      const kept = plan.conflicts.appointments.map((a) => `${a.clientName}'s ${span(a)} ${a.serviceName}`);
      return done(
        `Done! Blocked ${segments.map((s) => span(s)).join(" and ")} ${fmtDay(start, now)}. ${joinNames(kept)} ${kept.length > 1 ? "are" : "is"} untouched.`,
        pending,
      );
    }

    if (optionId === "block_and_cancel") {
      const cancelled = plan.conflicts.appointments.map((a) => this.schedule.cancelAppointment(a.id));
      this.schedule.createBlock({ startAt, endAt, reason: blockReason });
      return done(
        `Done. Cancelled ${joinNames(cancelled.map((a) => `${a.clientName}'s ${a.serviceName} (${span(a)})`))} and blocked ${fmtDay(start, now)}, ${fmtRange(start, end)}. ` +
          "(In the real platform the client would be notified.)",
        pending,
      );
    }
    return reply("Unknown option — nothing was changed.");
  }

  // ---------- Resolving references ----------

  resolveAppointment(target = {}) {
    if (target.appointmentId) {
      const appt = this.schedule.getAppointment(target.appointmentId);
      return appt && appt.status === "confirmed" && fromIso(appt.endAt) > this.schedule.now() ? { match: appt } : { none: true };
    }
    const candidates = this.schedule.upcoming(60).appointments.filter((a) => {
      const start = fromIso(a.startAt);
      if (target.clientName && a.clientName.toLowerCase() !== target.clientName.toLowerCase()) return false;
      if (target.date && start.toISODate() !== target.date) return false;
      if (target.time && fmtTime(start) !== target.time) return false;
      return start > this.schedule.now();
    });
    if (candidates.length === 1) return { match: candidates[0] };
    if (candidates.length === 0) return { none: true };
    return { ambiguous: candidates.slice(0, 8) };
  }

  resolveBlock(target) {
    if (target.blockId) {
      const block = this.schedule.getBlock(target.blockId);
      return block ? { match: block } : { none: true };
    }
    const candidates = this.schedule.upcoming(60).blocks.filter((b) => {
      const start = fromIso(b.startAt);
      if (target.date && start.toISODate() !== target.date) return false;
      if (target.time && fmtTime(start) !== target.time) return false;
      if (target.reasonHint && !(b.reason ?? "").toLowerCase().includes(target.reasonHint)) return false;
      return fromIso(b.endAt) > this.schedule.now();
    });
    if (candidates.length === 1) return { match: candidates[0] };
    if (candidates.length === 0) return { none: true };
    return { ambiguous: candidates.slice(0, 8) };
  }
}

// ---------- helpers ----------

function matchPendingReply(lower, pending) {
  const ids = pending.options.map((o) => o.id);
  const number = lower.match(/^(?:option )?([1-9])\b/);
  if (number && ids[+number[1] - 1]) return ids[+number[1] - 1];
  if (ids.includes("block_and_cancel") && /\bcancel\b.*\b(appointment|booking|her|him|them|it all|all)\b/.test(lower)) return "block_and_cancel";
  if (ids.includes("block_free") && /\b(free (time|part|parts)|only the free|around|just the free|partial)\b/.test(lower)) return "block_free";
  if (NO.test(lower)) return "abort";
  if (YES.test(lower)) return ids.includes("confirm") ? "confirm" : "ambiguous";
  return null;
}

function reply(text) {
  return { text, proposal: null, focusDate: null };
}

function done(text, pending, focusIso) {
  return { ...reply(text), focusDate: focusIso ? fromIso(focusIso).toISODate() : pending.focusDate, changed: true };
}

function publicProposal(pending) {
  return { id: pending.id, kind: pending.kind, options: pending.options, preview: pending.preview };
}

function confirmOptions(yesLabel) {
  return [
    { id: "confirm", label: yesLabel, tone: "primary" },
    { id: "abort", label: "Cancel", tone: "neutral" },
  ];
}

function listOptions(pending) {
  return pending.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
}

const span = (item) => fmtRange(fromIso(item.startAt), fromIso(item.endAt));
const describeBlock = (b) => `${span(b)}${b.reason ? ` ${b.reason}` : ""}`;

function describeAppointment(a, now) {
  return `${a.clientName}'s ${a.serviceName}, ${fmtDay(fromIso(a.startAt), now)}, ${span(a)}`;
}

function describeTarget(target = {}) {
  const parts = [];
  if (target.clientName) parts.push(`for ${target.clientName}`);
  if (target.time) parts.push(`at ${target.time}`);
  if (target.date) parts.push(`on ${target.date}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function invalidDateText(date) {
  return `${date ? `“${date}” isn't a valid date` : "I couldn't work out the date"} — which day did you mean?`;
}

function joinNames(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
