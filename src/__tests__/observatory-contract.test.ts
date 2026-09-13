// Conformance test for the shared OBSERVATORY_METRICS table contract
// (contracts/observatory_metrics_item.json, canonical home mcp-observatory).
//
// RoutineWeave is one of several writers to that shared DynamoDB table, in two
// languages, read by dashboards in repositories that cannot see this code. The
// item shape is therefore a cross-repository interface, and the only thing
// keeping it honest is that each repository asserts its own writer against the
// vendored contract. This file does that for RoutineWeave: it drives the REAL
// ObservatoryMetricsStore.persist() path with the DynamoDB client mocked,
// captures the actual PutItemCommand Item, and checks it with the same I1-I4
// checks the Python siblings run (contracts/conformance.ts ports conformance.py).
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { checkItem, readersFor, loadContract } from "../../contracts/conformance";
import type { SpanData, DecisionData } from "../storage/ObservatoryMetricsStore";

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

jest.mock("../config", () => ({
  env: {
    AWS_REGION: "us-east-1",
    OBSERVATORY_METRICS_TABLE: "test-observatory-table",
  },
}));

const span: SpanData = {
  spanId: "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  traceId: "trace-abc",
  service: "routineweave",
  model: "gemini-3.5-flash-lite",
  startTime: new Date("2026-09-13T10:11:12.345Z"),
  inputTokens: 120,
  outputTokens: 45,
  costUsd: 0.0001234,
};

const decision: DecisionData = { action: "allowed", reason: "ok" };

/** Drive the real persist path once and hand back the Item it actually wrote. */
async function captureEmittedItem(): Promise<Record<string, unknown>> {
  mockSend.mockClear();
  mockSend.mockResolvedValue({});

  const { ObservatoryMetricsStore } = await import("../storage/ObservatoryMetricsStore");
  await new ObservatoryMetricsStore().persist(span, decision);

  expect(mockSend).toHaveBeenCalledTimes(1);
  const command = mockSend.mock.calls[0][0];
  expect(command).toBeInstanceOf(PutItemCommand);
  return (command as PutItemCommand).input.Item as unknown as Record<string, unknown>;
}

describe("OBSERVATORY_METRICS shared-table contract", () => {
  it("the span RoutineWeave actually writes satisfies invariants I1-I4", async () => {
    const item = await captureEmittedItem();

    // checkItem unwraps the low-level AttributeValue shape ({ S: "..." }) this
    // writer emits, so the same function checks Python and Node writers alike.
    const problems = checkItem(item);
    expect(problems).toEqual([]);
  });

  it("I1: key attributes are the lower-case pk/sk the table declares", async () => {
    const item = await captureEmittedItem();

    expect(typeof (item.pk as { S: string }).S).toBe("string");
    expect(typeof (item.sk as { S: string }).S).toBe("string");
    // A writer spelling these PK/SK gets a ValidationException from PutItem —
    // which persist() deliberately swallows and logs at warn, so it would look
    // like success while writing nothing. That is why this is asserted here.
    expect(item).not.toHaveProperty("PK");
    expect(item).not.toHaveProperty("SK");
  });

  it("I3: sk is {iso8601}#{trace_id} so readers can range-query on time", async () => {
    const item = await captureEmittedItem();

    const [timestamp, traceId] = (item.sk as { S: string }).S.split("#");
    expect(traceId).toBeTruthy();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    // The timestamp must lead, or lexicographic range queries return the wrong rows.
    expect((item.sk as { S: string }).S.startsWith(span.startTime.toISOString())).toBe(true);
  });

  it("I4: ttl is present and in the future so rows expire from the shared table", async () => {
    const item = await captureEmittedItem();

    const ttl = Number((item.ttl as { N: string }).N);
    expect(Number.isFinite(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("I5: RoutineWeave's pk is a discriminator the dashboard readers enumerate", async () => {
    // RoutineWeave keys spans by OPERATION name (invoke_model), which is what
    // the contract's OBSERVATORY namespace declares its discriminator to be and
    // what the readers enumerate — so these rows are actually visible on the
    // dashboards. Asserted so that a future change which silently moves them
    // into an unread partition (the failure mode is silent: PutItem succeeds)
    // fails here instead of quietly emptying a dashboard.
    //
    // Note this is the opposite of ScreenWeave's situation, where the same
    // namespace is keyed by TOOL name and has no reader; see that repository's
    // contracts/README.md. Which scheme wins portfolio-wide is an open platform
    // decision — this test only pins what RoutineWeave does today.
    const item = await captureEmittedItem();
    const pk = (item.pk as { S: string }).S;

    expect(pk).toBe("OBSERVATORY#invoke_model");

    const registry = loadContract().namespace_registry.OBSERVATORY;
    expect(registry.discriminator).toBe("operation");
    expect(registry.discriminator_values).toContain("invoke_model");

    expect(readersFor(pk).length).toBeGreaterThan(0);
  });

  it("writes nothing at all when the shared table is not configured", async () => {
    // The gate: an unconfigured deployment must not attempt a PutItem.
    jest.resetModules();
    jest.doMock("../config", () => ({
      env: { AWS_REGION: "us-east-1", OBSERVATORY_METRICS_TABLE: undefined },
    }));

    mockSend.mockClear();
    const { ObservatoryMetricsStore } = await import("../storage/ObservatoryMetricsStore");
    await new ObservatoryMetricsStore().persist(span, decision);

    expect(mockSend).not.toHaveBeenCalled();
    jest.dontMock("../config");
    jest.resetModules();
  });
});
