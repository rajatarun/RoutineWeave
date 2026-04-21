import { TaskExecutionResult } from "../scheduler/types";

export interface OutputPayload {
  task: string;
  timestamp: string;
  result: string;
  success: boolean;
  duration_ms: number;
  error?: string;
}

export interface OutputHandler {
  name: string;
  publish(payload: OutputPayload, config: Record<string, unknown>): Promise<void>;
}

export function buildPayload(result: TaskExecutionResult): OutputPayload {
  return {
    task: result.task_name,
    timestamp: result.timestamp,
    result: result.result ?? result.error ?? "No output",
    success: result.success,
    duration_ms: result.duration_ms,
    ...(result.error ? { error: result.error } : {}),
  };
}
