// End-to-end tests of the agent against the real Postgres database, with a fake
// AI provider that returns scripted tool calls. Needs DATABASE_URL (see README).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import { resolvePending, runAgent } from "../src/lib/ai/agent.ts";
import type { AssistantMessage, ChatMessage, Provider } from "../src/lib/ai/providers.ts";
import { getBookings, getClients } from "../src/lib/bookings.ts";
import { pool } from "../src/lib/db.ts";
import { now } from "../src/lib/time.ts";

const EWA = 1;
const tomorrow = () => now().plus({ days: 1 }).toFormat("yyyy-MM-dd");

beforeEach(async () => {
  for (const file of ["db/schema.sql", "db/seed.sql"]) await pool.query(await readFile(file, "utf8"));
});
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

const toolCall = (name: string, args: unknown, id = `call_${name}`): AssistantMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const text = (content: string): AssistantMessage => ({ role: "assistant", content });

test("create booking: nothing is written until the user approves", async () => {
  const provider = fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]);
  const res = await runAgent({ userId: EWA, history: [], text: "Create a booking for 2pm tomorrow under a random name", provider });

  assert.ok(res.pending);
  assert.match(res.pending.summary, /Create booking: Ola, .* 14:00–15:00/);
  assert.equal((await getBookings(EWA)).length, 3, "not written yet");

  const done = await resolvePending({ userId: EWA, history: res.messages, pendingId: res.pending.id, approved: true });
  assert.match(done.reply ?? "", /Done — booked Ola/);
  const ola = (await getBookings(EWA)).find((b) => b.clientName === "Ola");
  assert.equal(ola?.start, `${tomorrow()} 14:00`);
  assert.equal(ola?.end, `${tomorrow()} 15:00`);
  assert.ok((await getClients()).some((c) => c.name === "Ola"), "new client row created");
  // The tool result is added to the transcript so the AI knows what happened.
  assert.deepEqual(done.messages.at(-2), { role: "tool", tool_call_id: "call_create_booking", content: JSON.stringify({ ok: true, booking: ola }) });
});

test("change it to 4pm: AI looks the booking up first, then updates after approval", async () => {
  const created = await runAgent({
    userId: EWA, history: [], text: "Create a booking for 2pm tomorrow for Ola",
    provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]),
  });
  const approved = await resolvePending({ userId: EWA, history: created.messages, pendingId: created.pending!.id, approved: true });
  const olaId = (await getBookings(EWA, { clientName: "Ola" }))[0].id;

  const provider = fakeProvider([
    toolCall("get_bookings", { client_name: "Ola" }),
    toolCall("update_booking", { booking_id: olaId, start: `${tomorrow()} 16:00` }),
  ]);
  const res = await runAgent({ userId: EWA, history: approved.messages, text: "Change it to 4pm", provider });
  assert.deepEqual(res.events.map((e) => e.tool), ["get_bookings", "update_booking"]);
  // The model received the real get_bookings result before deciding.
  const lookup = JSON.parse((provider.requests[1].at(-1) as { content: string }).content);
  assert.equal(lookup.bookings[0].id, olaId);
  assert.match(res.pending!.summary, /Change booking #\d+: Ola, .* 14:00–15:00  →  Ola, .* 16:00–17:00/);

  await resolvePending({ userId: EWA, history: res.messages, pendingId: res.pending!.id, approved: true });
  const ola = (await getBookings(EWA, { clientName: "Ola" }))[0];
  assert.equal(ola.start, `${tomorrow()} 16:00`);
  assert.equal(ola.end, `${tomorrow()} 17:00`, "duration kept");
});

test("rejecting a change leaves the database untouched", async () => {
  const res = await runAgent({
    userId: EWA, history: [], text: "book Ola at 2pm tomorrow",
    provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 14:00` })]),
  });
  const done = await resolvePending({ userId: EWA, history: res.messages, pendingId: res.pending!.id, approved: false });
  assert.match(done.reply ?? "", /didn't change anything/);
  assert.equal((await getBookings(EWA)).length, 3);
});

test("get all bookings returns the user's bookings to the AI", async () => {
  const provider = fakeProvider([toolCall("get_bookings", {}), text("Here are your bookings.")]);
  const res = await runAgent({ userId: EWA, history: [], text: "Get all bookings", provider });
  assert.equal(res.pending, null);
  assert.equal(res.reply, "Here are your bookings.");
  const result = JSON.parse((provider.requests[1].at(-1) as { content: string }).content);
  assert.deepEqual(result.bookings.map((b: { client: string }) => b.client), ["Anna", "Marta", "Julia"]);
});

test("simple checks: overlapping or past bookings are refused and the AI is told why", async () => {
  const provider = fakeProvider([
    toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 15:30` }),
    text("That time clashes with Julia's booking."),
  ]);
  const res = await runAgent({ userId: EWA, history: [], text: "book Ola at 3:30pm tomorrow", provider });
  assert.equal(res.pending, null);
  assert.match(res.events[0].error ?? "", /overlaps an existing booking \(#\d+ Julia 15:00–16:00\)/);

  const past = fakeProvider([toolCall("create_booking", { client_name: "Ola", start: "2020-01-01 10:00" }), text("That's in the past.")]);
  const res2 = await runAgent({ userId: EWA, history: [], text: "book Ola on 1 Jan 2020", provider: past });
  assert.match(res2.events[0].error ?? "", /in the past/);
  assert.equal((await getBookings(EWA)).length, 3);
});

test("a user can't update another user's booking", async () => {
  const kasiaBooking = (await getBookings(2))[0];
  const provider = fakeProvider([toolCall("update_booking", { booking_id: kasiaBooking.id, start: `${tomorrow()} 18:00` }), text("Not found.")]);
  const res = await runAgent({ userId: EWA, history: [], text: "move booking to 6pm", provider });
  assert.match(res.events[0].error ?? "", /doesn't exist for this user/);
});

test("approval is re-checked: a clash created after the proposal stops the write", async () => {
  const res = await runAgent({
    userId: EWA, history: [], text: "book Ola at 5pm tomorrow",
    provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 17:00` })]),
  });
  await pool.query(
    `insert into bookings (user_id, client_id, start_at, end_at)
     values (1, 1, $1::timestamptz, $1::timestamptz + interval '30 minutes')`,
    [now().plus({ days: 1 }).set({ hour: 17, minute: 15, second: 0, millisecond: 0 }).toISO()],
  );
  const done = await resolvePending({ userId: EWA, history: res.messages, pendingId: res.pending!.id, approved: true });
  assert.match(done.reply ?? "", /couldn't make that change: That overlaps/);
});

test("approval cards and replies say which day it is relative to today", async () => {
  const provider = fakeProvider([toolCall("create_booking", { client_name: "Emily", start: `${now().plus({ days: 2 }).toFormat("yyyy-MM-dd")} 17:00` })]);
  const res = await runAgent({ userId: EWA, history: [], text: "book Emily in 2 days at 5pm", provider });
  assert.match(res.pending!.summary, /Emily, \w{3} \d{1,2} \w{3} \(in 2 days\), 17:00–18:00/);

  const lookup = fakeProvider([toolCall("get_bookings", {}), text("ok")]);
  await runAgent({ userId: EWA, history: [], text: "bookings?", provider: lookup });
  const result = JSON.parse((lookup.requests[1].at(-1) as { content: string }).content);
  assert.match(result.bookings[0].day, /\(tomorrow\)$/);
});

test("cancel booking: needs approval, keeps the row as cancelled, frees the slot", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  const provider = fakeProvider([toolCall("get_bookings", { client_name: "Julia" }), toolCall("cancel_booking", { booking_id: julia.id })]);
  const res = await runAgent({ userId: EWA, history: [], text: "Cancel Julia's booking", provider });
  assert.match(res.pending!.summary, /^Cancel booking #\d+: Julia \(Manicure\), .*\(tomorrow\), 15:00–16:00$/);
  assert.equal((await getBookings(EWA)).length, 3, "not cancelled before approval");

  const done = await resolvePending({ userId: EWA, history: res.messages, pendingId: res.pending!.id, approved: true });
  assert.match(done.reply ?? "", /Done — cancelled booking #\d+ \(Julia/);
  assert.deepEqual((await getBookings(EWA)).map((b) => b.clientName), ["Anna", "Marta"], "hidden from default list");
  const all = await getBookings(EWA, { includeCancelled: true });
  assert.equal(all.find((b) => b.id === julia.id)?.status, "cancelled", "row kept for history");
  assert.equal((await getClients()).find((c) => c.name === "Julia")?.bookingCount, 0);

  // The freed slot can be booked again.
  const rebook = await runAgent({
    userId: EWA, history: [], text: "book Ola at 3pm tomorrow",
    provider: fakeProvider([toolCall("create_booking", { client_name: "Ola", start: `${tomorrow()} 15:00` })]),
  });
  assert.ok(rebook.pending, "no overlap with a cancelled booking");
});

test("cancel checks: already cancelled, other user's booking, and changing a cancelled booking", async () => {
  const julia = (await getBookings(EWA, { clientName: "Julia" }))[0];
  await pool.query("update bookings set status = 'cancelled' where id = $1", [julia.id]);
  const kasia = (await getBookings(2))[0];

  const again = await runAgent({ userId: EWA, history: [], text: "cancel julia", provider: fakeProvider([toolCall("cancel_booking", { booking_id: julia.id }), text("x")]) });
  assert.match(again.events[0].error ?? "", /already cancelled/);
  const other = await runAgent({ userId: EWA, history: [], text: "cancel", provider: fakeProvider([toolCall("cancel_booking", { booking_id: kasia.id }), text("x")]) });
  assert.match(other.events[0].error ?? "", /doesn't exist for this user/);
  const move = await runAgent({
    userId: EWA, history: [], text: "move julia",
    provider: fakeProvider([toolCall("update_booking", { booking_id: julia.id, start: `${tomorrow()} 18:00` }), text("x")]),
  });
  assert.match(move.events[0].error ?? "", /is cancelled, so it can't be changed/);
});
