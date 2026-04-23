import { LiveDiscordRunRenderer, createChannelLiveMessageTarget } from "../core/live-discord-renderer.js";
import type { PiguildRuntimeConfig } from "../config.js";

export type ChannelArg = Parameters<typeof createChannelLiveMessageTarget>[0];

/** Chooses Discord live renderer; `minimal` hides thinking by default. */
export function createLiveRendererForConfig(
  config: PiguildRuntimeConfig,
  channel: ChannelArg,
): LiveDiscordRunRenderer {
  const thinkingVisible =
    config.renderer === "minimal" ? false : config.rendererOptions.showThinking;
  return new LiveDiscordRunRenderer(createChannelLiveMessageTarget(channel), {
    thinkingVisible,
    showModel: config.rendererOptions.showModel,
    showContext: config.rendererOptions.showContext,
  });
}

/** Narrow discord.js channel unions to the shape expected by the live renderer. */
export function createLiveRendererFromDiscordChannel(
  config: PiguildRuntimeConfig,
  channel: import("discord.js").Message["channel"],
): LiveDiscordRunRenderer {
  return createLiveRendererForConfig(config, channel as ChannelArg);
}
