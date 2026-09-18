/**
 * The shipped task definitions are data, and nothing else in the suite reads
 * them. Two failure modes are silent at runtime: a definition the Zod schema
 * rejects is logged and skipped (the task simply never runs), and a misspelled
 * placeholder is left verbatim in the prompt, so the model is asked about
 * "{{topics}}" and answers anyway.
 */
process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:test-topic";

import fs from "fs";
import path from "path";
import { TaskDefinitionSchema } from "../scheduler/types";
import { PromptRenderer } from "../engine/PromptRenderer";

const TASKS_DIR = path.resolve(__dirname, "../../tasks");
const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));

describe("shipped task definitions", () => {
  it("finds task files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s parses against the task schema", (file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
    const parsed = TaskDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n"));
    }
  });

  it.each(files)("%s leaves no unresolved placeholder in its prompt", (file) => {
    const task = TaskDefinitionSchema.parse(JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8")));
    const renderer = new PromptRenderer();
    const merged = { ...renderer.injectDefaults(task.variables), ...(task.input ?? {}) };
    const rendered = renderer.render(task.prompt, merged);
    expect(rendered.match(/\{\{\s*[\w.]+\s*\}\}/g)).toBeNull();
  });
});

describe("linkedin_topic_scout", () => {
  const task = TaskDefinitionSchema.parse(
    JSON.parse(fs.readFileSync(path.join(TASKS_DIR, "linkedin_topic_scout.json"), "utf-8")),
  );

  it("has search grounding on", () => {
    // Without it the model reports what was trending when it was trained,
    // which is the whole defect this task exists to avoid.
    expect(task.grounding).toBe(true);
  });

  it("anchors the prompt to the current date", () => {
    expect(task.prompt).toContain("{{current_date}}");
  });

  it("runs before the orchestrator generates drafts at 15:15 UTC on Monday", () => {
    const [minute, hour, , , dow] = task.schedule.split(/\s+/);
    expect(dow).toBe("1");
    expect(Number(hour) * 60 + Number(minute)).toBeLessThan(15 * 60 + 15);
  });

  it("asks for the four fields the content orchestrator consumes", () => {
    // put_article persists `title` and `sourceInputs`; generate_drafts_handler
    // then reads them back as the topic and the objective. A field missing
    // here becomes an empty draft brief downstream.
    for (const field of ["title", "topic", "objective", "sourceInputs"]) {
      expect(task.prompt).toContain(`"${field}"`);
    }
  });

  it("posts the result to a webhook rather than an SNS topic", () => {
    // SNS would deliver the JSON to a mailbox; the article has to be created.
    expect(task.output.type).toBe("webhook");
  });

  it("ships no real credentials in its headers", () => {
    const headers = (task.output as { headers?: Record<string, string> }).headers ?? {};
    for (const value of Object.values(headers)) {
      expect(value).toContain("REPLACE_ME");
    }
  });
});
