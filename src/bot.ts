import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiguildRuntimeConfig } from "./config.js";
import { PiguildSessionPool } from "./session-pool.js";
import { PiguildRuntimeAdapter } from "./runtime-adapter.js";
import { buildPiguildCommands } from "./commands/registry.js";
import { handleChatInputCommand } from "./commands/handlers.js";
import { createLiveRendererFromDiscordChannel } from "./renderer/factory.js";
import { stripBotMention } from "./vendor/conversation.js";
import { buildPromptFromMessage, replyToMessage } from "./discord/message-helpers.js";
import { truncateErrorMessage } from "./discord/errors.js";
import { handleAccessButtonInteraction, isAccessRequestButton } from "./discord/access-button-handler.js";
import { canAccessDm, canAccessGuildMessage, getParentChannelId } from "./access.js";
import { buildWorkspaceKey } from "./workspace.js";
import { threadConversationKey, dmConversationKey } from "./conversation-keys.js";
import {
  parentChannelAllowed,
  routeGuildMention,
} from "./message-router.js";
import { RuntimeLock } from "./runtime-lock.js";

export function createPiguildClient(enableMessageContent = true): Client {
  return new Client({
    intents: enableMessageContent
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
}

function resolveLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

export async function startPiguildBot(options: {
  config: PiguildRuntimeConfig;
  pi: ExtensionAPI;
  cwd: string;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<{ client: Client; stop: () => Promise<void> }> {
  const { config, pi, notify } = options;

  const lockResult = RuntimeLock.acquire(resolveLockPath(config.statePath));
  if (!lockResult.acquired) {
    notify(lockResult.reason, "warning");
    return {
      client: createPiguildClient(false),
      stop: async () => undefined,
    };
  }
  const { lock } = lockResult;

  const ctx: { adapter?: PiguildRuntimeAdapter } = {};

  const notifyLiveUpdate = async (
    conversationKey: string,
    runId: number | undefined,
    update: import("./vendor/live-discord-renderer.js").PiLiveUpdate,
  ): Promise<void> => {
    await ctx.adapter?.notifyConversation(conversationKey, runId, update);
  };

  const notifyAccessRequest = async (conversationKey: string, content: string): Promise<void> => {
    await ctx.adapter?.notifyAccessRequest(conversationKey, content);
  };

  const pool = new PiguildSessionPool(config, notifyAccessRequest, notifyLiveUpdate);
  await pool.initialize();

  const adapter = new PiguildRuntimeAdapter(config, pool);
  ctx.adapter = adapter;

  const latestRunIds = new Map<string, number>();
  const nextRunId = (conversationKey: string): number => {
    const runId = (latestRunIds.get(conversationKey) ?? 0) + 1;
    latestRunIds.set(conversationKey, runId);
    return runId;
  };
  const isLatestRun = (conversationKey: string, runId: number): boolean =>
    latestRunIds.get(conversationKey) === runId;

  let client: Client | undefined;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.off("unhandledRejection", rejectionHandler);
    if (client) {
      await client.destroy().catch(() => undefined);
      client = undefined;
    }
    await pool.dispose();
    lock.release();
  };

  const registerSlash = async (discordClient: Client) => {
    if (!config.registerCommands || !discordClient.application) return;
    const skills = adapter.getSkillSummaries();
    const commands = buildPiguildCommands(skills);
    if (config.allowedGuildIds.length > 0) {
      await Promise.all(
        config.allowedGuildIds.map((guildId) => discordClient.application!.commands.set(commands, guildId)),
      );
      return;
    }
    await discordClient.application.commands.set(commands);
  };

  const rejectionHandler = (error: unknown) => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    notify(`unhandled: ${truncateErrorMessage(rawMessage)}`, "error");
  };
  process.on("unhandledRejection", rejectionHandler);

  const start = async (enableMessageContent: boolean) => {
    const createdClient = createPiguildClient(enableMessageContent);

    createdClient.once(Events.ClientReady, async () => {
      try {
        await registerSlash(createdClient);
      } catch (error) {
        notify(
          `slash registration failed: ${truncateErrorMessage(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
      }
      notify(
        `piguild connected as ${createdClient.user?.tag ?? "bot"} (${enableMessageContent ? "full" : "slash-only"})`,
        "info",
      );
    });

    createdClient.on(Events.InteractionCreate, async (interaction) => {
      if (!ctx.adapter) return;

      if (interaction.isButton()) {
        if (isAccessRequestButton(interaction.customId)) {
          try {
            await handleAccessButtonInteraction(interaction, ctx.adapter);
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            notify(`access button: ${truncateErrorMessage(text)}`, "error");
          }
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      try {
        await handleChatInputCommand(interaction, {
          config,
          adapter: ctx.adapter,
          pi,
          nextRunId,
          isLatestRun,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        notify(`interaction: ${truncateErrorMessage(text)}`, "error");
      }
    });

    if (enableMessageContent) {
      createdClient.on(Events.MessageCreate, async (message) => {
        try {
          await handleMessageCreate(message, {
            config,
            adapter: ctx.adapter!,
            client: createdClient,
            nextRunId,
            isLatestRun,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          notify(`message: ${truncateErrorMessage(text)}`, "error");
          await replyToMessage(message, `piguild error: ${truncateErrorMessage(text)}`).catch(() => undefined);
        }
      });
    }

    createdClient.on(Events.Error, (error) => {
      const text = error instanceof Error ? error.message : String(error);
      notify(`discord client: ${truncateErrorMessage(text)}`, "warning");
    });

    await createdClient.login(config.discordToken);
    pool.setDiscordClient(createdClient);
    client = createdClient;
  };

  try {
    await start(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Used disallowed intents")) {
      process.off("unhandledRejection", rejectionHandler);
      await cleanup();
      throw error;
    }
    notify("Message Content intent unavailable; slash-only mode.", "warning");
    if (client) {
      await client.destroy().catch(() => undefined);
      client = undefined;
    }
    await start(false);
  }

  return {
    client: client!,
    stop: cleanup,
  };
}

async function handleMessageCreate(
  message: Message,
  ctx: {
    config: PiguildRuntimeConfig;
    adapter: PiguildRuntimeAdapter;
    client: Client;
    nextRunId: (key: string) => number;
    isLatestRun: (key: string, runId: number) => boolean;
  },
): Promise<void> {
  const { config, adapter, client, nextRunId, isLatestRun } = ctx;

  if (message.author.bot) return;

  const promptText = message.content.trim();
  if (!promptText && message.attachments.size === 0) return;

  const botId = client.user?.id;
  if (!botId) return;

  if (!message.inGuild()) {
    const dm = canAccessDm(config, message.author.id);
    if (!dm.allowed) {
      await replyToMessage(message, dm.reason ?? "DM not allowed.");
      return;
    }

    const conversationKey = dmConversationKey(message.author.id);
    const workspaceKey = buildWorkspaceKey(null, message.channelId);

    if (adapter.isStreaming(conversationKey)) {
      await adapter.sealLiveRenderer(conversationKey);
      adapter.clearLiveRenderer(conversationKey);
      await adapter.abort(conversationKey).catch(() => false);
      await adapter.waitForRespondDone(conversationKey);
    }

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }

    const runId = nextRunId(conversationKey);
    const renderer = createLiveRendererFromDiscordChannel(config, message.channel);
    adapter.registerLiveRenderer(conversationKey, renderer, runId);
    try {
      const response = await adapter.respond({
        conversationKey,
        workspaceKey,
        sessionName: `dm-${message.author.username}`,
        promptText: buildPromptFromMessage(message, promptText),
        runId,
        discordFetchContext: {
          channelId: message.channel.id,
          anchorMessageId: message.id,
        },
      });
      if (!isLatestRun(conversationKey, runId)) return;
      await renderer.finalize(response);
    } finally {
      adapter.clearLiveRenderer(conversationKey, renderer);
    }
    return;
  }

  const access = await canAccessGuildMessage(config, message);
  if (!access.allowed) {
    await replyToMessage(message, access.reason ?? "Access denied.");
    return;
  }

  if (config.trigger.allowedChannelIds.length === 0) {
    return;
  }

  if (!parentChannelAllowed(config, message)) {
    return;
  }

  if (config.trigger.mention && !message.mentions.has(botId)) {
    return;
  }

  const stripped = stripBotMention(promptText, botId);
  if (config.trigger.mention && !stripped.trim()) {
    return;
  }

  const textBody = config.trigger.mention ? stripped.trim() : promptText;

  const routed = routeGuildMention(message);
  if (!routed) {
    return;
  }

  if (routed.kind === "thread_mention") {
    const conversationKey = threadConversationKey(routed.guildId, routed.threadId);
    const workspaceKey = buildWorkspaceKey(routed.guildId, routed.parentChannelId);

    if (adapter.isStreaming(conversationKey)) {
      await adapter.sealLiveRenderer(conversationKey);
      adapter.clearLiveRenderer(conversationKey);
      await adapter.abort(conversationKey).catch(() => false);
      await adapter.waitForRespondDone(conversationKey);
    }

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }

    const runId = nextRunId(conversationKey);
    const renderer = createLiveRendererFromDiscordChannel(config, message.channel);
    adapter.registerLiveRenderer(conversationKey, renderer, runId);
    try {
      const response = await adapter.respond({
        conversationKey,
        workspaceKey,
        sessionName: message.channel.isThread() ? message.channel.name : "thread",
        promptText: buildPromptFromMessage(message, textBody),
        runId,
        discordFetchContext: {
          channelId: message.channel.id,
          guildId: message.guildId ?? undefined,
          anchorMessageId: message.id,
        },
      });
      if (!isLatestRun(conversationKey, runId)) return;
      await renderer.finalize(response);
    } finally {
      adapter.clearLiveRenderer(conversationKey, renderer);
    }
    return;
  }

  if (routed.kind === "channel_mention_oneshot") {
    if (!message.channel.isTextBased()) return;
    const parentId = getParentChannelId(message);
    const workspaceKey = buildWorkspaceKey(routed.guildId, parentId);

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }

    const conversationKey = `piguild:oneshot:${message.id}`;
    const runId = nextRunId(conversationKey);
    const renderer = createLiveRendererFromDiscordChannel(config, message.channel);
    adapter.registerLiveRenderer(conversationKey, renderer, runId);
    try {
      const response = await adapter.respondOneShot({
        conversationKey,
        workspaceKey,
        sessionName: "channel-mention",
        promptText: buildPromptFromMessage(message, textBody),
        runId,
        discordFetchContext: {
          channelId: message.channel.id,
          guildId: routed.guildId,
          anchorMessageId: message.id,
        },
      });
      if (!isLatestRun(conversationKey, runId)) return;
      await renderer.finalize(response);
    } finally {
      adapter.clearLiveRenderer(conversationKey, renderer);
    }
  }
}
