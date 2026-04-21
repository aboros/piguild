import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isActiveRuntime, loadPiguildConfig } from "./config.js";
import { startPiguildBot } from "./bot.js";

export interface PiguildBridgeHandle {
  stop: () => Promise<void>;
}

export async function startPiguildExtensionRuntime({
  pi,
  cwd,
  notify,
}: {
  pi: ExtensionAPI;
  cwd: string;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<PiguildBridgeHandle> {
  const config = loadPiguildConfig(cwd);

  if (!isActiveRuntime(config) || !config.discordToken) {
    notify("piguild inactive: set discord token in piguild.config.json (ENV:...) or PIGUILD_CONFIG.", "info");
    return { stop: async () => undefined };
  }

  const started = await startPiguildBot({ config, pi, cwd, notify });
  return {
    stop: started.stop,
  };
}
