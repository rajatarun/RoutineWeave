import fs from "fs";
import os from "os";
import path from "path";
import { TaskLoader } from "../scheduler/TaskLoader";

const validTask = {
  task_name: "test_task",
  schedule: "0 * * * *",
  prompt: "Test prompt",
  model: "gemini-1.5-pro",
  output: {
    type: "sns",
    sns_topic_arn: "arn:aws:sns:us-east-1:123456789:test",
  },
};

describe("TaskLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid task files", () => {
    fs.writeFileSync(path.join(tmpDir, "task1.json"), JSON.stringify(validTask));
    const loader = new TaskLoader(tmpDir);
    const tasks = loader.loadAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_name).toBe("test_task");
  });

  it("applies default model value", () => {
    const task = { ...validTask };
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify(task));
    const loader = new TaskLoader(tmpDir);
    const tasks = loader.loadAll();
    expect(tasks[0].model).toBe("gemini-1.5-pro");
  });

  it("returns empty array for missing directory", () => {
    const loader = new TaskLoader("/nonexistent/path");
    const tasks = loader.loadAll();
    expect(tasks).toHaveLength(0);
  });

  it("skips invalid task files and loads valid ones", () => {
    fs.writeFileSync(path.join(tmpDir, "invalid.json"), JSON.stringify({ bad: "data" }));
    fs.writeFileSync(path.join(tmpDir, "valid.json"), JSON.stringify(validTask));
    const loader = new TaskLoader(tmpDir);
    const tasks = loader.loadAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_name).toBe("test_task");
  });

  it("rejects task_name with invalid characters", () => {
    const invalid = { ...validTask, task_name: "My Task!" };
    const loader = new TaskLoader(tmpDir);
    expect(() => loader.loadInline(invalid)).toThrow();
  });


  it("accepts sns output without per-task topic ARN", () => {
    const loader = new TaskLoader(tmpDir);
    const taskWithoutTopic = {
      ...validTask,
      output: {
        type: "sns" as const,
      },
    };

    const task = loader.loadInline(taskWithoutTopic);
    expect(task.output.type).toBe("sns");
    expect((task.output as { sns_topic_arn?: string }).sns_topic_arn).toBeUndefined();
  });

  it("applies enabled:true by default", () => {
    const loader = new TaskLoader(tmpDir);
    const task = loader.loadInline(validTask);
    expect(task.enabled).toBe(true);
  });
});
