import { TaskDefinition, TaskExecutionResult } from "../scheduler/types";
import { GeminiClient } from "./GeminiClient";
import { PromptRenderer } from "./PromptRenderer";
import { FlowTriggerClient } from "./FlowTriggerClient";
import { OpenAICompatClient } from "./OpenAICompatClient";
import { LocalHistoryEntry, LocalHistoryStore } from "../storage/LocalHistoryStore";
import { logger } from "../utils";

export interface ExecutionEngineOptions {
  flowTriggerClient?: FlowTriggerClient;
  openAICompatClient?: OpenAICompatClient;
  historyStore?: LocalHistoryStore;
}

export class ExecutionEngine {
  private gemini: GeminiClient;
  private renderer: PromptRenderer;
  private flowTriggerClient: FlowTriggerClient;
  private openAICompatClient: OpenAICompatClient;
  private historyStore?: LocalHistoryStore;

  constructor(
    gemini: GeminiClient,
    renderer: PromptRenderer,
    options: ExecutionEngineOptions = {},
  ) {
    this.gemini = gemini;
    this.renderer = renderer;
    this.flowTriggerClient = options.flowTriggerClient ?? new FlowTriggerClient();
    this.openAICompatClient = options.openAICompatClient ?? new OpenAICompatClient();
    this.historyStore = options.historyStore;
  }

  async execute(task: TaskDefinition): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    const mode = task.executionMode ?? "llm";

    logger.info(`Executing task: ${task.task_name}`, {
      mode,
      provider: mode === "llm" ? (task.provider ?? "gemini") : undefined,
      model: mode === "llm" ? task.model : undefined,
    });

    try {
      if (mode === "flow_trigger") {
        if (!task.flowTrigger) {
          throw new Error(`Task ${task.task_name} is in flow_trigger mode but missing flowTrigger config`);
        }

        const timeoutMs = task.flowTrigger.timeoutMs ?? task.timeout_ms;
        const dispatchResponse = await this.withTimeout(
          this.flowTriggerClient.dispatch({
            taskId: task.task_name,
            config: task.flowTrigger,
            firedAt: timestamp,
            extraInputs: task.input,
            maxRetries: task.max_retries,
          }),
          timeoutMs,
        );

        const duration_ms = Date.now() - startTime;

        logger.info(`Flow trigger task ${task.task_name} completed`, {
          duration_ms,
          flowId: dispatchResponse.flowId,
          triggerId: dispatchResponse.triggerId,
          status: dispatchResponse.status,
        });

        this.recordHistory({
          taskId: task.task_name,
          executionMode: "flow_trigger",
          status: "success",
          latencyMs: duration_ms,
          timestamp,
          triggerId: dispatchResponse.triggerId,
          flowId: dispatchResponse.flowId,
        });

        return {
          task_name: task.task_name,
          timestamp,
          success: true,
          result:
            dispatchResponse.body ||
            JSON.stringify({
              schema: "weave-trigger-v1",
              trigger_id: dispatchResponse.triggerId,
              flow_id: dispatchResponse.flowId,
              status: dispatchResponse.status,
            }),
          structured_result: dispatchResponse.json,
          duration_ms,
        };
      }

      // Merge: system defaults < variables (strings) < input (strings or arrays)
      // input values take highest precedence and may be lists (JSON.stringify'd on injection)
      const merged = {
        ...this.renderer.injectDefaults(task.variables),
        ...(task.input ?? {}),
      };
      const renderedPrompt = this.renderer.render(task.prompt, merged);

      logger.debug(`Rendered prompt for ${task.task_name}`, {
        promptLength: renderedPrompt.length,
      });

      const provider = task.provider ?? "gemini";
      const response =
        provider === "openai_compat"
          ? await this.withTimeout(
              this.openAICompatClient.generate({
                model: task.model,
                prompt: renderedPrompt,
                baseUrl: task.providerConfig?.baseUrl,
                apiKeyEnv: task.providerConfig?.apiKeyEnv,
                systemPrompt: task.providerConfig?.systemPrompt,
                temperature: task.providerConfig?.temperature,
                maxTokens: task.providerConfig?.maxTokens,
                timeoutMs: task.timeout_ms,
                maxRetries: task.max_retries,
              }),
              task.timeout_ms,
            )
          : await this.withTimeout(
              this.gemini.generate({
                model: task.model,
                prompt: renderedPrompt,
                grounding: task.grounding,
              }),
              task.timeout_ms,
            );

      const duration_ms = Date.now() - startTime;

      logger.info(`Task ${task.task_name} completed`, {
        duration_ms,
        provider,
        grounding: response.groundingUsed,
        promptTokens: response.promptTokens,
        outputTokens: response.outputTokens,
      });

      this.recordHistory({
        taskId: task.task_name,
        executionMode: "llm",
        status: "success",
        latencyMs: duration_ms,
        timestamp,
        provider,
        model: task.model,
      });

      return {
        task_name: task.task_name,
        timestamp,
        success: true,
        result: response.text,
        duration_ms,
      };
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      logger.error(`Task ${task.task_name} failed`, { error: message, duration_ms });

      this.recordHistory({
        taskId: task.task_name,
        executionMode: mode,
        status: "error",
        latencyMs: duration_ms,
        timestamp,
        flowId: mode === "flow_trigger" ? task.flowTrigger?.flowId : undefined,
        provider: mode === "llm" ? (task.provider ?? "gemini") : undefined,
        model: mode === "llm" ? task.model : undefined,
        error: message,
      });

      return {
        task_name: task.task_name,
        timestamp,
        success: false,
        error: message,
        duration_ms,
      };
    }
  }

  private recordHistory(entry: LocalHistoryEntry): void {
    if (!this.historyStore) {
      return;
    }
    try {
      this.historyStore.recordRun(entry);
    } catch (err) {
      logger.warn("Failed to record execution history entry", {
        taskId: entry.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
