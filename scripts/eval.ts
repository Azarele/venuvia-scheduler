// AI eval: sends realistic requests to the configured AI (AI_PROVIDER in .env.local)
// and checks that it picks the right tool with the right arguments.
//
//   npm run eval                    run all cases once
//   npm run eval -- julia           only cases whose text contains "julia"
//   npm run eval -- --runs 3        run every case 3 times and report how consistent it is
//
// It also reports tokens and cost per message (cost for models with a known price,
// see src/lib/ai/pricing.ts).
//
// Runs against a separate database (venuvia_eval), so it can't change your bookings.
// Every case starts from fresh demo data and a fresh chat. Multi-step cases first send
// earlier messages (approving or rejecting their changes), then check the last reply.
import { DateTime } from "luxon";
import { resetDatabase, useIsolatedDatabase } from "./isolated-db.ts";

process.env.AI_USAGE_LOG = "0"; // the eval prints its own usage summary
await useIsolatedDatabase("eval");
const { pool } = await import("../src/lib/db.ts");
const { runAgent, resolvePending } = await import("../src/lib/ai/agent.ts");
const { getProvider, ProviderError } = await import("../src/lib/ai/providers.ts");
const { now } = await import("../src/lib/time.ts");

type Args = Record<string, unknown>;
type Outcome = { write?: { tool: string; args: Args; error?: string }; reads: string[]; pending: boolean; reply: string };
type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };
/** An earlier message in a multi-step case, and what to do with the change it proposes. */
type Step = { say: string; then: "approve" | "reject" | "nothing" };
type Case = { say: string; expect: string; check: (o: Outcome) => boolean; before?: Step[] };

const USER = 1; // Ewa: Anna 10:00 (#1), Marta 11:00 (#2), Julia 15:00 (#3), all tomorrow
const day = (d: DateTime) => d.toFormat("yyyy-MM-dd");
const T = day(now().plus({ days: 1 }));
const nextWeekday = (weekday: number) => {
  let d = now().plus({ days: 1 });
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d;
};
const at = (o: Outcome, tool: string) => o.write?.tool === tool;
const arg = (o: Outcome, key: string) => String(o.write?.args[key] ?? "");
const noChange = (o: Outcome) => !o.pending;
const polishReply = (o: Outcome) => /[ąćęłńóśźż]|\b(jutro|wizyt\w*|rezerwacj\w*|termin\w*|godzin\w*)\b/i.test(o.reply);

const CASES: Case[] = [
  {
    say: "Create a booking for 2pm tomorrow under a random name",
    expect: `create_booking ${T} 14:00, name not an existing client`,
    check: (o) => at(o, "create_booking") && arg(o, "start") === `${T} 14:00` && !["anna", "marta", "julia"].includes(arg(o, "client_name").toLowerCase()),
  },
  {
    say: "Book Emily next Friday at 11am for a haircut",
    expect: "create_booking Emily, a Friday at 11:00, service Haircut",
    check: (o) => at(o, "create_booking") && /emily/i.test(arg(o, "client_name")) && DateTime.fromSQL(arg(o, "start")).weekday === 5 && arg(o, "start").endsWith("11:00") && /hair/i.test(arg(o, "service")),
  },
  { say: "Book Anna again tomorrow at 9", expect: `create_booking Anna ${T} 09:00`, check: (o) => at(o, "create_booking") && /anna/i.test(arg(o, "client_name")) && arg(o, "start") === `${T} 09:00` },
  {
    say: "Book Zoe for a 90 minute colouring tomorrow at 4pm",
    expect: `create_booking Zoe ${T} 16:00–17:30`,
    check: (o) => at(o, "create_booking") && /zoe/i.test(arg(o, "client_name")) && arg(o, "start") === `${T} 16:00` && arg(o, "end") === `${T} 17:30`,
  },
  { say: "Move Julia to 5pm", expect: `update_booking #3 start ${T} 17:00`, check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "3" && arg(o, "start") === `${T} 17:00` },
  {
    say: "can we move julia to 5 to 6 instead of 3 to 4",
    expect: `update_booking #3 ${T} 17:00 (end 18:00 or kept length)`,
    check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "3" && arg(o, "start") === `${T} 17:00` && ["", `${T} 18:00`].includes(arg(o, "end")),
  },
  { say: "Push Anna's haircut back by 30 minutes", expect: `update_booking #1 start ${T} 10:30`, check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "1" && arg(o, "start") === `${T} 10:30` },
  {
    say: "Reschedule Marta to Thursday, same time",
    expect: "update_booking #2 to the coming Thursday 11:00",
    check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "2" && arg(o, "start") === `${day(nextWeekday(4))} 11:00`,
  },
  { say: "Change Julia's service to pedicure", expect: "update_booking #3 service Pedicure", check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "3" && /pedicure/i.test(arg(o, "service")) },
  { say: "Cancel tomorrow's 3pm", expect: "cancel_booking #3 (Julia)", check: (o) => at(o, "cancel_booking") && arg(o, "booking_id") === "3" },
  { say: "Cancel Marta's appointment", expect: "cancel_booking #2", check: (o) => at(o, "cancel_booking") && arg(o, "booking_id") === "2" },
  { say: "Undo my last change", expect: "calls undo_last_change (nothing to undo yet, so no card)", check: (o) => at(o, "undo_last_change") && noChange(o) },
  { say: "Get all bookings", expect: "get_bookings, no change", check: (o) => o.reads.includes("get_bookings") && !o.write },
  { say: "What does tomorrow look like?", expect: "get_bookings, no change", check: (o) => o.reads.includes("get_bookings") && !o.write },
  { say: "When am I free tomorrow afternoon?", expect: "find_free_slots or get_bookings, no change", check: (o) => (o.reads.includes("find_free_slots") || o.reads.includes("get_bookings")) && !o.write },
  {
    say: "Book Ola tomorrow at 3:30pm",
    expect: "clash with Julia → no card, reply offers a free time",
    check: (o) => noChange(o) && /\b(16[:.]00|4(:00)?\s*pm|14[:.]00|2(:00)?\s*pm)\b/i.test(o.reply),
  },
  { say: "Book a client tomorrow at 2", expect: "asks who the client is (no card)", check: (o) => noChange(o) && !o.write && /\?/.test(o.reply) },
  { say: "Delete everything", expect: "no change proposed", check: (o) => noChange(o) },

  // Multi-step: follow-ups that depend on what happened earlier in the chat.
  // The demo data has bookings #1–#4, so the first new booking is #5.
  {
    before: [{ say: "Book Ola tomorrow at 2pm", then: "approve" }],
    say: "Change it to 4pm",
    expect: `update_booking #5 (Ola) start ${T} 16:00`,
    check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "5" && arg(o, "start") === `${T} 16:00`,
  },
  {
    before: [{ say: "Book Ola tomorrow at 2pm", then: "approve" }],
    say: "Actually, cancel that one",
    expect: "cancel_booking #5 (the booking just made)",
    check: (o) => at(o, "cancel_booking") && arg(o, "booking_id") === "5",
  },
  {
    before: [{ say: "Move Julia to 5pm", then: "approve" }],
    say: "Undo that",
    expect: "undo_last_change with an approval card",
    check: (o) => at(o, "undo_last_change") && o.pending,
  },
  {
    before: [{ say: "Book Ola tomorrow at 2pm", then: "reject" }],
    say: "OK, make it 6pm instead",
    expect: `create_booking Ola ${T} 18:00`,
    check: (o) => at(o, "create_booking") && /ola/i.test(arg(o, "client_name")) && arg(o, "start") === `${T} 18:00`,
  },
  {
    before: [{ say: "Book Ola tomorrow at 3:30pm", then: "nothing" }],
    say: "OK, take the first free time you suggested",
    expect: "create_booking Ola at a free time (not 15:30) with an approval card",
    check: (o) => at(o, "create_booking") && /ola/i.test(arg(o, "client_name")) && arg(o, "start").startsWith(T) && arg(o, "start") !== `${T} 15:30` && o.pending,
  },

  // Opening hours (09:00–19:00).
  {
    say: "Book Ola tomorrow at 8pm",
    expect: "outside opening hours → no card, reply offers a time within hours",
    check: (o) => noChange(o) && /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b/i.test(o.reply),
  },

  // Polish (Venuvia's users write Polish): right tool, and the reply is in Polish.
  {
    say: "Zarezerwuj Olę jutro na 14:00",
    expect: `create_booking Ola ${T} 14:00`,
    check: (o) => at(o, "create_booking") && /^ol/i.test(arg(o, "client_name")) && arg(o, "start") === `${T} 14:00`,
  },
  { say: "Przełóż Julię na 17:00", expect: `update_booking #3 start ${T} 17:00`, check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "3" && arg(o, "start") === `${T} 17:00` },
  { say: "Odwołaj jutrzejszą wizytę o 15", expect: "cancel_booking #3 (Julia)", check: (o) => at(o, "cancel_booking") && arg(o, "booking_id") === "3" },
  { say: "Jakie mam jutro wizyty?", expect: "get_bookings, no change, reply in Polish", check: (o) => o.reads.includes("get_bookings") && !o.write && polishReply(o) },
  {
    before: [{ say: "Zarezerwuj Olę jutro na 14:00", then: "approve" }],
    say: "Zmień na 16:00",
    expect: `update_booking #5 start ${T} 16:00`,
    check: (o) => at(o, "update_booking") && arg(o, "booking_id") === "5" && arg(o, "start") === `${T} 16:00`,
  },
];

const argv = process.argv.slice(2);
const runsFlag = argv.findIndex((a) => a === "--runs" || a.startsWith("--runs="));
const runs = Math.max(1, runsFlag < 0 ? 1 : Number(argv[runsFlag].split("=")[1] ?? argv[runsFlag + 1]) || 1);
const filter = argv.filter((a, i) => !a.startsWith("--") && !(runsFlag >= 0 && i === runsFlag + 1)).join(" ").toLowerCase();
const cases = CASES.filter((c) => !filter || [c.say, ...(c.before ?? []).map((b) => b.say)].some((t) => t.toLowerCase().includes(filter)));
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 4000); // free tiers allow only a few requests per minute
const verbose = runs === 1; // with several runs, print one compact line per case
const baseProvider = getProvider();
// Wraps the provider to print each AI step live, so a slow or stuck request is visible.
const provider = {
  ...baseProvider,
  async complete(request: Parameters<typeof baseProvider.complete>[0]) {
    const started = Date.now();
    if (verbose) process.stdout.write(`      · asking ${baseProvider.name}… `);
    try {
      const reply = await baseProvider.complete(request);
      const calls = reply.tool_calls?.map((c) => c.function.name).join(", ");
      if (verbose) process.stdout.write(`${calls ? `→ ${calls}` : "→ text reply"} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
      return reply;
    } catch (error) {
      if (verbose) process.stdout.write(`failed after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      throw error;
    }
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends one message; if the AI is overloaded or times out, waits and retries once. */
async function ask(text: string) {
  try {
    return await runAgent({ userId: USER, text, provider });
  } catch (error) {
    if (!(error instanceof ProviderError) || !/429|503|didn't respond/.test(error.message)) throw error;
    console.log(`      (${error.message.slice(0, 80)} — waiting 30s and retrying once)`);
    await sleep(30_000);
    return runAgent({ userId: USER, text, provider, retry: true });
  }
}

/** Runs one case once from fresh data. Returns the outcome, the time taken and the usage of every message sent. */
async function runCase(c: Case): Promise<{ outcome: Outcome; ms: number; usages: Usage[] }> {
  await resetDatabase(pool); // fresh demo data (and an empty chat) for every case
  const usages: Usage[] = [];
  const started = Date.now();
  try {
    for (const step of c.before ?? []) {
      const res = await ask(step.say);
      if (res.usage) usages.push(res.usage);
      if (step.then === "nothing") continue;
      if (!res.pending) throw new Error(`setup step "${step.say}" didn't propose a change: ${(res.reply ?? "").slice(0, 80)}`);
      await resolvePending({ userId: USER, pendingId: res.pending.id, approved: step.then === "approve" });
    }
    const res = await ask(c.say);
    if (res.usage) usages.push(res.usage);
    const write = res.events.find((e) => e.kind === "write");
    if (res.pending) await resolvePending({ userId: USER, pendingId: res.pending.id, approved: false }); // never apply the case itself
    return {
      outcome: {
        write: write && { tool: write.tool, args: write.args, error: write.error },
        reads: res.events.filter((e) => e.kind === "read").map((e) => e.tool),
        pending: Boolean(res.pending),
        reply: res.reply ?? "",
      },
      ms: Date.now() - started,
      usages,
    };
  } catch (error) {
    return { outcome: { reads: [], pending: false, reply: `ERROR: ${(error as Error).message}` }, ms: Date.now() - started, usages };
  }
}

const describe = (o: Outcome) =>
  o.write
    ? `${o.write.tool} ${JSON.stringify(o.write.args)}${o.write.error ? ` → refused: ${o.write.error.slice(0, 60)}` : ""}`
    : `${o.reads.join(", ") || "no tools"} → "${o.reply.replace(/\s+/g, " ").slice(0, 80)}"`;

console.log(
  `\nEval: ${provider.name} · ${provider.model} · ${cases.length} cases${runs > 1 ? ` × ${runs} runs` : ""} · timeout ${(Number(process.env.AI_TIMEOUT_MS) || 60_000) / 1000}s per AI request · today is ${now().toFormat("ccc yyyy-MM-dd")}\n`,
);

let totalPasses = 0;
let totalMs = 0;
const allUsages: Usage[] = [];
const alwaysPass: string[] = [];
const flaky: string[] = [];
const alwaysFail: string[] = [];
let first = true;
for (const [i, c] of cases.entries()) {
  const label = [...(c.before ?? []).map((b) => `${b.say} [${b.then === "nothing" ? "no card expected" : b.then}]`), c.say].join("  →  ");
  console.log(`${String(i + 1).padStart(2)}/${cases.length}  ${label}`);
  const marks: string[] = [];
  let lastFailure: Outcome | null = null;
  for (let r = 0; r < runs; r++) {
    if (!first) await sleep(delayMs);
    first = false;
    const { outcome, ms, usages } = await runCase(c);
    totalMs += ms;
    allUsages.push(...usages);
    const ok = c.check(outcome);
    if (ok) totalPasses++;
    else lastFailure = outcome;
    marks.push(ok ? "✓" : "✗");
    if (verbose) console.log(`      ${ok ? "✓ pass" : "✗ FAIL"} (${(ms / 1000).toFixed(1)}s)`);
  }
  const passes = marks.filter((m) => m === "✓").length;
  if (!verbose) console.log(`      ${marks.join(" ")}  (${passes}/${runs})`);
  if (lastFailure) console.log(`        expected: ${c.expect}\n        got:      ${describe(lastFailure)}`);
  (passes === runs ? alwaysPass : passes === 0 ? alwaysFail : flaky).push(c.say);
}

const caseRuns = cases.length * runs;
const pct = caseRuns ? Math.round((totalPasses / caseRuns) * 100) : 0;
console.log(`\n${totalPasses}/${caseRuns} passed (${pct}%) · avg ${(totalMs / Math.max(caseRuns, 1) / 1000).toFixed(1)}s per case (incl. tool round trips)`);
if (runs > 1) console.log(`Always passed: ${alwaysPass.length}/${cases.length}${flaky.length ? ` · flaky: ${flaky.map((f) => `"${f}"`).join(", ")}` : ""}`);
if (alwaysFail.length) console.log(`Always failed: ${alwaysFail.map((f) => `"${f}"`).join(", ")}`);

if (allUsages.length) {
  const sum = (k: "calls" | "inputTokens" | "outputTokens") => allUsages.reduce((n, u) => n + u[k], 0);
  const n = allUsages.length;
  const costs = allUsages.map((u) => u.costUsd);
  const cost = costs.every((c) => c != null) ? `~$${((costs as number[]).reduce((a, b) => a + b, 0) / n).toFixed(5)} per message` : "cost n/a (no price for this model; set AI_PRICE_INPUT / AI_PRICE_OUTPUT, USD per million tokens)";
  console.log(
    `Per message (avg of ${n}): ${(sum("calls") / n).toFixed(1)} AI calls · ${Math.round(sum("inputTokens") / n).toLocaleString("en-US")} input + ${Math.round(sum("outputTokens") / n).toLocaleString("en-US")} output tokens · ${cost}`,
  );
}
await pool.end();
process.exitCode = flaky.length || alwaysFail.length ? 1 : 0;
