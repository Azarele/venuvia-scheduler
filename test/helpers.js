import { DateTime } from "luxon";
import { Assistant } from "../src/assistant.js";
import { createMockInterpreter } from "../src/interpreter/index.js";
import { ScheduleService } from "../src/scheduling.js";
import { createStore } from "../src/store.js";
import { BUSINESS } from "../src/time.js";

// Sunday 1 Nov 2026, 12:00 in Warsaw. "Tomorrow" is Monday 2 Nov.
export const NOW = DateTime.fromISO("2026-11-01T12:00", { zone: BUSINESS.timezone });
export const TOMORROW = "2026-11-02";

export function setup({ interpreter = createMockInterpreter() } = {}) {
  const store = createStore({ now: NOW });
  const schedule = new ScheduleService({ store, now: () => NOW });
  const assistant = new Assistant({ schedule, interpreter });
  const say = (text) => assistant.handleMessage("test", text);
  const choose = (res, optionId) => assistant.confirm("test", res.proposal.id, optionId);
  return { store, schedule, assistant, say, choose };
}
