// LLM interpreter: asks Claude to translate the owner's message into exactly one
// structured "proposal" tool call. The tools are never executed against data here —
// the tool call is just a typed intent that the backend validates and turns into a
// proposal the owner must confirm. Claude cannot write to the schedule.
import Anthropic from "@anthropic-ai/sdk";
import { BUSINESS, fmtTime, fromIso } from "../time.js";

const DATE = { type: "string", description: "Local date, YYYY-MM-DD." };
const TIME = { type: "string", description: "Local 24h time, HH:mm." };
const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });

const TARGET_APPOINTMENT = {
  type: "object",
  description: "Which existing appointment the owner means.",
  properties: {
    appointmentId: nullable({ type: "string", description: "e.g. apt_003, if you can identify it from the schedule." }),
    clientName: nullable({ type: "string" }),
    date: nullable(DATE),
    time: nullable({ ...TIME, description: "Current start time of the appointment, HH:mm." }),
  },
  required: ["appointmentId", "clientName", "date", "time"],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "propose_block_time",
    description:
      "Propose blocking a period so no new appointments can be booked. Does NOT change anything; the app will show the owner a confirmation.",
    input_schema: {
      type: "object",
      properties: {
        date: DATE,
        startTime: TIME,
        endTime: TIME,
        reason: nullable({ type: "string", description: "Short reason if the owner gave one." }),
      },
      required: ["date", "startTime", "endTime", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_reschedule",
    description: "Propose moving an existing appointment to a new start time (duration stays the same).",
    input_schema: {
      type: "object",
      properties: {
        target: TARGET_APPOINTMENT,
        newDate: nullable({ ...DATE, description: "New date; null means the same day as now." }),
        newTime: TIME,
      },
      required: ["target", "newDate", "newTime"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_cancel_appointment",
    description: "Propose cancelling an existing client appointment.",
    input_schema: {
      type: "object",
      properties: { target: TARGET_APPOINTMENT },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_unblock",
    description: "Propose removing an existing blocked period so it becomes bookable again.",
    input_schema: {
      type: "object",
      properties: {
        blockId: nullable({ type: "string", description: "e.g. blk_001" }),
        date: nullable(DATE),
        time: nullable({ ...TIME, description: "Start time of the block." }),
      },
      required: ["blockId", "date", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "show_schedule",
    description: "Show the owner's appointments and blocked periods for one day.",
    input_schema: {
      type: "object",
      properties: { date: DATE },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_clarification",
    description:
      "Ask the owner a short question when the request is ambiguous or missing information (no clear day, vague times like 'afternoon', several matching appointments), or is not a scheduling request.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

function systemPrompt({ now, upcoming }) {
  const line = (item, text) =>
    `- ${item.id}: ${fromIso(item.startAt).toFormat("ccc yyyy-MM-dd")} ${fmtTime(fromIso(item.startAt))}–${fmtTime(fromIso(item.endAt))} ${text}`;
  const appointments =
    upcoming.appointments.map((a) => line(a, `${a.clientName} (${a.serviceName})`)).join("\n") || "- none";
  const blocks = upcoming.blocks.map((b) => line(b, `blocked${b.reason ? ` (${b.reason})` : ""}`)).join("\n") || "- none";

  return `You are the scheduling assistant inside Venuvia, a booking platform for beauty and wellness businesses. You are talking to the owner of ${BUSINESS.name}.

Your only job is to translate the owner's latest message into exactly one tool call. Always respond with a single tool call and no other text. The app validates every call, checks for conflicts, and asks the owner to confirm before anything changes, so never claim that something has been done.

Rules:
- Dates are YYYY-MM-DD and times are 24-hour HH:mm, in the business's local timezone (${BUSINESS.timezone}). Resolve relative expressions like "tomorrow" or "next Friday" from the current date below.
- If the owner gives an impossible or past date, still pass it through exactly as stated (e.g. 2026-02-30); the app explains the problem.
- Times without AM/PM between 1 and 7 almost certainly mean the afternoon (opening hours are ${BUSINESS.openTime}–${BUSINESS.closeTime}).
- If the day or times are missing or vague ("in the afternoon", "later"), call ask_clarification instead of guessing.
- When the owner refers to an existing appointment or block, use its id from the schedule below. If several could match, ask which one.
- Use the conversation so far to fill in details from earlier messages (e.g. the owner answering your clarifying question).
- Do not cancel appointments unless the owner explicitly asks to cancel them.

Current local date and time: ${now.toFormat("cccc yyyy-MM-dd HH:mm")} (${BUSINESS.timezone}).

Upcoming appointments:
${appointments}

Upcoming blocked periods:
${blocks}`;
}

/** Maps a tool call to the intent shape shared with the mock interpreter. */
export function toolCallToIntent(name, input) {
  switch (name) {
    case "propose_block_time":
      return { type: "block_time", date: input.date, startTime: input.startTime, endTime: input.endTime, reason: input.reason ?? null };
    case "propose_reschedule":
      return { type: "reschedule", target: input.target ?? {}, newDate: input.newDate ?? null, newTime: input.newTime };
    case "propose_cancel_appointment":
      return { type: "cancel_appointment", target: input.target ?? {} };
    case "propose_unblock":
      return { type: "unblock", target: { blockId: input.blockId, date: input.date, time: input.time } };
    case "show_schedule":
      return { type: "show_schedule", date: input.date };
    case "ask_clarification":
      return { type: "clarify", question: input.question };
    default:
      return { type: "unknown" };
  }
}

export function createLlmInterpreter({ model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5", client } = {}) {
  const anthropic = client ?? new Anthropic();

  return {
    name: "claude",
    model,
    async interpret({ text, history, context }) {
      const messages = buildMessages(history, text);
      const response = await anthropic.beta.messages.create({
        model,
        max_tokens: 4000,
        // A short, structured translation task: low effort keeps latency down.
        output_config: { effort: "low" },
        // If a safety classifier declines, the API retries on a suitable fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: systemPrompt(context),
        tools: TOOLS,
        tool_choice: { type: "auto" },
        messages,
      });

      if (response.stop_reason === "refusal") {
        return { type: "unknown", message: "Sorry, I can't help with that request." };
      }
      const toolUse = response.content.find((block) => block.type === "tool_use");
      if (toolUse) return toolCallToIntent(toolUse.name, toolUse.input);
      // No tool call: treat any text as a clarifying question rather than an action.
      const textBlock = response.content.find((block) => block.type === "text");
      return textBlock?.text ? { type: "clarify", question: textBlock.text.trim() } : { type: "unknown" };
    },
  };
}

/** Conversation history as alternating user/assistant text turns, ending with the new message. */
function buildMessages(history, text) {
  const turns = [...history.slice(-8), { role: "user", text }];
  const messages = [];
  for (const turn of turns) {
    const last = messages[messages.length - 1];
    if (last?.role === turn.role) last.content += `\n${turn.text}`;
    else messages.push({ role: turn.role, content: turn.text });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}
