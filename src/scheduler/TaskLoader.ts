import fs from "fs";
import path from "path";
import { TaskDefinition, TaskDefinitionSchema } from "./types";
import { logger } from "../utils";

export class TaskLoader {
  private tasksDir: string;

  constructor(tasksDir: string) {
    this.tasksDir = path.resolve(tasksDir);
  }

  loadAll(): TaskDefinition[] {
    if (!fs.existsSync(this.tasksDir)) {
      logger.warn("Tasks directory not found", { tasksDir: this.tasksDir });
      return [];
    }

    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));

    const tasks: TaskDefinition[] = [];
    for (const file of files) {
      const task = this.loadFile(path.join(this.tasksDir, file));
      if (task) tasks.push(task);
    }

    logger.info(`Loaded ${tasks.length} task(s)`, { tasksDir: this.tasksDir });
    return tasks;
  }

  loadFile(filePath: string): TaskDefinition | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(raw);
      const result = TaskDefinitionSchema.safeParse(json);

      if (!result.success) {
        logger.error("Invalid task definition", {
          file: filePath,
          errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        });
        return null;
      }

      return result.data;
    } catch (error) {
      logger.error("Failed to load task file", {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  loadInline(raw: unknown): TaskDefinition {
    const result = TaskDefinitionSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid task definition: ${result.error.message}`);
    }
    return result.data;
  }
}
