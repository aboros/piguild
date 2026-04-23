import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Client } from "discord.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  AccessApprovalManager,
  type AccessRequest,
  type ApprovalDecisionMode,
} from "./core/access-approval.js";
import {
  createDiscordExtensionBindings,
  notifyExtensionBindingFailure,
} from "./core/extension-bindings.js";
import type { PiLiveUpdate } from "./core/live-discord-renderer.js";
import { sumUsageAfterUserMessageAtIndex } from "./core/turn-token-usage.js";
import { filterOutPiguildExtensions, getPiguildPackageRoot } from "./pi-resource-loader.js";
import { PiguildStateRegistry } from "./state-registry.js";
import { createSafeCustomTools } from "./core/safe-tools.js";
import {
  resolveDiscordFetchContext,
  type DiscordFetchContext,
} from "./core/discord-fetch-context.js";
import { createDiscordChannelHistoryTool } from "./core/discord-history-tool.js";
import type { AccessContext } from "./core/path-policy.js";
import { WorkspaceGuard } from "./core/path-policy.js";
import type { PiguildRuntimeConfig } from "./config.js";
import { workspaceRootForKey } from "./workspace.js";

interface SessionHandle {
  session: AgentSession;
  workspaceKey: string;
  conversationKey: string;
}

interface WorkspaceState {
  cwd: string;
  guard: WorkspaceGuard;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
  skills: import("@mariozechner/pi-coding-agent").Skill[];
  modelScopePatterns: string[];
  selectedModel?: { provider: string; id: string };
  selectedThinkingLevel?: import("./types.js").ThinkingLevel;
}

function buildSystemPrompt(config: PiguildRuntimeConfig): string {
  const toolLabel =
    config.toolMode === "coding"
      ? "read, bash, edit, write, grep, find, ls"
      : "read, grep, find, ls";

  return [
    "You are pi responding through Discord (piguild).",
    "Guild workspaces map to local directories; threads keep full session context; channel mentions are standalone tasks.",
    config.personaContent?.trim(),
    "Respect workspace boundaries.",
    `Available tools: ${toolLabel}, discord_fetch_channel_history (only when this Discord session is bound to a channel or thread).`,
    config.systemPromptAppend?.trim(),
  ]
    .filter((line) => Boolean(line && String(line).trim()))
    .join("\n\n");
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(reference: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(reference);
}

export class PiguildSessionPool {
  readonly registry: PiguildStateRegistry;
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly conversationModels = new Map<string, { provider: string; id: string }>();
  private readonly conversationThinkingLevels = new Map<string, import("./types.js").ThinkingLevel>();
  private readonly conversationThinkingVisibility = new Map<string, boolean>();
  private readonly approvals: AccessApprovalManager;
  private discordClient: Client | undefined;
  private readonly notifyLiveUpdate?: (
    conversationKey: string,
    runId: number | undefined,
    update: PiLiveUpdate,
  ) => Promise<void>;
  private respondDone = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(
    private readonly config: PiguildRuntimeConfig,
    notifyAccessRequest: (conversationKey: string, content: string) => Promise<void>,
    notifyLiveUpdate?: (
      conversationKey: string,
      runId: number | undefined,
      update: PiLiveUpdate,
    ) => Promise<void>,
  ) {
    this.approvals = new AccessApprovalManager(this.config.access.ownerUserId, notifyAccessRequest);
    this.registry = new PiguildStateRegistry(this.config.statePath);
    this.notifyLiveUpdate = notifyLiveUpdate;
  }

  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  async initialize(): Promise<void> {
    this.registry.load();
    const roots = new Set<string>();
    roots.add(workspaceRootForKey("piguild:dm:ws", this.config));
    for (const gid of this.config.allowedGuildIds) {
      const gw = this.config.guildWorkspaces[gid];
      if (gw) roots.add(path.resolve(gw));
    }
    roots.add(path.resolve(this.config.defaultWorkspace));
    for (const root of roots) {
      if (fs.existsSync(root)) {
        await this.ensureWorkspaceLoadedByRoot(root);
      }
    }
  }

  isOwner(userId: string): boolean {
    return this.approvals.isOwner(userId);
  }

  resolveAccessRequest(requestId: string, mode: ApprovalDecisionMode): AccessRequest | undefined {
    return this.approvals.resolveRequest(requestId, mode);
  }

  getBlockedPathPatterns(): string[] {
    return [...this.config.access.blockedPathPatterns];
  }

  getSkillSummaries() {
    const uniqueSkills = new Map<string, import("@mariozechner/pi-coding-agent").Skill>();
    for (const workspace of this.workspaces.values()) {
      for (const skill of workspace.skills) {
        if (!uniqueSkills.has(skill.name)) {
          uniqueSkills.set(skill.name, skill);
        }
      }
    }

    return [...uniqueSkills.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
    }));
  }

  getWorkspaceInfo(workspaceKey: string): { root: string } {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    return { root: state.cwd };
  }

  getAvailableModels() {
    return this.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    }));
  }

  listModels(workspaceKey: string) {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    const available = this.getAvailableModels();
    if (state.modelScopePatterns.length === 0) {
      return available;
    }
    return available.filter((model) => {
      const reference = `${model.provider}/${model.id}`;
      return state.modelScopePatterns.some((pattern) => matchesPattern(reference, pattern));
    });
  }

  async setWorkspaceModel(workspaceKey: string, modelReference: string): Promise<{ provider: string; id: string; name: string }> {
    await this.ensureWorkspaceLoaded(workspaceKey);
    const model = this.resolveConfiguredModel(modelReference);
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.selectedModel = { provider: model.provider, id: model.id };

    for (const handle of this.sessions.values()) {
      if (
        handle.workspaceKey === workspaceKey &&
        !this.conversationModels.has(handle.conversationKey)
      ) {
        await handle.session.setModel(model);
      }
    }

    return { provider: model.provider, id: model.id, name: model.name };
  }

  async setConversationModel(
    conversationKey: string,
    workspaceKey: string,
    modelReference: string,
  ): Promise<{ provider: string; id: string; name: string }> {
    const model = this.resolveConfiguredModel(modelReference);
    await this.ensureWorkspaceLoaded(workspaceKey);
    this.conversationModels.set(conversationKey, {
      provider: model.provider,
      id: model.id,
    });

    const handle = this.sessions.get(conversationKey);
    if (handle) {
      await handle.session.setModel(model);
    }

    return { provider: model.provider, id: model.id, name: model.name };
  }

  async getEffectiveModel(
    conversationKey: string,
    workspaceKey: string,
  ): Promise<{ provider: string; id: string; name: string } | undefined> {
    await this.ensureWorkspaceLoaded(workspaceKey);
    const conversationModel = this.conversationModels.get(conversationKey);
    if (conversationModel) {
      const model = this.modelRegistry.find(conversationModel.provider, conversationModel.id);
      if (model) {
        return { provider: model.provider, id: model.id, name: model.name };
      }
    }

    const workspaceModel = this.ensureWorkspaceStateSync(workspaceKey).selectedModel;
    if (!workspaceModel) {
      return undefined;
    }

    const model = this.modelRegistry.find(workspaceModel.provider, workspaceModel.id);
    return model
      ? { provider: model.provider, id: model.id, name: model.name }
      : undefined;
  }

  setWorkspaceThinkingLevel(workspaceKey: string, level: import("./types.js").ThinkingLevel): void {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.selectedThinkingLevel = level;

    for (const handle of this.sessions.values()) {
      if (
        handle.workspaceKey === workspaceKey &&
        !this.conversationThinkingLevels.has(handle.conversationKey)
      ) {
        handle.session.setThinkingLevel(level);
      }
    }
  }

  setConversationThinkingLevel(
    conversationKey: string,
    workspaceKey: string,
    level: import("./types.js").ThinkingLevel,
  ): void {
    this.ensureWorkspaceStateSync(workspaceKey);
    this.conversationThinkingLevels.set(conversationKey, level);
    const handle = this.sessions.get(conversationKey);
    if (handle) {
      handle.session.setThinkingLevel(level);
    }
  }

  getEffectiveThinkingLevel(conversationKey: string, workspaceKey: string): import("./types.js").ThinkingLevel {
    return (
      this.conversationThinkingLevels.get(conversationKey) ??
      this.ensureWorkspaceStateSync(workspaceKey).selectedThinkingLevel ??
      this.config.thinkingLevel
    );
  }

  getThinkingVisibility(conversationKey: string): boolean {
    return this.conversationThinkingVisibility.get(conversationKey) ?? this.config.rendererOptions.showThinking;
  }

  setThinkingVisibility(conversationKey: string, visible: boolean): void {
    this.conversationThinkingVisibility.set(conversationKey, visible);
  }

  hasSessionBinding(conversationKey: string): boolean {
    return Boolean(
      this.sessions.get(conversationKey) || this.registry.getSessionFile(conversationKey),
    );
  }

  getBoundSessionSummary(conversationKey: string):
    | {
        id: string;
        path?: string;
        cwd: string;
        name?: string;
      }
    | undefined {
    const active = this.sessions.get(conversationKey);
    if (active) {
      return {
        id: active.session.sessionManager.getSessionId(),
        path: active.session.sessionManager.getSessionFile(),
        cwd: active.session.sessionManager.getCwd(),
        name: active.session.sessionName,
      };
    }

    const persistedSessionFile = this.registry.getSessionFile(conversationKey);
    if (!persistedSessionFile) {
      return undefined;
    }

    const manager = SessionManager.open(persistedSessionFile);
    return {
      id: manager.getSessionId(),
      path: manager.getSessionFile(),
      cwd: manager.getCwd(),
      name: manager.getSessionName(),
    };
  }

  async abort(conversationKey: string): Promise<boolean> {
    const handle = this.sessions.get(conversationKey);
    if (!handle) return false;
    if (handle.session.isBashRunning) {
      handle.session.abortBash();
    }
    await handle.session.abort().catch(() => undefined);
    return true;
  }

  isStreaming(conversationKey: string): boolean {
    const handle = this.sessions.get(conversationKey);
    return handle?.session.isStreaming ?? false;
  }

  async waitForRespondDone(conversationKey: string): Promise<void> {
    const entry = this.respondDone.get(conversationKey);
    if (!entry) return;
    await entry.promise;
  }

  async reset(conversationKey: string): Promise<boolean> {
    return this.runExclusive(conversationKey, async () => {
      const handle = this.sessions.get(conversationKey);
      if (!handle) return false;

      handle.session.dispose();
      this.sessions.delete(conversationKey);
      this.registry.deleteSessionFile(conversationKey);
      return true;
    });
  }

  async compact(conversationKey: string, instructions?: string): Promise<boolean> {
    const handle = this.sessions.get(conversationKey);
    if (!handle) return false;
    const result = await this.runExclusive(conversationKey, () => handle.session.compact(instructions));
    return result !== undefined;
  }

  async dispose(): Promise<void> {
    for (const handle of this.sessions.values()) {
      handle.session.dispose();
    }
    this.sessions.clear();
    this.queues.clear();
  }

  async respond(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
    runId?: number;
    discordFetchContext?: DiscordFetchContext;
  }): Promise<string> {
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.respondDone.set(options.conversationKey, {
      promise: donePromise,
      resolve: resolveDone,
    });

    try {
      const handle = await this.getOrCreateSession(
        {
          conversationKey: options.conversationKey,
          workspaceKey: options.workspaceKey,
          sessionName: options.sessionName,
          discordFetchContext: options.discordFetchContext,
        },
        { ephemeral: false },
      );
      await this.syncSessionName(handle.session, options.sessionName);

      return await this.runPromptWithStreaming(handle, options.promptText, options.conversationKey, options.runId);
    } finally {
      this.respondDone.delete(options.conversationKey);
      resolveDone();
    }
  }

  /** One-shot: fresh session, no persisted session file, disposed after completion. */
  async invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
    runId?: number;
    discordFetchContext?: DiscordFetchContext;
  }): Promise<string> {
    const promptText = options.args?.trim()
      ? `/skill:${options.skillName} ${options.args.trim()}`
      : `/skill:${options.skillName}`;
    return this.respond({
      conversationKey: options.conversationKey,
      workspaceKey: options.workspaceKey,
      sessionName: options.sessionName,
      promptText,
      runId: options.runId,
      discordFetchContext: options.discordFetchContext,
    });
  }

  async respondOneShot(options: {
    conversationKey?: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
    runId?: number;
    discordFetchContext?: DiscordFetchContext;
  }): Promise<string> {
    const conversationKey = options.conversationKey ?? `piguild:oneshot:${randomUUID()}`;
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.respondDone.set(conversationKey, {
      promise: donePromise,
      resolve: resolveDone,
    });

    try {
      const handle = await this.getOrCreateSession(
        {
          conversationKey,
          workspaceKey: options.workspaceKey,
          sessionName: options.sessionName,
          discordFetchContext: options.discordFetchContext,
        },
        { ephemeral: true },
      );
      await this.syncSessionName(handle.session, options.sessionName);
      const text = await this.runPromptWithStreaming(
        handle,
        options.promptText,
        conversationKey,
        options.runId,
      );
      handle.session.dispose();
      this.sessions.delete(conversationKey);
      return text;
    } finally {
      this.respondDone.delete(conversationKey);
      resolveDone();
    }
  }

  private async runPromptWithStreaming(
    handle: SessionHandle,
    promptText: string,
    conversationKey: string,
    runId: number | undefined,
  ): Promise<string> {
    const chunks: string[] = [];

    const enqueueUpdate = (update: PiLiveUpdate) => {
      if (!this.notifyLiveUpdate) return;
      void this.notifyLiveUpdate(conversationKey, runId, update).catch((error) => {
        console.error("piguild live update failed:", error);
      });
    };

    /** Index where this turn's user message will be appended (see `sumUsageAfterUserMessageAtIndex`). */
    const userMessageIndexForTurn = handle.session.messages.length;

    const enqueueRunState = () => {
      const model = handle.session.model;
      const contextUsage = handle.session.getContextUsage();
      const apiTokenUsage = sumUsageAfterUserMessageAtIndex(handle.session.messages, userMessageIndexForTurn);
      enqueueUpdate({
        type: "run_state",
        modelReference: model ? `${model.provider}/${model.id}` : undefined,
        thinkingLevel: handle.session.thinkingLevel,
        supportsThinking: handle.session.supportsThinking(),
        contextUsage: contextUsage
          ? {
              tokens: contextUsage.tokens,
              contextWindow: contextUsage.contextWindow,
              percent: contextUsage.percent,
            }
          : undefined,
        apiTokenUsage: apiTokenUsage ?? undefined,
      });
    };

    enqueueRunState();

    const toolArgsByCallId = new Map<string, unknown>();

    const unsubscribe = handle.session.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          chunks.push(delta);
          enqueueUpdate({ type: "assistant_delta", delta });
          return;
        }

        if (event.assistantMessageEvent.type === "thinking_delta") {
          const delta = event.assistantMessageEvent.delta;
          enqueueUpdate({ type: "thinking_delta", delta });
          return;
        }

        if (event.assistantMessageEvent.type === "thinking_start") {
          enqueueUpdate({ type: "thinking_start" });
          return;
        }

        if (event.assistantMessageEvent.type === "thinking_end") {
          enqueueUpdate({ type: "thinking_end" });
          return;
        }

        enqueueRunState();
        return;
      }

      if (event.type === "tool_execution_start") {
        toolArgsByCallId.set(event.toolCallId, event.args);
        enqueueUpdate({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      }

      if (event.type === "tool_execution_update") {
        const startedArgs = toolArgsByCallId.get(event.toolCallId);
        enqueueUpdate({
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? startedArgs,
          detail:
            event.partialResult?.details ??
            event.partialResult?.content ??
            event.partialResult,
        });
        return;
      }

      if (event.type === "tool_execution_end") {
        const startedArgs = toolArgsByCallId.get(event.toolCallId);
        toolArgsByCallId.delete(event.toolCallId);
        enqueueUpdate({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          args: startedArgs,
          detail: event.result?.details ?? event.result?.content,
        });
        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "error") {
          const rawError = event.message.errorMessage ?? "Unknown provider error.";
          const truncatedError = rawError.length > 200 ? `${rawError.slice(0, 197)}...` : rawError;
          enqueueUpdate({
            type: "assistant_delta",
            delta: `\n\n❌ Provider error: ${truncatedError}`,
          });
        } else if (event.message.stopReason !== "aborted") {
          enqueueRunState();
        }
      }
    });

    try {
      if (handle.session.isStreaming) {
        await handle.session.abort();
      }
      await handle.session.prompt(promptText);
      enqueueRunState();
    } finally {
      unsubscribe();
    }

    return chunks.join("").trim() || "Done.";
  }

  private resolveConfiguredModel(modelReference: string) {
    const [provider, ...rest] = modelReference.split("/");
    const id = rest.join("/").trim();
    if (!provider || !id) {
      throw new Error("Model reference must look like provider/model-id.");
    }

    const model = this.modelRegistry.find(provider, id);
    if (!model) {
      throw new Error(`Model not found: ${modelReference}`);
    }

    if (!this.modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`Model is not configured for auth: ${modelReference}`);
    }

    return model;
  }

  private async syncSessionName(session: AgentSession, sessionName: string): Promise<void> {
    if (session.sessionName === sessionName) return;
    session.sessionManager.appendSessionInfo(sessionName);
  }

  private async runExclusive<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const barrier = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(conversationKey, barrier);

    try {
      return await run;
    } finally {
      if (this.queues.get(conversationKey) === barrier) {
        this.queues.delete(conversationKey);
      }
    }
  }

  private getWorkspaceRootForKey(workspaceKey: string): string {
    return workspaceRootForKey(workspaceKey, this.config);
  }

  private ensureWorkspaceStateSync(workspaceKey: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;

    const root = this.getWorkspaceRootForKey(workspaceKey);
    const reusable = [...this.workspaces.values()].find((w) => w.cwd === root);
    if (reusable) {
      const state: WorkspaceState = {
        ...reusable,
        modelScopePatterns: [],
        selectedModel: reusable.selectedModel,
        selectedThinkingLevel: reusable.selectedThinkingLevel,
      };
      this.workspaces.set(workspaceKey, state);
      return state;
    }

    throw new Error(`Workspace is not initialized: ${workspaceKey}`);
  }

  private async ensureWorkspaceLoaded(workspaceKey: string): Promise<WorkspaceState> {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;
    return this.ensureWorkspaceLoadedByRoot(this.getWorkspaceRootForKey(workspaceKey), workspaceKey);
  }

  private async ensureWorkspaceLoadedByRoot(root: string, workspaceKey?: string): Promise<WorkspaceState> {
    const existing = workspaceKey ? this.workspaces.get(workspaceKey) : undefined;
    if (existing) return existing;

    const settingsManager = SettingsManager.create(root);
    const globalPiExtensionsPath = path.join(homedir(), ".pi", "extensions");
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      settingsManager,
      noThemes: true,
      appendSystemPrompt: buildSystemPrompt(this.config),
      extensionsOverride: (base) => filterOutPiguildExtensions(base, getPiguildPackageRoot(import.meta.url)),
      additionalSkillPaths: [globalPiExtensionsPath],
    });
    await resourceLoader.reload().catch((err) => {
      console.error(`[piguild] Extension load failed:`, err);
      throw err;
    });

    const state: WorkspaceState = {
      cwd: root,
      guard: new WorkspaceGuard(root, this.config.access.blockedPathPatterns, this.approvals),
      settingsManager,
      resourceLoader,
      skills: resourceLoader.getSkills().skills,
      modelScopePatterns: [],
      selectedModel: undefined,
      selectedThinkingLevel: this.config.thinkingLevel,
    };

    if (workspaceKey) {
      this.workspaces.set(workspaceKey, state);
      return state;
    }

    const syntheticKey = `root:${root}`;
    this.workspaces.set(syntheticKey, state);
    return state;
  }

  private async getOrCreateSession(
    options: {
      conversationKey: string;
      workspaceKey: string;
      sessionName: string;
      discordFetchContext?: DiscordFetchContext;
    },
    mode: { ephemeral: boolean },
  ): Promise<SessionHandle> {
    const existing = this.sessions.get(options.conversationKey);
    if (existing) return existing;

    const workspaceState = await this.ensureWorkspaceLoaded(options.workspaceKey);
    const selectedModel =
      this.conversationModels.get(options.conversationKey) ?? workspaceState.selectedModel;
    const model = selectedModel
      ? this.modelRegistry.find(selectedModel.provider, selectedModel.id)
      : undefined;

    const accessContext: AccessContext = {
      conversationKey: options.conversationKey,
      workspaceKey: options.workspaceKey,
      sessionName: options.sessionName,
    };

    const resolvedDiscord = resolveDiscordFetchContext(
      options.conversationKey,
      options.discordFetchContext,
    );
    const discordHistoryTools =
      this.discordClient && resolvedDiscord
        ? [createDiscordChannelHistoryTool(this.discordClient, resolvedDiscord)]
        : [];

    const tools = [
      createReadTool(workspaceState.cwd, {
        operations: await workspaceState.guard.createReadOperations(accessContext),
      }),
      ...(this.config.toolMode === "coding"
        ? [
            createBashTool(workspaceState.cwd, {
              operations: await workspaceState.guard.createBashOperations(accessContext),
            }),
            createEditTool(workspaceState.cwd, {
              operations: await workspaceState.guard.createEditOperations(accessContext),
            }),
            createWriteTool(workspaceState.cwd, {
              operations: await workspaceState.guard.createWriteOperations(accessContext),
            }),
          ]
        : []),
    ];

    const scopedModels = this.listModels(options.workspaceKey).map((modelSummary) => ({
      model: this.modelRegistry.find(modelSummary.provider, modelSummary.id)!,
    }));

    const existingSessionFile = mode.ephemeral ? undefined : this.registry.getSessionFile(options.conversationKey);
    const sessionManager = existingSessionFile
      ? SessionManager.open(existingSessionFile)
      : SessionManager.create(workspaceState.cwd);

    const { session } = await createAgentSession({
      cwd: workspaceState.cwd,
      model,
      thinkingLevel: this.getEffectiveThinkingLevel(options.conversationKey, options.workspaceKey),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader: workspaceState.resourceLoader,
      tools,
      customTools: [...createSafeCustomTools(workspaceState.guard, accessContext), ...discordHistoryTools],
      scopedModels: scopedModels.length > 0 ? scopedModels : undefined,
      sessionManager,
      settingsManager: workspaceState.settingsManager,
    });

    try {
      await session.bindExtensions(
        createDiscordExtensionBindings({
          conversationKey: options.conversationKey,
          notifyLiveUpdate: this.notifyLiveUpdate,
          onLog: (level, message) => {
            const label = level.toUpperCase();
            console[level === "info" ? "info" : level === "warning" ? "warn" : "error"](
              `[piguild extensions:${options.conversationKey}] ${label}: ${message}`,
            );
          },
        }),
      );
    } catch (error) {
      await notifyExtensionBindingFailure(
        {
          conversationKey: options.conversationKey,
          notifyLiveUpdate: this.notifyLiveUpdate,
          onLog: (level, message) => {
            const label = level.toUpperCase();
            console[level === "info" ? "info" : level === "warning" ? "warn" : "error"](
              `[piguild extensions:${options.conversationKey}] ${label}: ${message}`,
            );
          },
        },
        error,
      );
    }

    const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;
    if (!hasExistingSession) {
      if (typeof session.newSession === "function") {
        await session.newSession({
          setup: async (innerSessionManager) => {
            innerSessionManager.appendSessionInfo(options.sessionName);
          },
        });
      } else {
        session.sessionManager.appendSessionInfo(options.sessionName);
      }
    }

    const persistedSessionFile = session.sessionManager.getSessionFile();
    if (persistedSessionFile && !mode.ephemeral) {
      this.registry.setSessionFile(options.conversationKey, persistedSessionFile, options.workspaceKey);
    }

    const handle = {
      session,
      workspaceKey: options.workspaceKey,
      conversationKey: options.conversationKey,
    } satisfies SessionHandle;
    this.sessions.set(options.conversationKey, handle);
    return handle;
  }
}
