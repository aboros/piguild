import type { ChatInputCommandInteraction, Message } from "discord.js";
import { ChannelType } from "discord.js";
import type { PiguildRuntimeConfig } from "./config.js";
import { buildWorkspaceKey } from "./workspace.js";
import { threadConversationKey, dmConversationKey } from "./conversation-keys.js";
import { getParentChannelId } from "./access.js";

export type RoutedGuildMessage =
  | { kind: "thread_mention"; guildId: string; threadId: string; parentChannelId: string }
  | { kind: "channel_mention_oneshot"; guildId: string; channelId: string };

/**
 * Classify a guild message for mention handling (caller already validated mention + allowlists).
 */
export function routeGuildMention(message: Message): RoutedGuildMessage | undefined {
  if (!message.guildId) {
    return undefined;
  }

  if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) {
    return {
      kind: "thread_mention",
      guildId: message.guildId,
      threadId: message.channel.id,
      parentChannelId: message.channel.parentId ?? "",
    };
  }

  if (message.channel.type === ChannelType.GuildText) {
    return {
      kind: "channel_mention_oneshot",
      guildId: message.guildId,
      channelId: message.channel.id,
    };
  }

  return undefined;
}

export function parentChannelAllowed(config: PiguildRuntimeConfig, message: Message): boolean {
  const parent = getParentChannelId(message);
  return config.trigger.allowedChannelIds.includes(parent);
}

export function getWorkspaceKeyForSlash(interaction: ChatInputCommandInteraction): string | null {
  if (!interaction.channel) {
    return null;
  }
  if (!interaction.guildId) {
    return "piguild:dm:ws";
  }
  const channel = interaction.channel;
  if (channel.isThread()) {
    return buildWorkspaceKey(interaction.guildId, channel.parentId ?? channel.id);
  }
  return buildWorkspaceKey(interaction.guildId, channel.id);
}

/**
 * Slash commands that only apply to an existing session (thread/DM) use real thread/DM keys.
 * In a top-level guild text channel, session commands are unavailable.
 */
export function getSessionSlashContext(interaction: ChatInputCommandInteraction): {
  conversationKey: string;
  workspaceKey: string;
  sessionLabel: string;
} | null {
  if (!interaction.guildId || !interaction.channel) {
    if (!interaction.channel) return null;
    return {
      conversationKey: dmConversationKey(interaction.user.id),
      workspaceKey: "piguild:dm:ws",
      sessionLabel: `dm-${interaction.user.username}`,
    };
  }

  const guildId = interaction.guildId;
  const channel = interaction.channel;
  if (channel.isThread()) {
    return {
      conversationKey: threadConversationKey(guildId, channel.id),
      workspaceKey: buildWorkspaceKey(guildId, channel.parentId ?? channel.id),
      sessionLabel: channel.name,
    };
  }

  return null;
}

export function isSlashAllowed(config: PiguildRuntimeConfig, interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guildId) {
    return config.allowDm;
  }

  if (!config.allowedGuildIds.includes(interaction.guildId)) {
    return false;
  }

  const parentId = interaction.channel?.isThread()
    ? interaction.channel.parentId
    : interaction.channelId;

  if (!parentId) {
    return false;
  }

  if (config.trigger.allowedChannelIds.length === 0) {
    return false;
  }

  return config.trigger.allowedChannelIds.includes(parentId);
}
