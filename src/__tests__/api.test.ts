import { APIGatewayProxyEventV2 } from "aws-lambda";

const mockList = jest.fn();
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

const mockResultList = jest.fn();
const mockResultGetByKey = jest.fn();

jest.mock("../storage/S3TaskStore", () => ({
  S3TaskStore: jest.fn().mockImplementation(() => ({
    list: mockList,
    get: mockGet,
    put: mockPut,
    delete: mockDelete,
  })),
}));

jest.mock("../storage/S3ResultStore", () => ({
  S3ResultStore: jest.fn().mockImplementation(() => ({
    list: mockResultList,
    getByKey: mockResultGetByKey,
  })),
}));

// Must import after mocks are registered
import { handler } from "../api";
import { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

function asResult(r: unknown): APIGatewayProxyStructuredResultV2 {
  return r as APIGatewayProxyStructuredResultV2;
}

const validTask = {
  task_name: "my_task",
  schedule: "0 * * * *",
  prompt: "Test",
  model: "gemini-3.1-flash-lite-preview",
  grounding: false,
  enabled: true,
  save_result: false,
  timeout_ms: 60000,
  output: { type: "sns" as const },
};

function makeEvent(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
  query?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method, path } },
    rawPath: path,
    pathParameters: params,
    queryStringParameters: query,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  } as unknown as APIGatewayProxyEventV2;
}

describe("API handler — tasks", () => {
  beforeEach(() => jest.clearAllMocks());

  it("GET /tasks returns 200 with task list", async () => {
    mockList.mockResolvedValue([validTask]);
    const res = await handler(makeEvent("GET", "/tasks"));
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.tasks).toHaveLength(1);
  });

  it("GET /tasks/{taskName} returns 200 for existing task", async () => {
    mockGet.mockResolvedValue(validTask);
    const res = await handler(makeEvent("GET", "/tasks/my_task", { taskName: "my_task" }));
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.task.task_name).toBe("my_task");
  });

  it("GET /tasks/{taskName} returns 404 for missing task", async () => {
    mockGet.mockResolvedValue(null);
    const res = await handler(makeEvent("GET", "/tasks/ghost", { taskName: "ghost" }));
    expect(asResult(res).statusCode).toBe(404);
  });

  it("POST /tasks returns 201 for new valid task", async () => {
    mockGet.mockResolvedValue(null);
    mockPut.mockResolvedValue(undefined);
    const res = await handler(makeEvent("POST", "/tasks", undefined, validTask));
    expect(asResult(res).statusCode).toBe(201);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ task_name: "my_task" }));
  });

  it("POST /tasks stores save_result flag", async () => {
    mockGet.mockResolvedValue(null);
    mockPut.mockResolvedValue(undefined);
    const task = { ...validTask, save_result: true };
    const res = await handler(makeEvent("POST", "/tasks", undefined, task));
    expect(asResult(res).statusCode).toBe(201);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ save_result: true }));
  });

  it("POST /tasks returns 409 for duplicate task", async () => {
    mockGet.mockResolvedValue(validTask);
    const res = await handler(makeEvent("POST", "/tasks", undefined, validTask));
    expect(asResult(res).statusCode).toBe(409);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("POST /tasks returns 400 for invalid body", async () => {
    const res = await handler(makeEvent("POST", "/tasks", undefined, { bad: "data" }));
    expect(asResult(res).statusCode).toBe(400);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.details).toBeDefined();
  });

  it("PUT /tasks/{taskName} updates save_result flag", async () => {
    mockGet.mockResolvedValue(validTask);
    mockPut.mockResolvedValue(undefined);
    const payload = { ...validTask, save_result: true };
    const res = await handler(makeEvent("PUT", "/tasks/my_task", { taskName: "my_task" }, payload));
    expect(asResult(res).statusCode).toBe(200);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ save_result: true, task_name: "my_task" }));
  });

  it("PUT /tasks/{taskName} uses path param as authoritative task_name", async () => {
    mockGet.mockResolvedValue(validTask);
    mockPut.mockResolvedValue(undefined);
    const payload = { ...validTask, task_name: "ignored_name" };
    const res = await handler(makeEvent("PUT", "/tasks/my_task", { taskName: "my_task" }, payload));
    expect(asResult(res).statusCode).toBe(200);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ task_name: "my_task" }));
  });

  it("DELETE /tasks/{taskName} returns 200 on success", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await handler(makeEvent("DELETE", "/tasks/my_task", { taskName: "my_task" }));
    expect(asResult(res).statusCode).toBe(200);
  });

  it("DELETE /tasks/{taskName} returns 404 when task missing", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await handler(makeEvent("DELETE", "/tasks/ghost", { taskName: "ghost" }));
    expect(asResult(res).statusCode).toBe(404);
  });

  it("returns 405 for unsupported method on /tasks", async () => {
    const res = await handler(makeEvent("PATCH", "/tasks"));
    expect(asResult(res).statusCode).toBe(405);
  });
});

describe("API handler — results", () => {
  beforeEach(() => jest.clearAllMocks());

  it("GET /results/{taskName} returns results when save_result is true", async () => {
    mockGet.mockResolvedValue({ ...validTask, save_result: true });
    mockResultList.mockResolvedValue([
      { key: "my_task/2024-01-15/2024-01-15T08-00-00-000Z.json", task_name: "my_task", date: "2024-01-15", timestamp: "2024-01-15T08:00:00.000Z", size_bytes: 512 },
    ]);
    const res = await handler(makeEvent("GET", "/results/my_task", { taskName: "my_task" }));
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.results).toHaveLength(1);
  });

  it("GET /results/{taskName} returns empty when save_result is false", async () => {
    mockGet.mockResolvedValue({ ...validTask, save_result: false });
    const res = await handler(makeEvent("GET", "/results/my_task", { taskName: "my_task" }));
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.results).toHaveLength(0);
    expect(body.save_result).toBe(false);
    expect(mockResultList).not.toHaveBeenCalled();
  });

  it("GET /results/{taskName} returns 404 when task not found", async () => {
    mockGet.mockResolvedValue(null);
    const res = await handler(makeEvent("GET", "/results/ghost", { taskName: "ghost" }));
    expect(asResult(res).statusCode).toBe(404);
  });

  it("GET /results/{taskName} passes date query param to result store", async () => {
    mockGet.mockResolvedValue({ ...validTask, save_result: true });
    mockResultList.mockResolvedValue([]);
    const res = await handler(
      makeEvent("GET", "/results/my_task", { taskName: "my_task" }, undefined, { date: "2024-01-15" }),
    );
    expect(asResult(res).statusCode).toBe(200);
    expect(mockResultList).toHaveBeenCalledWith("my_task", "2024-01-15");
  });

  it("GET /results/{taskName}/{date}/{filename} returns result", async () => {
    const mockResult = { task_name: "my_task", timestamp: "2024-01-15T08:00:00.000Z", success: true, result: "output", duration_ms: 500 };
    mockResultGetByKey.mockResolvedValue(mockResult);
    const res = await handler(
      makeEvent("GET", "/results/my_task/2024-01-15/2024-01-15T08-00-00-000Z.json", {
        taskName: "my_task",
        date: "2024-01-15",
        filename: "2024-01-15T08-00-00-000Z.json",
      }),
    );
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.result.task_name).toBe("my_task");
  });

  it("GET /results/{taskName}/{date}/{filename} returns 404 for missing result", async () => {
    mockResultGetByKey.mockResolvedValue(null);
    const res = await handler(
      makeEvent("GET", "/results/my_task/2024-01-15/missing.json", {
        taskName: "my_task",
        date: "2024-01-15",
        filename: "missing.json",
      }),
    );
    expect(asResult(res).statusCode).toBe(404);
  });
});
