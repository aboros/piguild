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

function resolveEnvTokens(value: unknown): unknown {
  if (typeof value === "string") {
    const match = /^ENV:(.+)$/.exec(value.trim());
    if (!match) {
      return value;
    }
    const name = match[1]!;
    const resolved = process.env[name];
    if (!resolved) {
      throw new Error(`Environment variable ${name} is not set.`);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvTokens(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = resolveEnvTokens(entry);
    }
    return out;
  }
  return value;
}

export function loadPiguildConfig(cwd: string): PiguildRuntimeConfig {
  const configPath = process.env.PIGUILD_CONFIG
    ? path.resolve(process.env.PIGUILD_CONFIG)
    : path.resolve(cwd, "piguild.config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`piguild config not found: ${configPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const resolved = resolveEnvTokens(parsed);
  const base = piguildConfigSchema.parse(resolved);

  const configDir = path.dirname(configPath);
  const personaContent = readPersonaOptional(base.personaFile, configDir);

  return {
    ...base,
    configPath,
    personaContent,
  };
}

export function isActiveRuntime(config: PiguildRuntimeConfig): boolean {
  return Boolean(config.discordToken?.trim());
}
