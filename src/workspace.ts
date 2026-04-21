import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { PiguildConfig } from "./config.js";

export function expandUserPath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

export function resolveWorkspace(guildId: string, channelId: string, config: PiguildConfig): string {
  const guildRoot = expandUserPath(config.guildWorkspaces[guildId] ?? config.defaultWorkspace);
  const perChannel = config.perChannelWorkspaces;

  if (perChannel === "off") {
    return path.resolve(guildRoot);
  }

  const base = expandUserPath(config.perChannelWorkspaceBase);
  if (perChannel === "all") {
    return path.join(base, channelId);
  }

  if (Array.isArray(perChannel) && perChannel.includes(channelId)) {
    return path.join(base, channelId);
  }

  return path.resolve(guildRoot);
}

/** Workspace state key for pi session pool: one entry per (guild, parent channel) or DM bucket. */
export function buildWorkspaceKey(guildId: string | null, parentChannelId: string): string {
  if (!guildId) {
    return "piguild:dm:ws";
  }
  return `piguild:${guildId}:ch:${parentChannelId}`;
}

export function workspaceRootForKey(workspaceKey: string, config: PiguildConfig): string {
  if (workspaceKey === "piguild:dm:ws") {
    return path.resolve(expandUserPath(config.defaultWorkspace));
  }
  const m = /^piguild:(\d+):ch:(\d+)$/.exec(workspaceKey);
  if (!m) {
    throw new Error(`Invalid workspace key: ${workspaceKey}`);
  }
  return resolveWorkspace(m[1]!, m[2]!, config);
}

export function readPersonaOptional(personaFile: string | undefined, configDir: string): string | undefined {
  if (!personaFile?.trim()) return undefined;
  const abs = path.isAbsolute(personaFile) ? personaFile : path.resolve(configDir, personaFile);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, "utf8");
}
