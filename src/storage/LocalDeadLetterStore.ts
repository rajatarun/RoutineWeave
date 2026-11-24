import fs from "fs";
import path from "path";
import { logger } from "../utils";

export interface DeadLetterInput {
  id: string;
  taskId: string;
  flowId?: string;
  payload: unknown;
  error: string;
  failedAt: string;
}

export interface DeadLetterEntry extends DeadLetterInput {
  replayed: boolean;
  replayedAt?: string;
}

export interface ListDeadLettersOptions {
  taskId?: string;
  includeReplayed?: boolean;
}

/**
 * Durable, zero-native-dependency JSONL local dead-letter queue store.
 * Persists failed task/flow executions for later inspection, replay, and purging.
 */
export class LocalDeadLetterStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || !filePath.trim()) {
      throw new Error("LocalDeadLetterStore requires a non-empty filePath");
    }
    this.filePath = path.resolve(filePath);
  }

  getFilePath(): string {
    return this.filePath;
  }

  enqueue(entry: DeadLetterInput): DeadLetterEntry {
    if (!entry.id || !entry.id.trim()) {
      throw new Error("Dead-letter entry requires a non-empty id");
    }
    if (!entry.taskId || !entry.taskId.trim()) {
      throw new Error("Dead-letter entry requires a non-empty taskId");
    }

    const normalized: DeadLetterEntry = {
      id: entry.id,
      taskId: entry.taskId,
      ...(entry.flowId !== undefined ? { flowId: entry.flowId } : {}),
      payload: entry.payload,
      error: entry.error,
      failedAt: entry.failedAt || new Date().toISOString(),
      replayed: false,
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, "utf-8");
    return normalized;
  }

  list(options: ListDeadLettersOptions = {}): DeadLetterEntry[] {
    const includeReplayed = options.includeReplayed ?? false;
    let entries = this.readAllEntries();

    if (!includeReplayed) {
      entries = entries.filter((entry) => !entry.replayed);
    }

    if (options.taskId !== undefined) {
      entries = entries.filter((entry) => entry.taskId === options.taskId);
    }

    return entries;
  }

  markReplayed(id: string, replayedAt?: string): boolean {
    if (!fs.existsSync(this.filePath)) {
      return false;
    }

    const entries = this.readAllEntries();
    let updated = false;
    const timestamp = replayedAt ?? new Date().toISOString();

    for (const entry of entries) {
      if (entry.id === id) {
        entry.replayed = true;
        entry.replayedAt = timestamp;
        updated = true;
      }
    }

    if (updated) {
      this.writeAllEntries(entries);
    }

    return updated;
  }

  purgeReplayed(): number {
    if (!fs.existsSync(this.filePath)) {
      return 0;
    }

    const entries = this.readAllEntries();
    const remaining = entries.filter((entry) => !entry.replayed);
    const purgedCount = entries.length - remaining.length;

    if (purgedCount > 0) {
      this.writeAllEntries(remaining);
    }

    return purgedCount;
  }

  private writeAllEntries(entries: DeadLetterEntry[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const serialized =
      entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, serialized, "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }

  private readAllEntries(): DeadLetterEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const entries: DeadLetterEntry[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(line);
        if (this.isValidEntry(parsed)) {
          entries.push(parsed);
        } else {
          logger.warn("Skipping malformed entry in LocalDeadLetterStore", {
            filePath: this.filePath,
            lineNumber: i + 1,
          });
        }
      } catch {
        logger.warn("Skipping corrupt JSONL line in LocalDeadLetterStore", {
          filePath: this.filePath,
          lineNumber: i + 1,
        });
      }
    }

    return entries;
  }

  private isValidEntry(value: unknown): value is DeadLetterEntry {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.id === "string" &&
      typeof obj.taskId === "string" &&
      typeof obj.error === "string" &&
      typeof obj.failedAt === "string" &&
      typeof obj.replayed === "boolean" &&
      (obj.flowId === undefined || typeof obj.flowId === "string") &&
      (obj.replayedAt === undefined || typeof obj.replayedAt === "string")
    );
  }
}
