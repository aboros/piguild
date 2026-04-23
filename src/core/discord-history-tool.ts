import type { Client, Message } from "discord.js";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { DiscordFetchContext } from "./discord-fetch-context.js";

const MAX_MESSAGES_PER_CALL = 100;
const DEFAULT_LIMIT = 40;
const MAX_PAGES = 10;
const MAX_BODY_CHARS = 500;

function clampLimit(value: number | undefined): number {
  const n = value ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(n, MAX_MESSAGES_PER_CALL));
}

function parseIso(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${name}: expected ISO 8601 date string.`);
  }
  return ms;
}

function formatMessageLine(message: Message): string {
  const ts = new Date(message.createdTimestamp).toISOString();
  const author = message.author?.tag ?? message.author?.username ?? "unknown";
  let body = message.cleanContent?.trim() ?? "";
  if (!body && message.attachments.size > 0) {
    body = `[${message.attachments.size} attachment(s)]`;
  }
  if (!body && message.embeds.length > 0) {
    body = `[${message.embeds.length} embed(s)]`;
  }
  if (!body) {
    body = "(no text content)";
  }
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
  }
  return `[${ts}] ${author}: ${body}`;
}

export function createDiscordChannelHistoryTool(
  client: Client,
  ctx: DiscordFetchContext,
): ToolDefinition {
  return {
    name: "discord_fetch_channel_history",
    label: "Discord history",
    description:
      "Fetch older messages from the current Discord channel or thread (same context as this session). " +
      "Only the current channel is accessible; there is no channel id parameter. " +
      "Optional since_iso and until_iso filter by message time (inclusive, ISO 8601). " +
      "Use before_message_id to page backward after a previous call (snowflake of the oldest message you already have).",
    promptSnippet: "discord_fetch_channel_history (current channel only)",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: `Max messages to return (default ${DEFAULT_LIMIT}, max ${MAX_MESSAGES_PER_CALL})`,
          minimum: 1,
          maximum: MAX_MESSAGES_PER_CALL,
        }),
      ),
      before_message_id: Type.Optional(
        Type.String({ description: "Fetch messages older than this snowflake (pagination)." }),
      ),
      since_iso: Type.Optional(
        Type.String({
          description: "Include only messages at or after this instant (ISO 8601, inclusive).",
        }),
      ),
      until_iso: Type.Optional(
        Type.String({
          description: "Include only messages at or before this instant (ISO 8601, inclusive).",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        limit?: number;
        before_message_id?: string;
        since_iso?: string;
        until_iso?: string;
      },
      signal: AbortSignal | undefined,
      _onUpdate,
      _ext: ExtensionContext,
    ) => {
      const targetLimit = clampLimit(params.limit);
      const sinceMs = parseIso("since_iso", params.since_iso);
      const untilMs = parseIso("until_iso", params.until_iso);

      const channel = await client.channels.fetch(ctx.channelId);
      if (!channel?.isTextBased()) {
        throw new Error("Channel not found or is not text-based.");
      }

      const rows: Message[] = [];
      let fetchBefore: string | undefined = params.before_message_id;

      for (let page = 0; page < MAX_PAGES && rows.length < targetLimit; page++) {
        if (signal?.aborted) {
          throw new Error("Aborted.");
        }

        const pageLimit = 100;
        const fetchOpts: { limit: number; before?: string } = { limit: pageLimit };
        if (fetchBefore) {
          fetchOpts.before = fetchBefore;
        } else if (page === 0 && ctx.anchorMessageId && !params.before_message_id) {
          fetchOpts.before = ctx.anchorMessageId;
        }

        const batch = await channel.messages.fetch(fetchOpts);

        if (batch.size === 0) {
          break;
        }

        const ordered = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        if (sinceMs !== undefined && ordered.every((m) => m.createdTimestamp < sinceMs)) {
          break;
        }

        for (const message of ordered) {
          if (sinceMs !== undefined && message.createdTimestamp < sinceMs) {
            continue;
          }
          if (untilMs !== undefined && message.createdTimestamp > untilMs) {
            continue;
          }
          rows.push(message);
          if (rows.length >= targetLimit) {
            break;
          }
        }

        const oldest = ordered.reduce((a, b) => (a.createdTimestamp < b.createdTimestamp ? a : b));
        fetchBefore = oldest.id;

        if (batch.size < pageLimit) {
          break;
        }
        if (rows.length >= targetLimit) {
          break;
        }
      }

      rows.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const text = rows.map(formatMessageLine).join("\n") || "(no messages matched)";

      return {
        content: [{ type: "text", text }],
        details: {
          messageCount: rows.length,
          channelId: ctx.channelId,
        },
      };
    },
  } satisfies ToolDefinition;
}
