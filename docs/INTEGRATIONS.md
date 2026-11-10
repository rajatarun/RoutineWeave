# Integration opportunities

RoutineWeave is a **cron-driven prompt runner** with pluggable outputs (SNS, webhook, Slack). Below are ecosystem integrations that fit naturally. Effort is a rough engineer-day estimate for a production-quality adapter unless noted.

| Integration | Fit | Adapter shape | Effort | Implemented today |
|-------------|-----|---------------|--------|-------------------|
| **Slack Incoming Webhooks** | High | `SlackPublisher` posts Block Kit messages from task results | Done | **Yes** (`src/output/SlackPublisher.ts`) |
| **MCP (Model Context Protocol)** | High | MCP *tool* that exposes `POST /tasks` CRUD and `GET /results` as resources; or MCP *server* that schedules prompts and returns SNS/webhook delivery status | 3–5 days | No — REST API exists (`src/api.ts`) |
| **OpenTelemetry** | High | Wrap `ExecutionEngine` and output handlers with spans; export to OTLP from Lambda (or local `npm run dev`) | 2–4 days | Partial — structured JSON logs only (`src/utils/logger.ts`) |
| **AWS Bedrock** | Med | Swap or complement `GeminiClient` with Bedrock Converse using existing `@aws-sdk/client-bedrock-runtime` dependency | 3–5 days | Dependency present; runtime path uses Gemini |
| **LangGraph / LangChain** | Med | LangGraph node that loads task JSON, renders prompt, calls model; LangChain `RoutineWeaveTaskLoader` for S3 | 4–6 days | No — task format is plain JSON + Zod |
| **Anthropic / OpenAI SDKs** | Med | New `ModelClient` interface; task field `provider: gemini \| anthropic \| openai` | 3–4 days | No — Gemini only |
| **Amazon EventBridge Scheduler** | Low | Replace per-task rules with Scheduler groups (cost/ops tradeoff) | 5+ days | No — custom Registrar pattern |
| **mcp-observatory** | Med | Already writes conformance-checked metrics rows when `OBSERVATORY_METRICS_TABLE` is set | 1 day (config) | **Yes** (optional DynamoDB writer + `contracts/conformance.ts`) |
| **PagerDuty / Opsgenie** | Med | Output handler on failure paths or CloudWatch alarm fan-out | 1–2 days | No |

## MCP server sketch (not implemented)

A minimal MCP server could:

1. List tasks from S3 via the HTTP API or direct `S3TaskStore`
2. Tool `run_task_now` invoking the Scheduler Lambda (or local orchestrator)
3. Resource `task://{name}` returning validated JSON from `TaskDefinitionSchema`

This reuses existing Zod schemas in `src/scheduler/types.ts` and avoids duplicating schedule logic.

## OpenTelemetry sketch (not implemented)

Instrument:

- `ExecutionEngine.run` — span attributes: `task_name`, `model`, `grounding`, `duration_ms`
- `OutputRouter.route` — span events per handler
- Gemini HTTP — child span with token usage when available

Export via OTLP HTTP from Lambda extension or sidecar; local dev can print to console exporter.

## Bedrock sketch (not implemented)

Introduce `ModelClient` in `src/engine/`:

```typescript
export interface ModelClient {
  generate(input: GenerateInput): Promise<GenerateOutput>;
}
```

Register Gemini and Bedrock implementations; select via `task.model` prefix (`bedrock:` vs default Gemini IDs).
