import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { S3TaskStore } from "./storage/S3TaskStore";
import { TaskDefinitionSchema } from "./scheduler/types";
import { logger } from "./utils";

const store = new S3TaskStore();

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

// GET /tasks
async function listTasks(): Promise<APIGatewayProxyResultV2> {
  const tasks = await store.list();
  return respond(200, { tasks });
}

// GET /tasks/{taskName}
async function getTask(taskName: string): Promise<APIGatewayProxyResultV2> {
  const task = await store.get(taskName);
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

  const existing = await store.get(result.data.task_name);
  if (existing) {
    return respond(409, { error: `Task "${result.data.task_name}" already exists. Use PUT to update.` });
  }

  await store.put(result.data);
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

  const isNew = (await store.get(taskName)) === null;
  await store.put(result.data);
  return respond(isNew ? 201 : 200, { task: result.data });
}

// DELETE /tasks/{taskName}
async function deleteTask(taskName: string): Promise<APIGatewayProxyResultV2> {
  const deleted = await store.delete(taskName);
  if (!deleted) return respond(404, { error: `Task "${taskName}" not found` });
  return respond(200, { message: `Task "${taskName}" deleted` });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method as HttpMethod;
  const taskName = event.pathParameters?.taskName;

  logger.info("API request", { method, path: event.rawPath, taskName });

  try {
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
    logger.error("API handler error", { error: message, method, path: event.rawPath });
    return respond(500, { error: "Internal server error" });
  }
}
