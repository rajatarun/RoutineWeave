/**
 * Local development runner using node-cron for in-process scheduling.
 * In production, EventBridge triggers the Lambda handler directly.
 */
import { JobRegistry } from "./scheduler/JobRegistry";
import { TaskLoader } from "./scheduler/TaskLoader";
import { Orchestrator } from "./orchestrator";
import { logger } from "./utils";
import { env } from "./config";

async function main(): Promise<void> {
  logger.info("RoutineWeave starting (local mode)", { tasksDir: env.TASKS_DIR });

  const loader = new TaskLoader(env.TASKS_DIR);
  const registry = new JobRegistry();
  const orchestrator = new Orchestrator();

  const tasks = loader.loadAll();

  if (tasks.length === 0) {
    logger.warn("No tasks loaded. Add JSON task files to the tasks/ directory.");
    return;
  }

  for (const task of tasks) {
    registry.register(task, async (t) => {
      await orchestrator.runTask(t);
    });
  }

  registry.startAll();

  logger.info(`Scheduler running with ${registry.size()} job(s). Press Ctrl+C to stop.`);

  process.on("SIGINT", () => {
    logger.info("Shutting down scheduler...");
    registry.stopAll();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down...");
    registry.stopAll();
    process.exit(0);
  });

  // Keep process alive
  await new Promise<void>(() => {});
}

main().catch((error) => {
  logger.error("Fatal error in local runner", { error: (error as Error).message });
  process.exit(1);
});
