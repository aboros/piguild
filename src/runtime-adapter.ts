import type { LiveDiscordRunRenderer } from "./core/live-discord-renderer.js";
import type { PiLiveUpdate } from "./core/live-discord-renderer.js";
import type { PiguildRuntimeConfig } from "./config.js";
import { PiguildSessionPool } from "./session-pool.js";
import type { AccessRequest, ApprovalDecisionMode } from "./core/access-approval.js";
import type { DiscordFetchContext } from "./core/discord-fetch-context.js";

export interface RegisteredLiveRenderer {
  renderer: LiveDiscordRunRenderer;
  runId?: number;
}

export class PiguildRuntimeAdapter {
  readonly liveRenderers = new Map<string, RegisteredLiveRenderer>();

  constructor(
    readonly config: PiguildRuntimeConfig,
    readonly pool: PiguildSessionPool,
  ) {}

  isOwner(userId: string): boolean {
    return this.pool.isOwner(userId);
  }

  resolveAccessRequest(requestId: string, mode: ApprovalDecisionMode): AccessRequest | undefined {
    return this.pool.resolveAccessRequest(requestId, mode);
  }

  registerLiveRenderer(conversationKey: string, renderer: LiveDiscordRunRenderer, runId?: number): void {
    this.liveRenderers.set(conversationKey, { renderer, runId });
  }

  async sealLiveRenderer(conversationKey: string): Promise<void> {
    const current = this.liveRenderers.get(conversationKey);
    if (!current) return;
    await current.renderer.sealCurrentMessages();
  }

  clearLiveRenderer(conversationKey: string, renderer?: LiveDiscordRunRenderer): void {
    const current = this.liveRenderers.get(conversationKey);
    if (!current) return;
    if (renderer && current.renderer !== renderer) return;
    this.liveRenderers.delete(conversationKey);
  }

  async notifyConversation(conversationKey: string, runId: number | undefined, update: PiLiveUpdate): Promise<void> {
    const entry = this.liveRenderers.get(conversationKey);
    if (!entry) return;
    if (entry.runId !== undefined && runId !== undefined && entry.runId !== runId) return;
    await entry.renderer.onUpdate(update);
  }

  async notifyAccessRequest(conversationKey: string, content: string): Promise<void> {
    const entry = this.liveRenderers.get(conversationKey);
    if (!entry) {
      return;
    }
    const requestId = content.match(/Request ID:\s*(acc-\d+)/)?.[1] || content.match(/Access request\s+(acc-\d+)/)?.[1];
    await entry.renderer.showAccessRequest(content, requestId);
  }

  respond(
    options: {
      conversationKey: string;
      workspaceKey: string;
      sessionName: string;
      promptText: string;
      runId?: number;
      discordFetchContext?: DiscordFetchContext;
    },
  ): Promise<string> {
    return this.pool.respond(options);
  }

  invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
    runId?: number;
    discordFetchContext?: DiscordFetchContext;
  }): Promise<string> {
    return this.pool.invokeSkill(options);
  }

  respondOneShot(options: {
    conversationKey?: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
    runId?: number;
    discordFetchContext?: DiscordFetchContext;
  }): Promise<string> {
    return this.pool.respondOneShot(options);
  }

  abort(conversationKey: string): Promise<boolean> {
    return this.pool.abort(conversationKey);
  }

  reset(conversationKey: string): Promise<boolean> {
    return this.pool.reset(conversationKey);
  }

  compactSession(conversationKey: string, instructions?: string): Promise<boolean> {
    return this.pool.compact(conversationKey, instructions);
  }

  isStreaming(conversationKey: string): boolean {
    return this.pool.isStreaming(conversationKey);
  }

  waitForRespondDone(conversationKey: string): Promise<void> {
    return this.pool.waitForRespondDone(conversationKey);
  }

  getThinkingVisibility(conversationKey: string): boolean {
    return this.pool.getThinkingVisibility(conversationKey);
  }

  setThinkingVisibility(conversationKey: string, visible: boolean): void {
    this.pool.setThinkingVisibility(conversationKey, visible);
  }

  getWorkspaceInfo(workspaceKey: string): { root: string } {
    return this.pool.getWorkspaceInfo(workspaceKey);
  }

  hasSessionBinding(conversationKey: string): boolean {
    return this.pool.hasSessionBinding(conversationKey);
  }

  getBoundSessionSummary(conversationKey: string) {
    return this.pool.getBoundSessionSummary(conversationKey);
  }

  getSkillSummaries() {
    return this.pool.getSkillSummaries();
  }

  getEffectiveModel(conversationKey: string, workspaceKey: string) {
    return this.pool.getEffectiveModel(conversationKey, workspaceKey);
  }

  async setWorkspaceModel(workspaceKey: string, modelReference: string) {
    return this.pool.setWorkspaceModel(workspaceKey, modelReference);
  }

  async setConversationModel(conversationKey: string, workspaceKey: string, modelReference: string) {
    return this.pool.setConversationModel(conversationKey, workspaceKey, modelReference);
  }

  setWorkspaceThinkingLevel(workspaceKey: string, level: import("./types.js").ThinkingLevel) {
    this.pool.setWorkspaceThinkingLevel(workspaceKey, level);
  }

  setConversationThinkingLevel(conversationKey: string, workspaceKey: string, level: import("./types.js").ThinkingLevel) {
    this.pool.setConversationThinkingLevel(conversationKey, workspaceKey, level);
  }

  getEffectiveThinkingLevel(conversationKey: string, workspaceKey: string) {
    return this.pool.getEffectiveThinkingLevel(conversationKey, workspaceKey);
  }
}
