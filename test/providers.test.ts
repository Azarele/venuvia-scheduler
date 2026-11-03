// The OpenAI-compatible adapter (Gemini / OpenRouter) against a local fake server:
// a hung request must time out with a clear error, and an overloaded one is retried once.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { openAICompatible, ProviderError } from "../src/lib/ai/providers.ts";

let server: Server;
let baseUrl: string;
let mode: "hang" | "overloaded-once" | "ok" = "ok";
let hits = 0;

const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] });

before(async () => {
  server = createServer((req, res) => {
    hits++;
    req.resume();
    if (mode === "hang") return; // never answer
    if (mode === "overloaded-once" && hits === 1) {
      res.writeHead(503).end('{"error":"overloaded"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(OK_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const provider = () => openAICompatible({ name: "FakeAI", baseUrl, apiKey: "x", model: "m" });
const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("a request that never answers fails with a clear timeout error", async () => {
  process.env.AI_TIMEOUT_MS = "300";
  mode = "hang";
  const started = Date.now();
  await assert.rejects(provider().complete(request), (e) => e instanceof ProviderError && /didn't respond within 0.3s/.test(e.message));
  assert.ok(Date.now() - started < 3000, "gave up quickly instead of hanging");
});

test("an overloaded (503) response is retried once and then succeeds", async () => {
  process.env.AI_TIMEOUT_MS = "5000";
  mode = "overloaded-once";
  hits = 0;
  const reply = await provider().complete(request);
  assert.equal(reply.content, "hello");
  assert.equal(hits, 2);
});
