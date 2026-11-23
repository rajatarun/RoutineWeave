import fs from "fs";
import path from "path";
import { ExecutionMode, LLMProvider } from "../scheduler/types";
import { logger } from "../utils";

export type RunStatus = "success" | "error";

export interface LocalHistoryEntry {
  taskId: string;
  executionMode: ExecutionMode;
  status: RunStatus;
  latencyMs: number;
  timestamp: string;
  triggerId?: string;
  flowId?: string;
  provider?: LLMProvider;
  model?: string;
  error?: string;
}

export interface ListRunsOptions {
  taskId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface RunStats {
  total: number;
  success: number;
  error: number;
  avgLatencyMs: number;
}

/**
 * Durable, zero-native-dependency JSONL local execution history store.
 * Captures both `llm` and `flow_trigger` runs without requiring AWS services.
 */
export class LocalHistoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath || !filePath.trim()) {
      throw new Error("LocalHistoryStore requires a non-empty filePath");
    }
    this.filePath = path.resolve(filePath);
  }

  getFilePath(): string {
    return this.filePath;
  }

  recordRun(entry: LocalHistoryEntry): void {
    const normalized: LocalHistoryEntry = {
      taskId: entry.taskId,
      executionMode: entry.executionMode,
      status: entry.status,
      latencyMs: Number.isFinite(entry.latencyMs) && entry.latencyMs >= 0 ? entry.latencyMs : 0,
      timestamp: entry.timestamp || new Date().toISOString(),
      ...(entry.triggerId !== undefined ? { triggerId: entry.triggerId } : {}),
      ...(entry.flowId !== undefined ? { flowId: entry.flowId } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, "utf-8");
  }

  listRuns(options: ListRunsOptions = {}): LocalHistoryEntry[] {
    const allEntries = this.readAllEntries();
    let filtered = allEntries;

    if (options.taskId !== undefined) {
      filtered = filtered.filter((entry) => entry.taskId === options.taskId);
    }

    if (options.status !== undefined) {
      filtered = filtered.filter((entry) => entry.status === options.status);
    }

    if (options.limit !== undefined) {
      if (options.limit <= 0) {
        return [];
      }
      if (filtered.length > options.limit) {
        filtered = filtered.slice(-options.limit);
      }
    }

    return filtered;
  }

  getStats(taskId?: string): RunStats {
    const runs = taskId !== undefined ? this.listRuns({ taskId }) : this.readAllEntries();
    const total = runs.length;
    let success = 0;
    let error = 0;
    let latencySum = 0;

    for (const run of runs) {
      if (run.status === "success") {
        success += 1;
      } else {
        error += 1;
      }
      latencySum += run.latencyMs;
    }

    return {
      total,
      success,
      error,
      avgLatencyMs: total === 0 ? 0 : latencySum / total,
    };
  }

  private readAllEntries(): LocalHistoryEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const entries: LocalHistoryEntry[] = [];

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
          logger.warn("Skipping malformed entry in LocalHistoryStore", {
            filePath: this.filePath,
            lineNumber: i + 1,
          });
        }
      } catch {
        logger.warn("Skipping corrupt JSONL line in LocalHistoryStore", {
          filePath: this.filePath,
          lineNumber: i + 1,
        });
      }
    }

    return entries;
  }

  private isValidEntry(value: unknown): value is LocalHistoryEntry {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.taskId === "string" &&
      (obj.executionMode === "llm" || obj.executionMode === "flow_trigger") &&
      (obj.status === "success" || obj.status === "error") &&
      typeof obj.latencyMs === "number" &&
      Number.isFinite(obj.latencyMs) &&
      typeof obj.timestamp === "string"
    );
  }
}
