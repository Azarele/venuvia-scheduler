// AI providers behind one small interface. The conversation is stored in the
// OpenAI chat format (which Gemini and OpenRouter both speak); the Claude adapter
// converts to and from Anthropic's format. Switching provider = changing AI_PROVIDER.
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "./pricing.ts";
import type { ToolDef } from "./tools.ts";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [extra: string]: unknown; // e.g. Gemini's thought signatures, sent back untouched
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  /** Claude's raw content blocks, replayed verbatim on the next request. */
  anthropicContent?: unknown[];
  /** Tokens this request used (not stored in the conversation). */
  usage?: Usage;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export type CompletionRequest = { system: string; messages: ChatMessage[]; tools: ToolDef[] };

export interface Provider {
  name: string;
  model: string;
  complete(request: CompletionRequest): Promise<AssistantMessage>;
}

export class ProviderError extends Error {}

export function getProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const which = (env.AI_PROVIDER ?? "gemini").toLowerCase();
  if (which === "gemini")
    return openAICompatible({
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: required(env.GEMINI_API_KEY, "GEMINI_API_KEY", "https://aistudio.google.com/apikey"),
      model: env.GEMINI_MODEL || "gemini-flash-latest",
    });
  if (which === "openrouter")
    return openAICompatible({
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY", "https://openrouter.ai/keys"),
      model: env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
      headers: { "X-Title": "Studio Nova booking assistant" },
    });
  if (which === "anthropic" || which === "claude")
    return anthropic({
      apiKey: required(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY", "https://console.anthropic.com"),
      model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    });
  if (which === "scripted") return scripted();
  throw new ProviderError(`Unknown AI_PROVIDER "${which}". Use gemini, openrouter or anthropic.`);
}

function required(value: string | undefined, name: string, where: string): string {
  if (!value) throw new ProviderError(`${name} is not set. Get a key at ${where}, put it in .env.local and restart the dev server.`);
  return value;
}

// ---------- Gemini / OpenRouter (OpenAI-compatible chat completions) ----------

/** How long one AI request may take before we give up (AI_TIMEOUT_MS, default 60s). */
const timeoutMs = () => Number(process.env.AI_TIMEOUT_MS) || 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function openAICompatible(opts: { name: string; baseUrl: string; apiKey: string; model: string; headers?: Record<string, string> }): Provider {
  /** One HTTP request with a timeout; retried once if the AI is overloaded (503) or rate-limited (429). */
  async function post(body: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
          body,
          signal: AbortSignal.timeout(timeoutMs()),
        });
      } catch (error) {
        const name = (error as Error).name;
        if (name === "TimeoutError" || name === "AbortError")
          throw new ProviderError(`${opts.name} didn't respond within ${timeoutMs() / 1000}s. It may be overloaded — try again in a moment.`);
        throw new ProviderError(`Couldn't reach ${opts.name}: ${(error as Error).message}`);
      }
      if ((res.status === 503 || res.status === 429) && attempt === 1) {
        await sleep(res.status === 429 ? 10_000 : 2_000);
        continue;
      }
      return res;
    }
  }

  return {
    name: opts.name,
    model: opts.model,
    async complete({ system, messages, tools }) {
      const res = await post(
        JSON.stringify({
          model: opts.model,
          messages: [{ role: "system", content: system }, ...messages.map(withoutPrivateFields)],
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: "auto",
        }),
      );
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        const hint =
          res.status === 429 ? " (free-tier rate limit — wait a minute and try again)" : res.status === 503 ? " (the model is overloaded — try again shortly)" : "";
        throw new ProviderError(`${opts.name} returned HTTP ${res.status}${hint}: ${body}`);
      }
      const data = await res.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new ProviderError(`${opts.name} returned no message: ${JSON.stringify(data).slice(0, 300)}`);
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call: ToolCall, i: number) => ({
        ...call,
        id: call.id || `call_${Date.now()}_${i}`,
        type: "function",
      }));
      // total - prompt also counts "thinking" tokens, which are billed as output.
      const u = data.usage;
      const usage = u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0) || (u.completion_tokens ?? 0) } : undefined;
      return { role: "assistant", content: message.content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage };
    },
  };
}

function withoutPrivateFields(message: ChatMessage) {
  if (message.role !== "assistant") return message;
  const { anthropicContent: _ignored, usage: _usage, ...rest } = message;
  return rest;
}

// ---------- Claude (production) ----------

function anthropic(opts: { apiKey: string; model: string }): Provider {
  // The SDK retries 429/5xx itself (2 retries by default); the timeout bounds each attempt.
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: timeoutMs() });
  return {
    name: "Claude",
    model: opts.model,
    async complete({ system, messages, tools }) {
      const params = {
        model: opts.model,
        max_tokens: 4096,
        system,
        // Picking a tool for a short chat turn: low effort keeps it fast.
        output_config: { effort: "low" },
        // If a safety classifier declines, the API retries on a suitable fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: toAnthropicMessages(messages),
      };
      // Cast: the fallback beta fields may be newer than the SDK's type definitions.
      const response = (await client.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
      if (response.stop_reason === "refusal") return { role: "assistant", content: "Sorry, I can't help with that request." };

      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      const toolCalls: ToolCall[] = response.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
      );
      return {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        anthropicContent: response.content,
        usage: {
          inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

function toAnthropicMessages(messages: ChatMessage[]) {
  type Block = Record<string, unknown>;
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.anthropicContent) push("assistant", m.anthropicContent as Block[]);
    else
      push("assistant", [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...(m.tool_calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") })),
      ]);
  }
  return out;
}

// ---------- Scripted (offline, no AI) ----------
// Only for testing the app without an API key: AI_PROVIDER=scripted. It handles
// the three demo requests with simple pattern matching — it is NOT an AI.

const simulatedFailures = new Set<string>();

function scripted(): Provider {
  const NAMES = ["Ola", "Zofia", "Maja", "Lena", "Hanna", "Nina"];
  const call = (name: string, args: unknown): AssistantMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const say = (content: string): AssistantMessage => ({ role: "assistant", content });
  const tomorrow = () => new Date(Date.now() + 86_400_000).toLocaleDateString("sv-SE", { timeZone: process.env.BUSINESS_TIMEZONE ?? "Europe/Warsaw" });
  const hourIn = (text: string) => {
    const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (!m[3] && h < 8) h += 12;
    return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
  };

  return {
    name: "Scripted demo (not AI)",
    model: "pattern matching",
    async complete({ messages }) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";
      const last = messages[messages.length - 1];
      const wantsChange = /\b(change|move|reschedule|update)\b/.test(lastUser);
      const wantsCancel = /\bcancel\b/.test(lastUser);

      // For testing the Retry button: the first time, pretend the AI timed out.
      if (lastUser.includes("simulate a timeout") && !simulatedFailures.has(lastUser)) {
        simulatedFailures.add(lastUser);
        throw new ProviderError("Scripted demo: simulated AI timeout (didn't respond within 60s). Click Retry.");
      }

      if (last.role === "tool") {
        const data = JSON.parse(last.content);
        if (data.error) return say(`I couldn't do that: ${data.error}`);
        if (data.bookings && wantsCancel && data.bookings.length) {
          const named = data.bookings.find((b: { client: string }) => lastUser.includes(b.client.toLowerCase()));
          const target = named ?? data.bookings.reduce((a: { id: number }, b: { id: number }) => (b.id > a.id ? b : a));
          return call("cancel_booking", { booking_id: target.id });
        }
        if (data.bookings && wantsChange && data.bookings.length) {
          const target = data.bookings.reduce((a: { id: number }, b: { id: number }) => (b.id > a.id ? b : a));
          const time = hourIn(lastUser.split(/\bto\b/).pop() ?? "");
          return call("update_booking", { booking_id: target.id, start: `${target.start.slice(0, 10)} ${time}` });
        }
        if (data.bookings)
          return say(
            data.bookings.length
              ? `Here are your bookings:\n${data.bookings.map((b: { id: number; client: string; start: string; end: string }) => `• #${b.id} ${b.client} — ${b.start}–${b.end.slice(11)}`).join("\n")}`
              : "You have no bookings.",
          );
        return say("Done.");
      }

      if (/\bundo\b/.test(lastUser)) return call("undo_last_change", {});
      if (wantsChange || wantsCancel) return call("get_bookings", {});
      if (/\b(book|create|add|make)\b/.test(lastUser)) {
        const time = hourIn(lastUser);
        if (!time) return say("What time should the booking be?");
        return call("create_booking", { client_name: NAMES[Math.floor(Math.random() * NAMES.length)], start: `${tomorrow()} ${time}` });
      }
      if (/\b(show|get|list|all|bookings)\b/.test(lastUser)) return call("get_bookings", {});
      return say("(Scripted demo) Try: “Create a booking for 2pm tomorrow under a random name”, “Change it to 4pm”, “Get all bookings”, or “Cancel Julia's booking”.");
    },
  };
}
