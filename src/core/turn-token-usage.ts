import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Aggregated provider-reported usage for the current user turn (since last user message). */
export interface TurnTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Sum `usage` from every assistant message after the last `user` message.
 * Used for billing-style totals across multi-step tool loops in one Discord turn.
 *
 * @returns `null` if there is no user message in the list; otherwise sums (possibly zero).
 */
export function sumUsageSinceLastUserMessage(messages: readonly AgentMessage[]): TurnTokenUsage | null {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return null;
  }
  return sumUsageAfterUserMessageAtIndex(messages, lastUserIndex);
}

/**
 * Sum provider `usage` for every `assistant` message after the user message at `userMessageIndex`.
 * Callers should pass the index where the **current** turn's user message will be (or is): e.g.
 * `handle.session.messages.length` captured immediately before `session.prompt()`, so usage is
 * correct for this Discord reply even when prior turns exist in the session.
 *
 * @returns `null` if `userMessageIndex` is out of range or that entry is not a `user` message.
 */
export function sumUsageAfterUserMessageAtIndex(
  messages: readonly AgentMessage[],
  userMessageIndex: number,
): TurnTokenUsage | null {
  if (userMessageIndex < 0 || userMessageIndex >= messages.length) {
    return null;
  }
  if (messages[userMessageIndex]!.role !== "user") {
    return null;
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (let i = userMessageIndex + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    input += m.usage.input;
    output += m.usage.output;
    cacheRead += m.usage.cacheRead;
    cacheWrite += m.usage.cacheWrite;
  }

  return { input, output, cacheRead, cacheWrite };
}
