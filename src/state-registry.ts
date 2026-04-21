import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface PiguildStateFile {
  version: 4;
  sessions: Record<string, { sessionFile: string; workspaceKey: string }>;
}

const EMPTY: PiguildStateFile = {
  version: 4,
  sessions: {},
};

export class PiguildStateRegistry {
  private state: PiguildStateFile = EMPTY;

  constructor(private readonly statePath: string) {}

  load(): void {
    if (!existsSync(this.statePath)) {
      this.state = { ...EMPTY, sessions: {} };
      return;
    }

    const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PiguildStateFile>;
    this.state = {
      version: 4,
      sessions: parsed.sessions ?? {},
    };
  }

  getSessionFile(conversationKey: string): string | undefined {
    return this.state.sessions[conversationKey]?.sessionFile;
  }

  setSessionFile(conversationKey: string, sessionFile: string, workspaceKey: string): void {
    this.state.sessions[conversationKey] = { sessionFile, workspaceKey };
    this.save();
  }

  deleteSessionFile(conversationKey: string): void {
    if (!this.state.sessions[conversationKey]) return;
    delete this.state.sessions[conversationKey];
    this.save();
  }

  private save(): void {
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  static resolveStatePath(inputPath: string): string {
    return path.resolve(inputPath);
  }
}
