import { describe, expect, it } from "vitest";
import { resolveDiscordFetchContext, type DiscordFetchContext } from "./discord-fetch-context.js";

describe("resolveDiscordFetchContext", () => {
  it("returns explicit context when provided", () => {
    const explicit: DiscordFetchContext = {
      channelId: "111",
      guildId: "222",
      anchorMessageId: "333",
    };
    expect(resolveDiscordFetchContext("piguild:dm:user", explicit)).toEqual(explicit);
  });

  it("parses thread conversation keys", () => {
    expect(resolveDiscordFetchContext("piguild:999888777:thread:123456789")).toEqual({
      channelId: "123456789",
      guildId: "999888777",
    });
  });

  it("returns undefined for DM keys without explicit", () => {
    expect(resolveDiscordFetchContext("piguild:dm:424242")).toBeUndefined();
  });

  it("returns undefined for oneshot keys without explicit", () => {
    expect(resolveDiscordFetchContext("piguild:oneshot:abc")).toBeUndefined();
  });
});
