import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

const RESERVED_COMMAND_NAMES = new Set([
  "ask",
  "abort",
  "reset",
  "status",
  "use-model",
  "think",
  "compact",
  "reload",
]);

function truncateDescription(description: string): string {
  return description.length <= 100 ? description : `${description.slice(0, 97)}...`;
}

export interface SkillSummary {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
}

function buildSkillCommand(skill: SkillSummary): RESTPostAPIChatInputApplicationCommandsJSONBody | undefined {
  if (RESERVED_COMMAND_NAMES.has(skill.name)) return undefined;
  if (!/^[a-z0-9-]{1,32}$/.test(skill.name)) return undefined;

  return new SlashCommandBuilder()
    .setName(skill.name)
    .setDescription(truncateDescription(skill.description || `Run the ${skill.name} skill`))
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Optional arguments or prompt text for the skill")
        .setRequired(false),
    )
    .toJSON();
}

export function buildPiguildCommands(skillSummaries: SkillSummary[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const base: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask pi; in a channel this opens a thread with a full session")
      .addStringOption((o) => o.setName("prompt").setDescription("Prompt text").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("Show session and workspace status").toJSON(),
    new SlashCommandBuilder().setName("abort").setDescription("Abort the active run in this thread or DM").toJSON(),
    new SlashCommandBuilder().setName("reset").setDescription("Reset the pi session in this thread or DM").toJSON(),
    new SlashCommandBuilder()
      .setName("use-model")
      .setDescription("Set the active model for this workspace (provider/model-id)")
      .addStringOption((o) => o.setName("model").setDescription("Model reference").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("think")
      .setDescription("Set thinking level for this workspace")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("Level")
          .setRequired(true)
          .addChoices(
            { name: "none", value: "off" },
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "xhigh", value: "xhigh" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Compact session context in this thread or DM")
      .addStringOption((o) =>
        o.setName("instructions").setDescription("Optional compaction instructions").setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reload")
      .setDescription("Reload pi tooling (owner only)")
      .toJSON(),
  ];

  const skills = skillSummaries
    .map((s) => buildSkillCommand(s))
    .filter((c): c is RESTPostAPIChatInputApplicationCommandsJSONBody => Boolean(c));

  return [...base, ...skills];
}
