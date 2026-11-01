import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretMock, parseDate, parseTimes } from "../src/interpreter/mock.js";
import { NOW, TOMORROW } from "./helpers.js";

const ctx = { now: NOW, clientNames: ["Anna", "Marta", "Julia"] };
const minutes = (text) => parseTimes(text).map((t) => t.minutes / 60);

test("parses common time formats", () => {
  assert.deepEqual(minutes("from 2 pm to 4 pm"), [14, 16]);
  assert.deepEqual(minutes("2-4pm"), [14, 16]);
  assert.deepEqual(minutes("14:00 - 16:30"), [14, 16.5]);
  assert.deepEqual(minutes("11 to 1pm"), [11, 13]);
  assert.deepEqual(minutes("at noon"), [12]);
  assert.deepEqual(minutes("10am until 11:15am"), [10, 11.25]);
});

test("parses relative and absolute dates", () => {
  assert.equal(parseDate("tomorrow", NOW).date, TOMORROW);
  assert.equal(parseDate("on friday", NOW).date, "2026-11-06");
  assert.equal(parseDate("sunday", NOW).date, "2026-11-08"); // today is Sunday -> next one
  assert.equal(parseDate("nov 5th", NOW).date, "2026-11-05");
  assert.equal(parseDate("5 march", NOW).date, "2027-03-05");
  assert.equal(parseDate("february 30", NOW).date, "2027-02-30"); // passed through; backend rejects
});

test("interprets the three example requests", () => {
  assert.deepEqual(interpretMock("Block tomorrow from 2 PM to 4 PM so nobody can book me", ctx), {
    type: "block_time", date: TOMORROW, startTime: "14:00", endTime: "16:00", reason: null, assumedPm: false,
  });
  assert.deepEqual(interpretMock("Reschedule my 3 PM appointment to 4 PM", ctx), {
    type: "reschedule",
    target: { date: null, time: "15:00", appointmentId: null, clientName: null },
    newDate: null,
    newTime: "16:00",
  });
  assert.deepEqual(interpretMock("Show me my appointments for tomorrow", ctx), { type: "show_schedule", date: TOMORROW });
});

test("duration and all-day blocks", () => {
  const r = interpretMock("block friday at 10am for 2 hours", ctx);
  assert.equal(r.startTime, "10:00");
  assert.equal(r.endTime, "12:00");
  const d = interpretMock("take tomorrow off, whole day", ctx);
  assert.equal(d.startTime, "09:00");
  assert.equal(d.endTime, "19:00");
});
