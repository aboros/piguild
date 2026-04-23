import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { sumUsageAfterUserMessageAtIndex, sumUsageSinceLastUserMessage } from "./turn-token-usage.js";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-chat",
    provider: "openai",
    model: "gpt-4",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "1",
    toolName: "read",
    content: [{ type: "text", text: "x" }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("sumUsageSinceLastUserMessage", () => {
  it("returns null when there is no user message", () => {
    expect(sumUsageSinceLastUserMessage([assistant({ input: 1, output: 2 })])).toBeNull();
  });

  it("returns zeros when there is only a user message", () => {
    expect(sumUsageSinceLastUserMessage([user("hi")])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("sums a single assistant after the last user", () => {
    const messages = [user("hi"), assistant({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1 })];
    expect(sumUsageSinceLastUserMessage(messages)).toEqual({
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 1,
    });
  });

  it("sums multiple assistant messages after the last user (tool loop)", () => {
    const messages = [
      user("go"),
      assistant({ input: 50, output: 10 }),
      toolResult(),
      assistant({ input: 200, output: 5 }),
    ];
    expect(sumUsageSinceLastUserMessage(messages)).toEqual({
      input: 250,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("only counts assistants after the last user when history exists", () => {
    const messages = [
      user("old"),
      assistant({ input: 999, output: 999 }),
      user("new"),
      assistant({ input: 10, output: 2 }),
    ];
    expect(sumUsageSinceLastUserMessage(messages)).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("sumUsageAfterUserMessageAtIndex", () => {
  it("returns null when index is out of range or not a user message", () => {
    expect(sumUsageAfterUserMessageAtIndex([user("a")], 1)).toBeNull();
    expect(sumUsageAfterUserMessageAtIndex([assistant({ input: 1, output: 1 })], 0)).toBeNull();
  });

  it("returns null for the index equal to length before prompt (user not appended yet)", () => {
    const messages = [user("prior"), assistant({ input: 1, output: 1 })];
    const indexBeforeNewUser = messages.length;
    expect(sumUsageAfterUserMessageAtIndex(messages, indexBeforeNewUser)).toBeNull();
  });

  it("sums only assistants after the user at the given index", () => {
    const messages = [
      user("prior"),
      assistant({ input: 1, output: 1 }),
      user("current"),
      assistant({ input: 100, output: 20 }),
      toolResult(),
      assistant({ input: 50, output: 5 }),
    ];
    expect(sumUsageAfterUserMessageAtIndex(messages, 2)).toEqual({
      input: 150,
      output: 25,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
