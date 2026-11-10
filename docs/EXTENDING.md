# Extending RoutineWeave

## Task definition (primary extension point)

Tasks are JSON files validated by `TaskDefinitionSchema` in `src/scheduler/types.ts`.

Required fields: `task_name`, `schedule`, `prompt`, `output`.

Add behavior by:

- **`input` / `variables`** — inject data into `{{placeholders}}` via `PromptRenderer`
- **`grounding`** — enable Gemini Google Search tool when the prompt needs current facts
- **`output`** — route results to SNS, webhook, or Slack (discriminated union on `type`)

Upload tasks to S3 (production) or place them under `tasks/` (local `npm run dev`).

## Output handlers (plugin pattern)

Handlers implement `OutputHandler` in `src/output/interfaces.ts`:

```typescript
export interface OutputHandler {
  name: string;
  publish(payload: OutputPayload, config: Record<string, unknown>): Promise<void>;
}
```

Built-in handlers:

| `output.type` | Class | Config fields |
|---------------|-------|----------------|
| `sns` | `SNSPublisher` | optional `sns_topic_arn` |
| `webhook` | `WebhookPublisher` | `url`, optional `headers` |
| `slack` | `SlackPublisher` | `webhook_url`, optional `channel` |

Register custom handlers on `OutputRouter`:

```typescript
import { OutputRouter } from "./output/OutputRouter";
import { OutputHandler } from "./output/interfaces";

class DiscordHandler implements OutputHandler {
  name = "discord";
  async publish(payload, config) {
    // ...
  }
}

const router = new OutputRouter();
router.registerHandler(new DiscordHandler());
```

For production Lambda, wire registration in `src/orchestrator.ts` (or a dedicated factory) and extend `OutputConfigSchema` in `types.ts` if the new type should validate at upload time.

## Custom model providers

Today execution flows through `GeminiClient` inside `ExecutionEngine`. To add providers:

1. Define a narrow `ModelClient` interface alongside `GeminiClient`
2. Select implementation from `task.model` or a new `provider` field
3. Keep retry semantics in `src/utils/retry.ts`

## Registrar / schedule logic

`EventBridgeManager` converts 5-field cron to EventBridge expressions. Alternative schedulers (e.g. one-shot rules) would extend `src/events/EventBridgeManager.ts` and the Registrar Lambda handler in `src/registrar.ts`.

## Observability extension

When `OBSERVATORY_METRICS_TABLE` is configured, `ObservatoryMetricsStore` writes shared-table rows validated by `contracts/conformance.ts`. New telemetry fields must update the vendored contract in sync with [mcp-observatory](https://github.com/rajatarun/mcp-observatory) (canonical contract home).
