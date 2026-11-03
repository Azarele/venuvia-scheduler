// End-to-end tests of the agent against a real Postgres database (venuvia_test),
// with a fake AI provider that returns scripted tool calls.
import "./use-test-db.ts"; // must be first: switches DATABASE_URL to the test database
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { proposeUndo, resolvePending, runAgent } from "../src/lib/ai/agent.ts";
import type { AssistantMessage, ChatMessage, Provider } from "../src/lib/ai/providers.ts";
import { getBookings, getClients, getEvents } from "../src/lib/bookings.ts";
import { loadConversation } from "../src/lib/conversation.ts";
import { pool } from "../src/lib/db.ts";
import { now } from "../src/lib/time.ts";
import { resetDatabase } from "../scripts/isolated-db.ts";

const EWA = 1;
const KASIA = 2;
const tomorrow = () => now().plus({ days: 1 }).toFormat("yyyy-MM-dd");

beforeEach(() => resetDatabase(pool));
after(() => pool.end());

/** A provider that replays a fixed list of responses and records what it was sent. */
function fakeProvider(responses: AssistantMessage[]): Provider & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  return {
    name: "fake",
    model: "fake",
    requests,
    async complete({ messages }) {
      requests.push(structuredClone(messages));
      const next = responses.shift();
      if (!next) throw new Error("fake provider ran out of responses");
      return next;
    },
  };
}

let callCounter = 0;
const toolCall = (name: string, args: unknown): AssistantMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${name}_${++callCounter}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const text = (content: string): AssistantMessage => ({ role: "assistant", content });
const lastToolResult = (p: { requests: ChatMessage[][] }, request: number) =>
  JSON.parse((p.requests[request].at(-1) as { content: string }).content);

/** Sends a message, expects an approval card, and approves it. */
async function proposeAndApprove(text: string, responses: AssistantMessage[]) {
  const res = await runAgent({ userId: EWA, text, provider: fakeProvider(responses) });
  assert.ok(res.pending, `expected an approval card for "${text}"`);
  return resolvePending({ userId: EWA, pendingId: res.pending.id, approved: true });
}

// ---------- The core flow ----------

test("create booking: nothing is written until approval; then booking + audit row + saved chat", async () => {
  const provider = fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  const res = await runAgent({ userId: EWA, text: "Create a booking for 2pm tomorrow under a random name", provider });

  assert.ok(res.pending);
  assert.equal(res.pending.details.kind, "create");
  assert.match(res.pending.summary, /Create booking: Ola, .* \(tomorrow\), 14:00–15:00/);
  assert.equal((await getBookings(EWA)).length, 3, "not written yet");
  assert.equal((await getEvents(EWA)).length, 0);

  const done = await resolvePending({ userId: EWA, pendingId: res.pending.id, approved: true });
  assert.match(done.reply ?? "", /Done — booked Ola/);
  const ola = (await getBookings(EWA)).find((b) => b.clientName === "Ola")!;
  assert.equal(ola.start, `${tomorrow()} 14:00`);
  assert.ok((await getClients()).some((c) => c.name === "Ola"), "new client row created");

  const [event] = await getEvents(EWA);
  assert.equal(event.action, "created");
  assert.equal(event.approvedBy, "Ewa");
  assert.equal(event.after.id, ola.id);

  // The chat is stored in Postgres, including the approved card.
  const saved = await loadConversation(EWA);
  assert.equal(saved.bubbles.find((b) => b.pending)?.decision, "approved");
  assert.ok(saved.history.some((m) => m.role === "tool" && JSON.parse(m.content).ok), "AI is told the result");
});

test("change it to 4pm: earlier chat is loaded from the database, AI looks up then updates", async () => {
  await proposeAndApprove("book Ola at 2pm tomorrow", [toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  const olaId = (await getBookings(EWA, { clientName: "Ola" }))[0].id;

  const provider = fakeProvider([
    toolCall("get_bookings", { client_name: "Ola" }),
    toolCall("update_booking", { booking_id: olaId, start: `${tomorrow()} 16:00` }),
  ]);
  const res = await runAgent({ userId: EWA, text: "Change it to 4pm", provider });
  assert.ok(provider.requests[0].some((m) => m.role === "user" && m.content === "book Ola at 2pm tomorrow"), "history came from the DB");
  assert.equal(lastToolResult(provider, 1).bookings[0].id, olaId);
  assert.equal(res.pending!.details.kind, "update");
  assert.match(res.pending!.details.from!, /14:00–15:00/);
  assert.match(res.pending!.details.to!, /16:00–17:00/);

  await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: true });
  const ola = (await getBookings(EWA, { clientName: "Ola" }))[0];
  assert.equal(ola.start, `${tomorrow()} 16:00`);
  assert.equal(ola.end, `${tomorrow()} 17:00`, "duration kept");
  const [event] = await getEvents(EWA);
  assert.equal(event.action, "updated");
  assert.equal(event.before?.start, `${tomorrow()} 14:00`);
  assert.equal(event.after.start, `${tomorrow()} 16:00`);
});

test("rejecting leaves the database untouched; approving twice runs only once", async () => {
  const res = await runAgent({ userId: EWA, text: "book Ola", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]) });
  const rejected = await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: false });
  assert.match(rejected.reply ?? "", /didn't change anything/);
  assert.equal((await getBookings(EWA)).length, 3);

  const again = await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: true });
  assert.match(again.bubbles.at(-1)!.text, /no longer pending/);
  assert.equal((await getBookings(EWA)).length, 3);
  assert.equal((await getEvents(EWA)).length, 0);
});

test("typing a new message while a change is waiting rejects it and keeps the AI transcript valid", async () => {
  const res = await runAgent({ userId: EWA, text: "book Ola", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]) });
  const provider = fakeProvider([text("Sure.")]);
  await runAgent({ userId: EWA, text: "actually never mind", provider });
  const sent = provider.requests[0];
  const toolCallId = (sent.find((m) => m.role === "assistant" && m.tool_calls) as AssistantMessage).tool_calls![0].id;
  assert.ok(sent.some((m) => m.role === "tool" && m.tool_call_id === toolCallId), "the waiting tool call got an answer");
  const card = (await loadConversation(EWA)).bubbles.find((b) => b.pending?.id === res.pending!.id);
  assert.equal(card?.decision, "rejected");
  assert.equal((await getBookings(EWA)).length, 3);
});

test("get all bookings returns the user's bookings with day labels", async () => {
  const provider = fakeProvider([toolCall("get_bookings", {}), text("Here are your bookings.")]);
  const res = await runAgent({ userId: EWA, text: "Get all bookings", provider });
  assert.equal(res.reply, "Here are your bookings.");
  const result = lastToolResult(provider, 1);
  assert.deepEqual(result.bookings.map((b: { client: string }) => b.client), ["Anna", "Marta", "Julia"]);
  assert.match(result.bookings[0].day, /\(tomorrow\)$/);
});

// ---------- Checks and the database guarantee ----------

test("overlaps are refused with the nearest free times; past times are refused", async () => {
  const provider = fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 15:30` }), text("Taken.")]);
  const res = await runAgent({ userId: EWA, text: "book Ola at 3:30pm tomorrow", provider });
  assert.equal(res.pending, null);
  assert.match(res.events[0].error ?? "", /overlaps an existing booking \(#\d+ Julia 15:00–16:00\)\. Nearest free times that day: 16:00, 16:15, 16:30\./);

  const past = fakeProvider([toolCall("create_booking", { client_name: "Ola", start: "2020-01-01 10:00" }), text("Past.")]);
  const res2 = await runAgent({ userId: EWA, text: "book Ola on 1 Jan 2020", provider: past });
  assert.match(res2.events[0].error ?? "", /in the past/);
  assert.equal((await getBookings(EWA)).length, 3);
});

test("find_free_slots returns open times near a requested time", async () => {
  const provider = fakeProvider([toolCall("find_free_slots", { date: tomorrow(), near: "11:30" }), text("ok")]);
  await runAgent({ userId: EWA, text: "when am I free around 11:30 tomorrow?", provider });
  const starts = lastToolResult(provider, 1).free_slots.map((s: { start: string }) => s.start.slice(11));
  assert.ok(!starts.includes("11:30"), "Marta is booked 11:00–13:00");
  assert.ok(starts.includes("13:30"));
  assert.ok(starts.includes("09:00"));
});

test("the database itself refuses overlapping confirmed bookings (exclusion constraint)", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  await assert.rejects(
    pool.query(`insert into bookings (user_id, client_id, start_at, end_at) select user_id, client_id, start_at + interval '15 minutes', end_at from bookings where id = $1`, [julia.id]),
    /bookings_no_overlap/,
  );
  // A cancelled booking doesn't block the slot, and another user's booking never does.
  await pool.query(`insert into bookings (user_id, client_id, start_at, end_at, status) select user_id, client_id, start_at, end_at, 'cancelled' from bookings where id = $1`, [julia.id]);
  await pool.query(`insert into bookings (user_id, client_id, start_at, end_at) select $2, client_id, start_at, end_at from bookings where id = $1`, [julia.id, KASIA]);
});

test("approval re-checks: a clash created after the proposal stops the write", async () => {
  const res = await runAgent({ userId: EWA, text: "book Ola 5pm", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 17:00` })]) });
  await pool.query(
    `insert into bookings (user_id, client_id, start_at, end_at) values (1, 1, $1::timestamptz, $1::timestamptz + interval '30 minutes')`,
    [now().plus({ days: 1 }).set({ hour: 17, minute: 15, second: 0, millisecond: 0 }).toISO()],
  );
  const done = await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: true });
  assert.match(done.reply ?? "", /couldn't make that change: That overlaps/);
  assert.equal(done.bubbles.find((b) => b.pending)?.decision, "failed");
});

test("a user can't touch another user's booking", async () => {
  const kasiaBooking = (await getBookings(KASIA))[0];
  const provider = fakeProvider([toolCall("update_booking", { booking_id: kasiaBooking.id, start: `${tomorrow()} 18:00` }), text("Not found.")]);
  const res = await runAgent({ userId: EWA, text: "move booking to 6pm", provider });
  assert.match(res.events[0].error ?? "", /doesn't exist for this user/);
});

// ---------- Cancel ----------

test("cancel: needs approval, keeps the row as history, frees the slot, logs it", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  const done = await proposeAndApprove("Cancel Julia's booking", [toolCall("get_bookings", { client_name: "Julia" }), toolCall("cancel_booking", { booking_id: julia.id })]);
  assert.match(done.reply ?? "", /Done — cancelled booking #\d+ \(Julia/);
  assert.deepEqual((await getBookings(EWA)).map((b) => b.clientName), ["Anna", "Marta"]);
  assert.equal((await getBookings(EWA, { includeCancelled: true })).find((b) => b.id === julia.id)?.status, "cancelled");
  assert.equal((await getEvents(EWA))[0].action, "cancelled");

  const rebook = await runAgent({ userId: EWA, text: "book Ola 3pm", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 15:00` })]) });
  assert.ok(rebook.pending, "the freed slot can be booked");
});

test("cancel checks: already cancelled, and a cancelled booking can't be changed", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  await pool.query("update bookings set status = 'cancelled' where id = $1", [julia.id]);
  const again = await runAgent({ userId: EWA, text: "cancel julia", provider: fakeProvider([toolCall("cancel_booking", { booking_id: julia.id }), text("x")]) });
  assert.match(again.events[0].error ?? "", /already cancelled/);
  const move = await runAgent({ userId: EWA, text: "move julia", provider: fakeProvider([toolCall("update_booking", { booking_id: julia.id, start: `${tomorrow()} 18:00` }), text("x")]) });
  assert.match(move.events[0].error ?? "", /is cancelled, so it can't be changed/);
});

// ---------- Undo ----------

test("undo steps back through changes: a move, then a cancel, then a create", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  await proposeAndApprove("book Ola 2pm", [toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  await proposeAndApprove("cancel Anna", [toolCall("cancel_booking", { booking_id: 1 })]);
  await proposeAndApprove("move Julia to 5pm", [toolCall("update_booking", { booking_id: julia.id, start: `${tomorrow()} 17:00` })]);

  // 1st undo: Julia goes back to 15:00.
  let res = await runAgent({ userId: EWA, text: "undo that", provider: fakeProvider([toolCall("undo_last_change", {})]) });
  assert.equal(res.pending!.details.kind, "undo");
  assert.match(res.pending!.details.to!, /Julia .* 15:00–16:00/);
  let done = await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: true });
  assert.match(done.reply ?? "", /back to Julia/);
  assert.equal((await getBookings(EWA, { clientName: "Julia" }))[0].start, `${tomorrow()} 15:00`);

  // 2nd undo: Anna's cancelled booking is restored.
  done = await proposeAndApprove("undo again", [toolCall("undo_last_change", {})]);
  assert.match(done.reply ?? "", /restored/);
  assert.equal((await getBookings(EWA, { clientName: "Anna" }))[0].status, "confirmed");

  // 3rd undo: Ola's new booking is cancelled again.
  done = await proposeAndApprove("and again", [toolCall("undo_last_change", {})]);
  assert.match(done.reply ?? "", /new booking #\d+ for Ola is cancelled/);
  assert.equal((await getBookings(EWA, { clientName: "Ola" })).length, 0);

  // Nothing left.
  res = await runAgent({ userId: EWA, text: "undo", provider: fakeProvider([toolCall("undo_last_change", {}), text("Nothing to undo.")]) });
  assert.match(res.events[0].error ?? "", /no change to undo/);
  assert.deepEqual((await getEvents(EWA)).map((e) => e.action), ["undone", "undone", "undone", "updated", "cancelled", "created"]);
});

test("the Undo button proposes an undo without the AI; it's logged as such", async () => {
  await proposeAndApprove("book Ola 2pm", [toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  const proposal = await proposeUndo(EWA);
  assert.match(proposal.pending!.summary, /^Undo: Cancel booking #\d+ \(Ola/);
  await resolvePending({ userId: EWA, pendingId: proposal.pending!.id, approved: true });
  const [event] = await getEvents(EWA);
  assert.equal(event.action, "undone");
  assert.equal(event.source, "undo-button");
  assert.match((await loadConversation(EWA)).history.at(-1)!.content as string, /Undo button/);
});

test("undo is refused if the booking was changed by something else since", async () => {
  await proposeAndApprove("book Ola 2pm", [toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  await pool.query("update bookings set service = 'Massage' where client_id = (select id from clients where name = 'Ola')");
  const res = await proposeUndo(EWA);
  assert.equal(res.pending, null);
  assert.match(res.bubbles.at(-1)!.text, /has changed since then/);
});

// ---------- Opening hours ----------

test("bookings must fit within opening hours; the error suggests free times", async () => {
  const late = await runAgent({ userId: EWA, text: "book Ola at 8pm", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 20:00` }), text("Closed then.")]) });
  assert.equal(late.pending, null);
  assert.match(late.events[0].error ?? "", /outside opening hours \(09:00–19:00\)\. Nearest free times that day: /);
  const early = await runAgent({ userId: EWA, text: "move Julia to 8am", provider: fakeProvider([toolCall("update_booking", { booking_id: 3, start: `${tomorrow()} 08:00` }), text("Too early.")]) });
  assert.match(early.events[0].error ?? "", /outside opening hours/);
  const overrun = await runAgent({ userId: EWA, text: "book Ola 6:30pm", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 18:30` }), text("Runs past closing.")]) });
  assert.match(overrun.events[0].error ?? "", /outside opening hours/, "18:30–19:30 ends after closing");
});

// ---------- Two tabs at once ----------

test("two requests at the same time don't overwrite each other's chat (per-user lock)", async () => {
  const slow = (reply: string): Provider => ({
    name: "slow",
    model: "slow",
    async complete() {
      await new Promise((r) => setTimeout(r, 150));
      return text(reply);
    },
  });
  await Promise.all([
    runAgent({ userId: EWA, text: "first tab", provider: slow("reply one") }),
    runAgent({ userId: EWA, text: "second tab", provider: slow("reply two") }),
  ]);
  const texts = (await loadConversation(EWA)).bubbles.map((b) => b.text);
  assert.ok(texts.includes("first tab") && texts.includes("second tab"), `both messages kept: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("reply one") && texts.includes("reply two"));
});

// ---------- Retry, usage, progress, Polish ----------

test("an AI error leaves a Retry-able message; retrying replaces it instead of duplicating", async () => {
  const { ProviderError } = await import("../src/lib/ai/providers.ts");
  const failing: Provider = { name: "x", model: "x", complete: async () => { throw new ProviderError("Gemini didn't respond within 60s."); } };
  await assert.rejects(runAgent({ userId: EWA, text: "Get all bookings", provider: failing }));
  let bubbles = (await loadConversation(EWA)).bubbles;
  assert.equal(bubbles.at(-1)?.role, "error");
  assert.equal(bubbles.at(-1)?.retryText, "Get all bookings");

  await runAgent({ userId: EWA, text: "Get all bookings", retry: true, provider: fakeProvider([text("Here they are.")]) });
  bubbles = (await loadConversation(EWA)).bubbles;
  assert.deepEqual(bubbles.map((b) => `${b.role}: ${b.text}`), ["user: Get all bookings", "assistant: Here they are."]);
});

test("token usage is summed per message and priced for known models", async () => {
  const withUsage = (m: AssistantMessage, inputTokens: number, outputTokens: number) => ({ ...m, usage: { inputTokens, outputTokens } });
  const provider = fakeProvider([withUsage(toolCall("get_bookings", {}), 1000, 50), withUsage(text("Done."), 1200, 100)]);
  provider.model = "claude-haiku-5-5";
  const res = await runAgent({ userId: EWA, text: "bookings?", provider });
  assert.deepEqual({ ...res.usage, costUsd: Number(res.usage!.costUsd!.toFixed(6)) }, {
    calls: 2, inputTokens: 2200, outputTokens: 150, model: "claude-haiku-5-5", costUsd: Number(((2200 * 0.1 + 150 * 0.5) / 1e6).toFixed(6)),
  });
  const saved = (await loadConversation(EWA)).bubbles.at(-1);
  assert.equal(saved?.usage?.calls, 2);
  assert.ok(!(await loadConversation(EWA)).history.some((m) => "usage" in m), "usage isn't stored in the AI transcript");
});

test("live progress is reported while the assistant works", async () => {
  const labels: string[] = [];
  await runAgent({ userId: EWA, text: "bookings?", provider: fakeProvider([toolCall("get_bookings", {}), text("ok")]), onProgress: (p) => labels.push(p.label) });
  assert.deepEqual(labels, ["Thinking…", "Looking up your bookings…", "Thinking…"]);
});

test("Polish: approval card and confirmation are in Polish when the user writes Polish", async () => {
  const res = await runAgent({ userId: EWA, text: "Zarezerwuj Olę jutro na 14:00", provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]) });
  assert.equal(res.pending!.details.lang, "pl");
  assert.equal(res.pending!.details.title, "Nowa rezerwacja");
  assert.match(res.pending!.details.to!, /Ola, \S+ \d+ \S+ \(jutro\), 14:00–15:00/);
  assert.match(res.pending!.summary, /^Create booking: Ola/, "the internal summary stays English");
  const done = await resolvePending({ userId: EWA, pendingId: res.pending!.id, approved: true });
  assert.match(done.reply ?? "", /^Gotowe — zarezerwowano: Ola/);

  const rejected = await runAgent({ userId: EWA, text: "Przełóż Olę na 16:00", provider: fakeProvider([toolCall("update_booking", { booking_id: 5, start: `${tomorrow()} 16:00` })]) });
  assert.equal(rejected.pending!.details.title, "Zmiana rezerwacji #5");
  const no = await resolvePending({ userId: EWA, pendingId: rejected.pending!.id, approved: false });
  assert.equal(no.reply, "W porządku — niczego nie zmieniłem.");
});
