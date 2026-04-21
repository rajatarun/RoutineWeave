import { APIGatewayProxyEventV2 } from "aws-lambda";

const mockList = jest.fn();
const mockGet = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock("../storage/S3TaskStore", () => ({
  S3TaskStore: jest.fn().mockImplementation(() => ({
    list: mockList,
    get: mockGet,
    put: mockPut,
    delete: mockDelete,
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
  timeout_ms: 60000,
  output: { type: "sns" as const, sns_topic_arn: "arn:aws:sns:us-east-1:123:test" },
};

function makeEvent(
  method: string,
  path: string,
  taskName?: string,
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method, path } },
    rawPath: path,
    pathParameters: taskName ? { taskName } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  } as unknown as APIGatewayProxyEventV2;
}

describe("API handler", () => {
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
    const res = await handler(makeEvent("GET", "/tasks/my_task", "my_task"));
    expect(asResult(res).statusCode).toBe(200);
    const body = JSON.parse(asResult(res).body as string);
    expect(body.task.task_name).toBe("my_task");
  });

  it("GET /tasks/{taskName} returns 404 for missing task", async () => {
    mockGet.mockResolvedValue(null);
    const res = await handler(makeEvent("GET", "/tasks/ghost", "ghost"));
    expect(asResult(res).statusCode).toBe(404);
  });

  it("POST /tasks returns 201 for new valid task", async () => {
    mockGet.mockResolvedValue(null);
    mockPut.mockResolvedValue(undefined);
    const res = await handler(makeEvent("POST", "/tasks", undefined, validTask));
    expect(asResult(res).statusCode).toBe(201);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ task_name: "my_task" }));
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

  it("PUT /tasks/{taskName} updates existing task with path name as authoritative", async () => {
    mockGet.mockResolvedValue(validTask);
    mockPut.mockResolvedValue(undefined);
    const payload = { ...validTask, task_name: "ignored_name" };
    const res = await handler(makeEvent("PUT", "/tasks/my_task", "my_task", payload));
    expect(asResult(res).statusCode).toBe(200);
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ task_name: "my_task" }));
  });

  it("DELETE /tasks/{taskName} returns 200 on success", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await handler(makeEvent("DELETE", "/tasks/my_task", "my_task"));
    expect(asResult(res).statusCode).toBe(200);
  });

  it("DELETE /tasks/{taskName} returns 404 when task missing", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await handler(makeEvent("DELETE", "/tasks/ghost", "ghost"));
    expect(asResult(res).statusCode).toBe(404);
  });

  it("returns 405 for unsupported method on /tasks", async () => {
    const res = await handler(makeEvent("PATCH", "/tasks"));
    expect(asResult(res).statusCode).toBe(405);
  });
});
