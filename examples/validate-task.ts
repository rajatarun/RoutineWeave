/**
 * Validate a task JSON file against the Zod schema (offline).
 *
 *   npx ts-node examples/validate-task.ts tasks/ai_news_digest.json
 */
import { readFileSync } from "node:fs";
import { TaskDefinitionSchema } from "../src/scheduler/types";

const path = process.argv[2] ?? "tasks/ai_news_digest.json";
const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;

const parsed = TaskDefinitionSchema.safeParse(raw);

if (!parsed.success) {
  console.error(`Invalid task: ${path}`);
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`OK: ${parsed.data.task_name} (schedule: ${parsed.data.schedule})`);
