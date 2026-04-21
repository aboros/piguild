import type { ButtonInteraction } from "discord.js";
import type { PiguildRuntimeAdapter } from "../runtime-adapter.js";
import { truncateErrorMessage } from "./errors.js";

const ACCESS_BUTTON_PREFIX = "access:";

export function isAccessRequestButton(customId: string): boolean {
  return customId.startsWith(ACCESS_BUTTON_PREFIX);
}

/**
 * Handles Allow once / Always allow / Deny for outside-workspace permission embeds
 * (custom IDs from {@link ../vendor/live-discord-renderer.js}).
 */
export async function handleAccessButtonInteraction(
  interaction: ButtonInteraction,
  adapter: PiguildRuntimeAdapter,
): Promise<void> {
  if (!interaction.customId.startsWith(ACCESS_BUTTON_PREFIX)) {
    return;
  }

  if (!adapter.isOwner(interaction.user.id)) {
    await interaction.reply({
      content: "Only the configured owner can approve or deny access requests.",
      ephemeral: true,
    });
    return;
  }

  const rest = interaction.customId.slice(ACCESS_BUTTON_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    await interaction.reply({ content: "Invalid access button.", ephemeral: true });
    return;
  }

  const mode = rest.slice(0, colon);
  const requestId = rest.slice(colon + 1);

  if (!requestId || !["once", "always", "deny"].includes(mode)) {
    await interaction.reply({ content: "Invalid access button.", ephemeral: true });
    return;
  }

  try {
    const request = adapter.resolveAccessRequest(requestId, mode as "once" | "always" | "deny");
    await interaction.update({
      content: request
        ? `Resolved ${requestId}: ${mode}.`
        : `No pending access request with id ${requestId}.`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = truncateErrorMessage(rawMessage);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
  }
}
