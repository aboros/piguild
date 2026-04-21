import { type ChatInputCommandInteraction, ChannelType, ThreadAutoArchiveDuration, type TextChannel } from "discord.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiguildRuntimeConfig } from "../config.js";
import type { PiguildRuntimeAdapter } from "../runtime-adapter.js";
import { buildPromptFromInteraction } from "../discord/message-helpers.js";
import { truncateErrorMessage } from "../discord/errors.js";
import {
  getSessionSlashContext,
  getWorkspaceKeyForSlash,
  isSlashAllowed,
} from "../message-router.js";
import { threadConversationKey, dmConversationKey } from "../conversation-keys.js";
import { buildWorkspaceKey } from "../workspace.js";
import { createLiveRendererForConfig, type ChannelArg } from "../renderer/factory.js";
import type { DiscordFetchContext } from "../vendor/discord-fetch-context.js";

export interface CommandHandlerDeps {
  config: PiguildRuntimeConfig;
  adapter: PiguildRuntimeAdapter;
  pi: ExtensionAPI;
  nextRunId: (conversationKey: string) => number;
  isLatestRun: (conversationKey: string, runId: number) => boolean;
}

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandHandlerDeps,
): Promise<void> {
  const { config } = deps;

  if (!isSlashAllowed(config, interaction)) {
    await interaction.reply({
      content: "piguild: command not allowed in this channel or context.",
      ephemeral: true,
    });
    return;
  }

  const access = await canUserAccessSlash(interaction, config);
  if (!access) {
    await interaction.reply({ content: "You do not have permission to use piguild.", ephemeral: true });
    return;
  }

  const name = interaction.commandName;

  try {
    if (name === "ask") {
      await handleAsk(interaction, deps);
      return;
    }
    if (name === "status") {
      await handleStatus(interaction, deps);
      return;
    }
    if (name === "abort") {
      await handleAbort(interaction, deps);
      return;
    }
    if (name === "reset") {
      await handleReset(interaction, deps);
      return;
    }
    if (name === "use-model") {
      await handleUseModel(interaction, deps);
      return;
    }
    if (name === "think") {
      await handleThink(interaction, deps);
      return;
    }
    if (name === "compact") {
      await handleCompact(interaction, deps);
      return;
    }
    if (name === "reload") {
      await handleReload(interaction, deps);
      return;
    }

    await handleSkillByName(interaction, deps, name);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const truncated = truncateErrorMessage(text);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `piguild error: ${truncated}`, ephemeral: true }).catch(() => undefined);
    } else {
      await interaction.reply({ content: `piguild error: ${truncated}`, ephemeral: true }).catch(() => undefined);
    }
  }
}

async function canUserAccessSlash(
  interaction: ChatInputCommandInteraction,
  config: PiguildRuntimeConfig,
): Promise<boolean> {
  if (config.access.ownerUserId === interaction.user.id) {
    return true;
  }
  if (config.access.allowedUserIds.includes(interaction.user.id)) {
    return true;
  }
  if (!interaction.inGuild() || !interaction.member) {
    return config.allowDm;
  }

  const guild = interaction.guild;
  if (!guild) return false;
  await guild.roles.fetch();

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;

  if (config.access.allowedUserIds.length === 0 && config.access.allowedRoleNames.length === 0) {
    return true;
  }

  if (config.access.allowedRoleNames.length === 0) {
    return false;
  }

  for (const roleName of config.access.allowedRoleNames) {
    const role =
      roleName === "everyone" || roleName === "@everyone"
        ? guild.roles.everyone
        : guild.roles.cache.find((r) => r.name === roleName);
    if (role && member.roles.cache.has(role.id)) {
      return true;
    }
  }

  return false;
}

async function handleAsk(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { config, adapter, nextRunId, isLatestRun } = deps;
  const prompt = interaction.options.getString("prompt", true);
  await interaction.deferReply({ ephemeral: false });

  if (!interaction.guildId || !interaction.channel) {
    const conversationKey = dmConversationKey(interaction.user.id);
    const workspaceKey = "piguild:dm:ws";
    const runId = nextRunId(conversationKey);
    const renderer = createLiveRendererForConfig(config, interaction.channel! as ChannelArg);
    adapter.registerLiveRenderer(conversationKey, renderer, runId);
    try {
      const response = await adapter.respond({
        conversationKey,
        workspaceKey,
        sessionName: `dm-${interaction.user.username}`,
        promptText: buildPromptFromInteraction(interaction, prompt),
        runId,
        discordFetchContext: { channelId: interaction.channel!.id },
      });
      if (!isLatestRun(conversationKey, runId)) return;
      await renderer.finalize(response);
      await interaction.editReply("Done.");
    } finally {
      adapter.clearLiveRenderer(conversationKey, renderer);
    }
    return;
  }

  const guildId = interaction.guildId;
  const channel = interaction.channel;

  if (channel.isThread()) {
    const conversationKey = threadConversationKey(guildId, channel.id);
    const workspaceKey = buildWorkspaceKey(guildId, channel.parentId ?? channel.id);
    const runId = nextRunId(conversationKey);
    const renderer = createLiveRendererForConfig(config, channel as ChannelArg);
    adapter.registerLiveRenderer(conversationKey, renderer, runId);
    try {
      const fetchCtx: DiscordFetchContext = { channelId: channel.id, guildId };
      const response = await adapter.respond({
        conversationKey,
        workspaceKey,
        sessionName: channel.name,
        promptText: buildPromptFromInteraction(interaction, prompt),
        runId,
        discordFetchContext: fetchCtx,
      });
      if (!isLatestRun(conversationKey, runId)) return;
      await renderer.finalize(response);
      await interaction.editReply("Done.");
    } finally {
      adapter.clearLiveRenderer(conversationKey, renderer);
    }
    return;
  }

  if (channel.type !== ChannelType.GuildText) {
    await interaction.editReply("Open /ask from a text channel or thread.");
    return;
  }

  const textChannel = channel as TextChannel;
  const thread = await textChannel.threads.create({
    name: (prompt.replace(/\s+/g, " ").trim() || "piguild-ask").slice(0, 80),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: "piguild /ask",
  });
  await thread.members.add(interaction.user.id).catch(() => undefined);

  const conversationKey = threadConversationKey(guildId, thread.id);
  const workspaceKey = buildWorkspaceKey(guildId, textChannel.id);
  const runId = nextRunId(conversationKey);
  const renderer = createLiveRendererForConfig(config, thread as ChannelArg);
  adapter.registerLiveRenderer(conversationKey, renderer, runId);
  try {
    const response = await adapter.respond({
      conversationKey,
      workspaceKey,
      sessionName: thread.name,
      promptText: buildPromptFromInteraction(interaction, prompt),
      runId,
    });
    if (!isLatestRun(conversationKey, runId)) return;
    await renderer.finalize(response);
    await interaction.editReply(`Started in thread ${thread}.`);
  } finally {
    adapter.clearLiveRenderer(conversationKey, renderer);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  await interaction.deferReply({ ephemeral: true });

  const wk = getWorkspaceKeyForSlash(interaction);
  if (!wk) {
    await interaction.editReply("Could not resolve workspace.");
    return;
  }

  const sess = getSessionSlashContext(interaction);
  let sessionLine = "No active thread/DM session context.";
  if (sess) {
    const summary = adapter.getBoundSessionSummary(sess.conversationKey);
    const model = await adapter.getEffectiveModel(sess.conversationKey, sess.workspaceKey);
    sessionLine = [
      summary ? `Session: ${summary.name ?? summary.id} (${summary.cwd})` : "Session: (none yet)",
      model ? `Model: ${model.provider}/${model.id}` : "Model: (default)",
    ].join("\n");
  }

  const info = adapter.getWorkspaceInfo(wk);
  await interaction.editReply(
    [`Workspace root: \`${info.root}\``, sessionLine].join("\n"),
  );
}

async function handleAbort(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  const sess = getSessionSlashContext(interaction);
  await interaction.deferReply({ ephemeral: true });
  if (!sess) {
    await interaction.editReply("Use /abort inside a thread or DM session.");
    return;
  }
  const ok = await adapter.abort(sess.conversationKey);
  await interaction.editReply(ok ? "Aborted." : "Nothing to abort.");
}

async function handleReset(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  const sess = getSessionSlashContext(interaction);
  await interaction.deferReply({ ephemeral: true });
  if (!sess) {
    await interaction.editReply("Use /reset inside a thread or DM session.");
    return;
  }
  const ok = await adapter.reset(sess.conversationKey);
  await interaction.editReply(ok ? "Session reset." : "No session to reset.");
}

async function handleUseModel(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  const modelRef = interaction.options.getString("model", true);
  await interaction.deferReply({ ephemeral: true });

  const wk = getWorkspaceKeyForSlash(interaction);
  if (!wk) {
    await interaction.editReply("Could not resolve workspace.");
    return;
  }

  const sess = getSessionSlashContext(interaction);
  const updated = sess
    ? await adapter.setConversationModel(sess.conversationKey, wk, modelRef)
    : await adapter.setWorkspaceModel(wk, modelRef);

  await interaction.editReply(`Model set to \`${updated.provider}/${updated.id}\`.`);
}

async function handleThink(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  const level = interaction.options.getString("level", true) as import("../types.js").ThinkingLevel;
  await interaction.deferReply({ ephemeral: true });

  const wk = getWorkspaceKeyForSlash(interaction);
  if (!wk) {
    await interaction.editReply("Could not resolve workspace.");
    return;
  }

  const sess = getSessionSlashContext(interaction);
  if (sess) {
    adapter.setConversationThinkingLevel(sess.conversationKey, wk, level);
  } else {
    adapter.setWorkspaceThinkingLevel(wk, level);
  }

  await interaction.editReply(`Thinking level set to \`${level}\`.`);
}

async function handleCompact(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { adapter } = deps;
  const instructions = interaction.options.getString("instructions") ?? undefined;
  const sess = getSessionSlashContext(interaction);
  await interaction.deferReply({ ephemeral: true });
  if (!sess) {
    await interaction.editReply("Use /compact inside a thread or DM session.");
    return;
  }
  const ok = await adapter.compactSession(sess.conversationKey, instructions);
  await interaction.editReply(ok ? "Compaction requested." : "No active session to compact.");
}

async function handleReload(interaction: ChatInputCommandInteraction, deps: CommandHandlerDeps): Promise<void> {
  const { config, pi } = deps;
  await interaction.deferReply({ ephemeral: true });
  if (interaction.user.id !== config.access.ownerUserId) {
    await interaction.editReply("Owner only.");
    return;
  }
  pi.sendUserMessage("/reload", { deliverAs: "followUp" });
  await interaction.editReply("Reload requested.");
}

async function handleSkillByName(
  interaction: ChatInputCommandInteraction,
  deps: CommandHandlerDeps,
  skillName: string,
): Promise<void> {
  const { config, adapter, nextRunId, isLatestRun } = deps;
  const args = interaction.options.getString("prompt") ?? undefined;

  await interaction.deferReply({ ephemeral: false });

  const sess = getSessionSlashContext(interaction);
  if (!sess) {
    await interaction.editReply("Run skills from a thread or DM session.");
    return;
  }

  const runId = nextRunId(sess.conversationKey);
  const renderer = createLiveRendererForConfig(config, interaction.channel! as ChannelArg);
  adapter.registerLiveRenderer(sess.conversationKey, renderer, runId);
  try {
    const skillFetch: DiscordFetchContext | undefined = interaction.guildId
      ? { channelId: interaction.channel!.id, guildId: interaction.guildId }
      : { channelId: interaction.channel!.id };
    const response = await adapter.invokeSkill({
      conversationKey: sess.conversationKey,
      workspaceKey: sess.workspaceKey,
      sessionName: sess.sessionLabel,
      skillName,
      args,
      runId,
      discordFetchContext: skillFetch,
    });
    if (!isLatestRun(sess.conversationKey, runId)) return;
    await renderer.finalize(response);
    await interaction.editReply("Done.");
  } finally {
    adapter.clearLiveRenderer(sess.conversationKey, renderer);
  }
}
