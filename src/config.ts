import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readPersonaOptional } from "./workspace.js";
export type { ThinkingLevel } from "./types.js";

const thinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

export const piguildConfigSchema = z.object({
  discordToken: z.string(),
  allowedGuildIds: z.array(z.string()),
  guildWorkspaces: z.record(z.string()),
  defaultWorkspace: z.string(),
  perChannelWorkspaces: z.union([z.literal("off"), z.literal("all"), z.array(z.string())]),
  perChannelWorkspaceBase: z.string(),
  allowDm: z.boolean(),
  trigger: z.object({
    mention: z.boolean(),
    allowedChannelIds: z.array(z.string()),
  }),
  access: z.object({
    ownerUserId: z.string(),
    allowedRoleNames: z.array(z.string()),
    allowedUserIds: z.array(z.string()),
    blockedPathPatterns: z.array(z.string()),
  }),
  statePath: z.string(),
  registerCommands: z.boolean().optional().default(true),
  renderer: z.enum(["default", "minimal"]),
  rendererOptions: z.object({
    toolIcons: z
      .object({
        done: z.string(),
        running: z.string(),
        failed: z.string(),
      })
      .optional(),
    showModel: z.boolean(),
    showContext: z.boolean(),
    showThinking: z.boolean(),
    compactTools: z.boolean(),
  }),
  personaFile: z.string().optional(),
  systemPromptAppend: z.string(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: z.enum(["coding", "read-only"]),
});

export type PiguildConfig = z.infer<typeof piguildConfigSchema>;

export type PiguildRuntimeConfig = PiguildConfig & {
  configPath: string;
  personaContent?: string;
};

function resolveEnvToken(raw: string): string {
  const match = /^ENV:(.+)$/.exec(raw.trim());
  if (!match) {
    return raw;
  }
  const v = process.env[match[1]!];
  if (!v) {
    throw new Error(`Environment variable ${match[1]} is not set (discord token).`);
  }
  return v;
}

export function loadPiguildConfig(cwd: string): PiguildRuntimeConfig {
  const configPath = process.env.PIGUILD_CONFIG
    ? path.resolve(process.env.PIGUILD_CONFIG)
    : path.resolve(cwd, "piguild.config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`piguild config not found: ${configPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const base = piguildConfigSchema.parse(parsed);
  const withToken: PiguildConfig = {
    ...base,
    discordToken: resolveEnvToken(base.discordToken),
  };

  const configDir = path.dirname(configPath);
  const personaContent = readPersonaOptional(withToken.personaFile, configDir);

  return {
    ...withToken,
    configPath,
    personaContent,
  };
}

export function isActiveRuntime(config: PiguildRuntimeConfig): boolean {
  return Boolean(config.discordToken?.trim());
}
