// Token usage and cost per message. Prices are USD per million tokens (input, output).
// Claude list prices are built in; for other models set AI_PRICE_INPUT / AI_PRICE_OUTPUT.
// Gemini's free tier costs nothing, so its cost shows as unknown unless prices are set.

export type Usage = { inputTokens: number; outputTokens: number };
export type TurnUsage = Usage & { calls: number; model: string; costUsd: number | null };

const LIST_PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function priceFor(model: string): [number, number] | null {
  const input = Number(process.env.AI_PRICE_INPUT);
  const output = Number(process.env.AI_PRICE_OUTPUT);
  if (input >= 0 && output >= 0 && process.env.AI_PRICE_INPUT && process.env.AI_PRICE_OUTPUT) return [input, output];
  return LIST_PRICES[model] ?? null;
}

export function addUsage(total: TurnUsage, usage: Usage | undefined): TurnUsage {
  const next = {
    ...total,
    calls: total.calls + 1,
    inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
  };
  const price = priceFor(total.model);
  next.costUsd = price ? (next.inputTokens * price[0] + next.outputTokens * price[1]) / 1_000_000 : null;
  return next;
}

export function formatUsage(u: TurnUsage): string {
  const tokens = `${u.inputTokens.toLocaleString("en-US")} in / ${u.outputTokens.toLocaleString("en-US")} out tokens`;
  const cost = u.costUsd == null ? "cost n/a" : `$${u.costUsd.toFixed(u.costUsd < 0.01 ? 5 : 3)}`;
  return `${u.calls} AI call${u.calls === 1 ? "" : "s"} · ${tokens} · ${cost}`;
}
