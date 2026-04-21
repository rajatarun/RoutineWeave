import { S3TaskStore } from "./storage/S3TaskStore";
import { EventBridgeManager } from "./events/EventBridgeManager";
import { logger } from "./utils";
import { env } from "./config";

interface S3ObjectEvent {
  source: string;
  "detail-type": "Object Created" | "Object Deleted";
  detail: {
    bucket: { name: string };
    object: { key: string };
  };
}

const store = new S3TaskStore();
const ebManager = new EventBridgeManager();

export async function handler(event: S3ObjectEvent): Promise<void> {
  const { "detail-type": detailType, detail } = event;
  const { key } = detail.object;

  const prefix = env.TASKS_S3_PREFIX;

  if (!key.startsWith(prefix) || !key.endsWith(".json")) {
    logger.debug("Ignoring non-task S3 event", { key });
    return;
  }

  const taskName = key.slice(prefix.length, -".json".length);

  logger.info(`Registrar handling S3 event`, { detailType, taskName, key });

  if (detailType === "Object Created") {
    const task = await store.get(taskName);
    if (!task) {
      logger.warn(`Task "${taskName}" not found in S3 after creation event; skipping`);
      return;
    }
    await ebManager.upsertRule(task);
    logger.info(`Cron rule registered for task: ${taskName}`, { schedule: task.schedule });
  } else if (detailType === "Object Deleted") {
    await ebManager.deleteRule(taskName);
    logger.info(`Cron rule deleted for task: ${taskName}`);
  } else {
    logger.warn(`Unknown S3 event type: ${detailType}`);
  }
}
