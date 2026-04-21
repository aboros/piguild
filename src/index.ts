import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startPiguildExtensionRuntime } from "./piguild-bridge.js";

export default function piguildExtension(pi: ExtensionAPI) {
  let stopHandle: (() => Promise<void>) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const started = await startPiguildExtensionRuntime({
      pi,
      cwd: ctx.cwd,
      notify: (message, level = "info") => ctx.ui.notify(message, level),
    });
    stopHandle = started.stop;
  });

  pi.on("session_shutdown", async () => {
    if (stopHandle) {
      await stopHandle();
      stopHandle = undefined;
    }
  });
}

export { loadPiguildConfig } from "./config.js";
export type { PiguildConfig, PiguildRuntimeConfig, ThinkingLevel } from "./config.js";
