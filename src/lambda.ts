import { Context } from "aws-lambda";
import { S3TaskStore } from "./storage/S3TaskStore";
import { Orchestrator } from "./orchestrator";
import { logger } from "./utils";

interface EventBridgeEvent {
  source?: string;
  "detail-type"?: string;
  detail?: {
    task_name?: string;
  };
}

const store = new S3TaskStore();
const orchestrator = new Orchestrator();

export async function handler(event: EventBridgeEvent, context: Context): Promise<void> {
  logger.info("Scheduler Lambda invoked", {
    requestId: context.awsRequestId,
    remainingMs: context.getRemainingTimeInMillis(),
    source: event.source,
    detailType: event["detail-type"],
  });

  const allTasks = await store.list();
  const tasks = allTasks.filter((t) => t.enabled);

  if (tasks.length === 0) {
    logger.warn("No enabled tasks found in S3");
    return;
  }

  const targetTaskName = event.detail?.task_name;
  const tasksToRun = targetTaskName ? tasks.filter((t) => t.task_name === targetTaskName) : tasks;

  if (targetTaskName && tasksToRun.length === 0) {
    logger.warn(`No enabled task found with name: ${targetTaskName}`);
    return;
  }

  const results = await orchestrator.runTasks(tasksToRun);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info("Scheduler execution complete", {
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
