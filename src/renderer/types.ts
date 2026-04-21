import type { PiLiveUpdate } from "../vendor/live-discord-renderer.js";

/** Timeline/metadata surface for custom renderers (phase 2+). */
export interface PiguildRendererHooks {
  onLiveUpdate?(update: PiLiveUpdate): void | Promise<void>;
}
