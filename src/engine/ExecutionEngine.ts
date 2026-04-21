import { TaskDefinition, TaskExecutionResult } from "../scheduler/types";
import { GeminiClient } from "./GeminiClient";
import { PromptRenderer } from "./PromptRenderer";
import { logger } from "../utils";

export class ExecutionEngine {
  private gemini: GeminiClient;
  private renderer: PromptRenderer;

  constructor(gemini: GeminiClient, renderer: PromptRenderer) {
    this.gemini = gemini;
    this.renderer = renderer;
  }

  async execute(task: TaskDefinition): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    logger.info(`Executing task: ${task.task_name}`, { model: task.model });

    try {
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

      const response = await Promise.race([
        this.gemini.generate({ model: task.model, prompt: renderedPrompt, grounding: task.grounding }),
        this.createTimeout(task.timeout_ms),
      ]);

      const duration_ms = Date.now() - startTime;

      logger.info(`Task ${task.task_name} completed`, {
        duration_ms,
        grounding: response.groundingUsed,
        promptTokens: response.promptTokens,
        outputTokens: response.outputTokens,
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

      return {
        task_name: task.task_name,
        timestamp,
        success: false,
        error: message,
        duration_ms,
      };
    }
  }

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms),
    );
  }
}
