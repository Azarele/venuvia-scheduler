import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, TOMORROW } from "./helpers.js";

test("seed data uses real ISO timestamps for tomorrow in local time", () => {
  const { store } = setup();
  assert.equal(store.appointments[0].startAt, `${TOMORROW}T10:00:00+01:00`);
  assert.equal(store.blocks[0].reason, "Lunch break");
});

test("happy path: block, confirm with 'yes', schedule updated", async () => {
  const { say, schedule } = setup();
  const proposal = await say("Block tomorrow from 5 PM to 6 PM so nobody can book me");
  assert.match(proposal.text, /I'll block tomorrow, Monday, November 2, from 17:00 to 18:00/);
  assert.ok(proposal.proposal);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1, "nothing changes before confirmation");

  const done = await say("Yes");
  assert.match(done.text, /^Done!/);
  const blocks = schedule.getDay(TOMORROW).blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].startAt, `${TOMORROW}T17:00:00+01:00`);
});

test("declining a proposal changes nothing", async () => {
  const { say, schedule } = setup();
  await say("Block tomorrow 5pm-6pm");
  const res = await say("no");
  assert.match(res.text, /haven't changed anything/);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1);
});

test("conflict: blocking 14-16 over Julia's 15:00 appointment is detected, not applied", async () => {
  const { say, schedule } = setup();
  const res = await say("Block tomorrow from 2 PM to 4 PM");
  assert.match(res.text, /overlaps a confirmed appointment/);
  assert.match(res.text, /Julia/);
  assert.deepEqual(res.proposal.options.map((o) => o.id), ["block_free", "block_and_cancel", "abort"]);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1);

  // A bare "yes" is ambiguous here, so the assistant asks again instead of guessing.
  const again = await say("yes");
  assert.match(again.text, /pick one of the options/);
  assert.equal(schedule.getAppointment("apt_003").status, "confirmed");
});

test("conflict option 1 blocks only the free part and keeps the appointment", async () => {
  const { say, choose, schedule } = setup();
  const res = await say("Block tomorrow from 2 PM to 4 PM");
  const done = choose(res, "block_free");
  assert.match(done.text, /Blocked 14:00–15:00/);
  assert.equal(schedule.getAppointment("apt_003").status, "confirmed");
  const added = schedule.getDay(TOMORROW).blocks.at(-1);
  assert.equal(added.startAt, `${TOMORROW}T14:00:00+01:00`);
  assert.equal(added.endAt, `${TOMORROW}T15:00:00+01:00`);
});

test("conflict option 2 cancels the appointment only when explicitly chosen", async () => {
  const { say, schedule } = setup();
  await say("Block tomorrow from 2 PM to 4 PM");
  const done = await say("2");
  assert.match(done.text, /Cancelled Julia's Manicure/);
  assert.equal(schedule.getAppointment("apt_003").status, "cancelled");
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 2);
});

test("confirmation re-validates: a conflict created after the proposal blocks execution", async () => {
  const { say, store, schedule } = setup();
  await say("Block tomorrow 5pm to 6pm");
  store.appointments.push({ ...store.appointments[0], id: "apt_999", clientName: "Ola", startAt: `${TOMORROW}T17:15:00+01:00`, endAt: `${TOMORROW}T17:45:00+01:00` });
  const res = await say("yes");
  assert.match(res.text, /schedule changed/);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1);
});

test("reschedule my 3 PM appointment to 4 PM", async () => {
  const { say, schedule } = setup();
  const res = await say("Reschedule my 3 PM appointment to 4 PM");
  assert.match(res.text, /move Julia's Manicure \(tomorrow, Monday, November 2\) from 15:00–16:00 to 16:00–17:00/);
  await say("yes");
  const julia = schedule.getAppointment("apt_003");
  assert.equal(julia.startAt, `${TOMORROW}T16:00:00+01:00`);
  assert.equal(julia.endAt, `${TOMORROW}T17:00:00+01:00`);
});

test("reschedule into an occupied slot is refused with suggestions, then a follow-up time works", async () => {
  const { say, schedule } = setup();
  const res = await say("Move Anna to 11:30");
  assert.equal(res.proposal, null);
  assert.match(res.text, /overlap Marta's Coloring/);
  assert.match(res.text, /Free slots that day/);
  const follow = await say("13:30");
  assert.match(follow.text, /move Anna's Haircut \(tomorrow, Monday, November 2\) from 10:00–10:45 to 13:30–14:15/);
  await say("yes");
  assert.equal(schedule.getAppointment("apt_001").startAt, `${TOMORROW}T13:30:00+01:00`);
});

test("invalid dates, past times and reversed ranges are rejected", async () => {
  const { say } = setup();
  assert.match((await say("Block February 30 from 2pm to 4pm")).text, /isn't a valid date/);
  assert.match((await say("Block yesterday from 2pm to 4pm")).text, /in the past/);
  assert.match((await say("Block tomorrow from 4 PM to 2 PM")).text, /end time must be after the start/);
});

test("ambiguous requests trigger a clarifying question and the answer is merged", async () => {
  const { say } = setup();
  assert.match((await say("Block tomorrow afternoon")).text, /What exact times/);
  const q = await say("Block 5 to 6 pm");
  assert.match(q.text, /Which day/);
  const res = await say("tomorrow");
  assert.match(res.text, /I'll block tomorrow, Monday, November 2, from 17:00 to 18:00/);
});

test("ambiguous appointment reference asks which one", async () => {
  const { say } = setup();
  const res = await say("Cancel my appointment");
  assert.match(res.text, /which one should I cancel/);
  const follow = await say("Anna's");
  assert.match(follow.text, /I'll cancel Anna's Haircut/);
});

test("show schedule lists appointments and blocks in order", async () => {
  const { say } = setup();
  const res = await say("Show me my appointments for tomorrow");
  assert.equal(res.focusDate, TOMORROW);
  const lines = res.text.split("\n").slice(1);
  assert.deepEqual(lines, [
    "• 10:00–10:45 Anna — Haircut",
    "• 11:00–13:00 Marta — Coloring",
    "• 13:00–13:30 Blocked (Lunch break)",
    "• 15:00–16:00 Julia — Manicure",
  ]);
});

test("a new request while one is pending drops the old one without executing it", async () => {
  const { say, schedule } = setup();
  await say("Block tomorrow 5pm to 6pm");
  const res = await say("show tomorrow");
  assert.match(res.text, /set aside the previous unconfirmed request/);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1);
});

test("removing the lunch block", async () => {
  const { say, schedule } = setup();
  const res = await say("Remove the lunch break block tomorrow");
  assert.match(res.text, /remove the blocked period/);
  await say("yes");
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 0);
});

test("unknown input gets help text", async () => {
  const { say } = setup();
  assert.match((await say("what's the weather like?")).text, /I can block time/);
});

test("LLM tool calls go through the same validation (fake Claude client)", async () => {
  const { createLlmInterpreter } = await import("../src/interpreter/llm.js");
  const calls = [];
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: "propose_block_time", input: { date: TOMORROW, startTime: "14:00", endTime: "16:00", reason: null } }],
          };
        },
      },
    },
  };
  const { say, schedule } = setup({ interpreter: createLlmInterpreter({ client }) });
  const res = await say("Block tomorrow from 2 PM to 4 PM so nobody can book");
  assert.match(res.text, /overlaps a confirmed appointment/);
  assert.equal(schedule.getDay(TOMORROW).blocks.length, 1);
  assert.match(calls[0].system, /apt_003: Mon 2026-11-02 15:00–16:00 Julia \(Manicure\)/);
});
