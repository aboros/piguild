import { GuildMember, type Guild, type Message } from "discord.js";
import type { PiguildRuntimeConfig } from "./config.js";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getParentChannelId(message: Message): string {
  return message.channel.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId;
}

export function extractMemberRoleIds(member: Message["member"]): string[] {
  if (!member) {
    return [];
  }

  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }

  const api = member as { roles?: string[] };
  if (Array.isArray(api.roles)) {
    return api.roles.filter((roleId): roleId is string => typeof roleId === "string");
  }

  return [];
}

async function resolveAllowedRoleIds(config: PiguildRuntimeConfig, guild: Guild | null): Promise<string[]> {
  const roleIds: string[] = [];
  if (!guild || config.access.allowedRoleNames.length === 0) {
    return unique(roleIds);
  }

  await guild.roles.fetch();
  for (const roleName of config.access.allowedRoleNames) {
    if (roleName === "everyone" || roleName === "@everyone") {
      roleIds.push(guild.roles.everyone.id);
      continue;
    }
    const matched = guild.roles.cache.find((role) => role.name === roleName);
    if (matched) {
      roleIds.push(matched.id);
    }
  }

  return unique(roleIds);
}

export async function buildMemberRoleIdSet(config: PiguildRuntimeConfig, guild: Guild | null): Promise<Set<string>> {
  const ids = await resolveAllowedRoleIds(config, guild);
  return new Set(ids);
}

export async function canAccessGuildMessage(config: PiguildRuntimeConfig, message: Message): Promise<{ allowed: boolean; reason?: string }> {
  if (!message.guildId || !message.guild) {
    return { allowed: false, reason: "Not in a guild." };
  }

  if (!config.allowedGuildIds.includes(message.guildId)) {
    return { allowed: false, reason: "This server is not allowlisted for piguild." };
  }

  const authorId = message.author.id;
  if (config.access.ownerUserId === authorId) {
    return { allowed: true };
  }

  const noUserAllowlist = config.access.allowedUserIds.length === 0;
  const noRoleAllowlist = config.access.allowedRoleNames.length === 0;
  if (noUserAllowlist && noRoleAllowlist) {
    return { allowed: true };
  }

  if (config.access.allowedUserIds.includes(authorId)) {
    return { allowed: true };
  }

  const allowedRoleIds = await resolveAllowedRoleIds(config, message.guild);
  const memberRoles = extractMemberRoleIds(message.member);
  if (memberRoles.some((id) => allowedRoleIds.includes(id))) {
    return { allowed: true };
  }

  return { allowed: false, reason: "You do not have permission to use piguild here." };
}

export function canAccessDm(config: PiguildRuntimeConfig, userId: string): { allowed: boolean; reason?: string } {
  if (!config.allowDm) {
    return { allowed: false, reason: "DMs are disabled for this bot." };
  }
  if (config.access.ownerUserId === userId) {
    return { allowed: true };
  }
  if (config.access.allowedUserIds.includes(userId)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "You are not allowlisted for DM use." };
}
