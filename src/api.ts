import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { S3TaskStore } from "./storage/S3TaskStore";
import { S3ResultStore } from "./storage/S3ResultStore";
import { TaskDefinitionSchema } from "./scheduler/types";
import { logger } from "./utils";

const taskStore = new S3TaskStore();
const resultStore = new S3ResultStore();

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function methodNotAllowed(): APIGatewayProxyResultV2 {
  return respond(405, { error: "Method not allowed" });
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────

// GET /tasks
async function listTasks(): Promise<APIGatewayProxyResultV2> {
  const tasks = await taskStore.list();
  return respond(200, { tasks });
}

// GET /tasks/{taskName}
async function getTask(taskName: string): Promise<APIGatewayProxyResultV2> {
  const task = await taskStore.get(taskName);
  if (!task) return respond(404, { error: `Task "${taskName}" not found` });
  return respond(200, { task });
}

// POST /tasks
async function createTask(body: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!body) return respond(400, { error: "Request body is required" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const result = TaskDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    return respond(400, {
      error: "Validation failed",
      details: result.error.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
    });
  }

  const existing = await taskStore.get(result.data.task_name);
  if (existing) {
    return respond(409, { error: `Task "${result.data.task_name}" already exists. Use PUT to update.` });
  }

  await taskStore.put(result.data);
  return respond(201, { task: result.data });
}

// PUT /tasks/{taskName}
async function updateTask(taskName: string, body: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!body) return respond(400, { error: "Request body is required" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  // Enforce path param as authoritative task_name
  if (typeof parsed === "object" && parsed !== null) {
    (parsed as Record<string, unknown>).task_name = taskName;
  }

  const result = TaskDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    return respond(400, {
      error: "Validation failed",
      details: result.error.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
    });
  }

  const isNew = (await taskStore.get(taskName)) === null;
  await taskStore.put(result.data);
  return respond(isNew ? 201 : 200, { task: result.data });
}

// DELETE /tasks/{taskName}
async function deleteTask(taskName: string): Promise<APIGatewayProxyResultV2> {
  const deleted = await taskStore.delete(taskName);
  if (!deleted) return respond(404, { error: `Task "${taskName}" not found` });
  return respond(200, { message: `Task "${taskName}" deleted` });
}

// ── Results ───────────────────────────────────────────────────────────────────

// GET /results/{taskName}?date=YYYY-MM-DD
async function listResults(
  taskName: string,
  date?: string,
): Promise<APIGatewayProxyResultV2> {
  const task = await taskStore.get(taskName);
  if (!task) return respond(404, { error: `Task "${taskName}" not found` });
  if (!task.save_result) {
    return respond(200, { task_name: taskName, save_result: false, results: [] });
  }
  const results = await resultStore.list(taskName, date);
  return respond(200, { task_name: taskName, date: date ?? null, results });
}

// GET /results/{taskName}/{date}/{filename}
async function getResult(
  taskName: string,
  date: string,
  filename: string,
): Promise<APIGatewayProxyResultV2> {
  const key = `${taskName}/${date}/${filename}`;
  const result = await resultStore.getByKey(key);
  if (!result) return respond(404, { error: `Result not found: ${key}` });
  return respond(200, { result });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method as HttpMethod;
  const taskName = event.pathParameters?.taskName;
  const date = event.pathParameters?.date;
  const filename = event.pathParameters?.filename;
  const rawPath = event.rawPath;

  logger.info("API request", { method, path: rawPath, taskName });

  try {
    // /results/{taskName}/{date}/{filename}
    if (rawPath.startsWith("/results/") && taskName && date && filename) {
      if (method === "GET") return await getResult(taskName, date, filename);
      return methodNotAllowed();
    }

    // /results/{taskName}
    if (rawPath.startsWith("/results/") && taskName) {
      if (method === "GET") return await listResults(taskName, event.queryStringParameters?.date);
      return methodNotAllowed();
    }

    // /tasks/{taskName}
    if (taskName) {
      if (method === "GET") return await getTask(taskName);
      if (method === "PUT") return await updateTask(taskName, event.body);
      if (method === "DELETE") return await deleteTask(taskName);
      return methodNotAllowed();
    }

    // /tasks
    if (method === "GET") return await listTasks();
    if (method === "POST") return await createTask(event.body);
    return methodNotAllowed();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("API handler error", { error: message, method, path: rawPath });
    return respond(500, { error: "Internal server error" });
  }
}
