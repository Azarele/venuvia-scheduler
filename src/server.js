import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DateTime } from "luxon";
import { Assistant } from "./assistant.js";
import { createInterpreter } from "./interpreter/index.js";
import { ScheduleService } from "./scheduling.js";
import { createStore } from "./store.js";
import { BUSINESS, isValidDate } from "./time.js";

export function createApp({ interpreter = createInterpreter(), now = () => DateTime.now() } = {}) {
  const schedule = new ScheduleService({ store: createStore({ now: now() }), now });
  const assistant = new Assistant({ schedule, interpreter });
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public")));

  const sessionId = (req) => String(req.body?.sessionId || "default").slice(0, 64);

  app.get("/api/info", (_req, res) => {
    res.json({
      business: BUSINESS,
      today: schedule.now().toISODate(),
      interpreter: interpreter.name,
      model: interpreter.model ?? null,
    });
  });

  app.get("/api/schedule", (req, res) => {
    const date = req.query.date ?? schedule.now().toISODate();
    if (!isValidDate(date)) return res.status(400).json({ error: "date must be a valid YYYY-MM-DD date" });
    res.json(schedule.getDay(date));
  });

  app.post("/api/chat", async (req, res, next) => {
    try {
      res.json(await assistant.handleMessage(sessionId(req), req.body?.message));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/confirm", (req, res) => {
    const { proposalId, optionId } = req.body ?? {};
    res.json(assistant.confirm(sessionId(req), proposalId, optionId));
  });

  app.post("/api/reset", (_req, res) => {
    Object.assign(schedule.store, createStore({ now: now() }));
    assistant.reset();
    res.json({ ok: true });
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ text: "Sorry, something went wrong on my side. Nothing was changed.", proposal: null });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    const mode = process.env.ANTHROPIC_API_KEY && process.env.AI_MODE !== "mock" ? "Claude" : "mock parser (no ANTHROPIC_API_KEY)";
    console.log(`Studio Nova assistant running at http://localhost:${port} — interpreter: ${mode}`);
    console.log("Data is in memory and resets when the server restarts.");
  });
}
