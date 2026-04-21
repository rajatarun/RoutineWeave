import { Context } from "aws-lambda";
import { TaskLoader } from "./scheduler/TaskLoader";
import { Orchestrator } from "./orchestrator";
import { logger } from "./utils";
import { env } from "./config";

interface EventBridgeEvent {
  source?: string;
  "detail-type"?: string;
  detail?: {
    task_name?: string;
  };
}

const taskLoader = new TaskLoader(env.TASKS_DIR);
const orchestrator = new Orchestrator();

export async function handler(event: EventBridgeEvent, context: Context): Promise<void> {
  logger.info("Lambda invoked", {
    requestId: context.awsRequestId,
    remainingMs: context.getRemainingTimeInMillis(),
    source: event.source,
    detailType: event["detail-type"],
  });

  const tasks = taskLoader.loadAll().filter((t) => t.enabled);

  if (tasks.length === 0) {
    logger.warn("No enabled tasks found");
    return;
  }

  // If EventBridge passes a specific task name in detail, run only that task
  const targetTaskName = event.detail?.task_name;
  const tasksToRun = targetTaskName ? tasks.filter((t) => t.task_name === targetTaskName) : tasks;

  if (targetTaskName && tasksToRun.length === 0) {
    logger.warn(`No task found with name: ${targetTaskName}`);
    return;
  }

  const results = await orchestrator.runTasks(tasksToRun);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info("Lambda execution complete", {
    total: results.length,
    succeeded,
    failed,
    requestId: context.awsRequestId,
  });

  if (failed > 0) {
    const failures = results.filter((r) => !r.success).map((r) => r.task_name);
    logger.error("Some tasks failed", { failures });
  }
}
