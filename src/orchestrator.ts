import { TaskDefinition, TaskExecutionResult } from "./scheduler/types";
import { ExecutionEngine } from "./engine/ExecutionEngine";
import { GeminiClient } from "./engine/GeminiClient";
import { PromptRenderer } from "./engine/PromptRenderer";
import { OutputRouter } from "./output/OutputRouter";
import { logger } from "./utils";

export class Orchestrator {
  private engine: ExecutionEngine;
  private router: OutputRouter;

  constructor() {
    const gemini = new GeminiClient();
    const renderer = new PromptRenderer();
    this.engine = new ExecutionEngine(gemini, renderer);
    this.router = new OutputRouter();
  }

  async runTask(task: TaskDefinition): Promise<TaskExecutionResult> {
    logger.info(`[Orchestrator] Starting task: ${task.task_name}`);

    const result = await this.engine.execute(task);

    try {
      await this.router.route(result, task.output);
    } catch (routeError) {
      logger.error(`[Orchestrator] Output routing failed for task: ${task.task_name}`, {
        error: routeError instanceof Error ? routeError.message : String(routeError),
      });
    }

    return result;
  }

  async runTasks(tasks: TaskDefinition[]): Promise<TaskExecutionResult[]> {
    logger.info(`[Orchestrator] Running ${tasks.length} task(s)`);

    const results = await Promise.allSettled(tasks.map((t) => this.runTask(t)));

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        task_name: tasks[i].task_name,
        timestamp: new Date().toISOString(),
        success: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        duration_ms: 0,
      };
    });
  }
}
