import cron from "node-cron";
import { TaskDefinition } from "./types";
import { logger } from "../utils";

export type JobHandler = (task: TaskDefinition) => Promise<void>;

interface RegisteredJob {
  task: TaskDefinition;
  cronTask: cron.ScheduledTask;
}

export class JobRegistry {
  private jobs = new Map<string, RegisteredJob>();

  register(task: TaskDefinition, handler: JobHandler): void {
    if (!task.enabled) {
      logger.info(`Skipping disabled task: ${task.task_name}`);
      return;
    }

    if (!cron.validate(task.schedule)) {
      logger.error(`Invalid cron expression for task "${task.task_name}"`, { schedule: task.schedule });
      return;
    }

    if (this.jobs.has(task.task_name)) {
      logger.warn(`Task "${task.task_name}" is already registered; replacing`);
      this.unregister(task.task_name);
    }

    const cronTask = cron.schedule(task.schedule, async () => {
      logger.info(`Triggering task: ${task.task_name}`, { schedule: task.schedule });
      try {
        await handler(task);
      } catch (error) {
        logger.error(`Unhandled error in task "${task.task_name}"`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.jobs.set(task.task_name, { task, cronTask });
    logger.info(`Registered task: ${task.task_name}`, { schedule: task.schedule });
  }

  unregister(taskName: string): void {
    const job = this.jobs.get(taskName);
    if (job) {
      job.cronTask.stop();
      this.jobs.delete(taskName);
      logger.info(`Unregistered task: ${taskName}`);
    }
  }

  startAll(): void {
    logger.info(`Starting ${this.jobs.size} scheduled job(s)`);
    for (const [name, job] of this.jobs) {
      job.cronTask.start();
      logger.info(`Started: ${name}`, { schedule: job.task.schedule });
    }
  }

  stopAll(): void {
    logger.info("Stopping all scheduled jobs");
    for (const [, job] of this.jobs) {
      job.cronTask.stop();
    }
  }

  listTasks(): TaskDefinition[] {
    return Array.from(this.jobs.values()).map((j) => j.task);
  }

  size(): number {
    return this.jobs.size;
  }
}
