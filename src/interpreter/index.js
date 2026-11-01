// Picks the interpreter: Claude when ANTHROPIC_API_KEY is set (and AI_MODE isn't "mock"),
// otherwise the rule-based mock. If a Claude call fails, we fall back to the mock for that
// message so the owner still gets an answer.
import { createLlmInterpreter } from "./llm.js";
import { interpretMock } from "./mock.js";

export function createMockInterpreter() {
  return {
    name: "mock",
    async interpret({ text, context }) {
      return interpretMock(text, context);
    },
  };
}

export function createInterpreter({ env = process.env, logger = console } = {}) {
  const mock = createMockInterpreter();
  if (env.AI_MODE === "mock" || !env.ANTHROPIC_API_KEY) return mock;

  const llm = createLlmInterpreter();
  return {
    name: "claude",
    model: llm.model,
    async interpret(args) {
      try {
        return { ...(await llm.interpret(args)), interpreter: "claude" };
      } catch (error) {
        logger.error(`[interpreter] Claude call failed, using mock parser: ${error.message}`);
        return { ...(await mock.interpret(args)), interpreter: "mock (fallback)" };
      }
    },
  };
}
