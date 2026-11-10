# RoutineWeave

**Schedule JSON-defined AI prompts on cron and deliver results to SNS, webhooks, or Slack.**

RoutineWeave is for developers and operators who want recurring Gemini-powered workflows (digests, scouts, trackers) on AWS serverless infrastructure—with task changes applied by uploading JSON, without redeploying Lambdas.

<!-- Demo GIF placeholder: add docs/assets/routineweave-demo.gif when available -->

## Who it is for

- Teams already on **AWS** (Lambda, EventBridge, S3, SNS) who want a thin scheduling layer around LLM calls
- Individuals running **local experiments** with `node-cron` before promoting tasks to S3
- Integrators extending **output handlers** or optional **observatory metrics** (see [docs/EXTENDING.md](docs/EXTENDING.md))

**Not a fit:** fully managed multi-tenant SaaS, or running production schedules with zero cloud footprint (production requires AWS; local mode still needs Gemini and optionally SNS credentials).

## Five-minute quickstart (no cloud required)

Verified on Node.js 20:

```bash
git clone https://github.com/rajatarun/RoutineWeave.git
cd RoutineWeave
npm install
npm run typecheck
npm test
npm run build
```

Try offline examples:

```bash
npx ts-node examples/render-prompt.ts
npx ts-node examples/validate-task.ts tasks/ai_news_digest.json
npx ts-node examples/eval-prompt-render.ts   # synthetic benchmark, no network
```

### Local scheduler (needs credentials)

```bash
cp .env.example .env
# Set GEMINI_API_KEY; set SNS_TOPIC_ARN if you want email delivery on run
npm run dev
```

Loads enabled tasks from `tasks/` and runs them on their cron expressions in-process.

## Core workflow (three examples)

### 1. Validate and inspect a task offline

```bash
npx ts-node examples/validate-task.ts examples/tasks/minimal_sns.json
npx ts-node examples/render-prompt.ts
```

### 2. Define a scheduled digest (S3 / API)

```json
{
  "task_name": "ai_news_digest",
  "schedule": "0 */6 * * *",
  "prompt": "Today is {{current_date}}. Summarize {{topics}} in 5 bullets.",
  "grounding": true,
  "input": { "topics": ["model releases", "research"] },
  "output": { "type": "sns" }
}
```

Upload via HTTP API after deploy (`POST /tasks`) or copy to S3 under `tasks/{task_name}.json`. Full field reference below.

### 3. Post results to Slack

```json
{
  "task_name": "weekly_standup_ai",
  "schedule": "0 8 * * 1",
  "prompt": "Today is {{current_date}}. Draft a 3-bullet team standup summary for {{team}}.",
  "input": { "team": "platform" },
  "output": {
    "type": "slack",
    "webhook_url": "https://hooks.slack.com/services/XXX/YYY/ZZZ"
  }
}
```

Webhook and SNS handlers also support custom headers—store secrets in task JSON carefully (see [SECURITY.md](SECURITY.md)).

## How it works

1. **Define a task** — JSON with cron, prompt, optional `input`, and `output` destination.
2. **Upload to S3** — REST API or direct PUT. The Registrar Lambda creates a per-task EventBridge rule.
3. **At schedule time** — Scheduler Lambda renders the prompt, calls Gemini, routes output.
4. **Receive the result** — SNS email, Slack webhook, or your HTTP endpoint.

Detailed diagrams: [docs/architecture.md](docs/architecture.md).

```
Client ──► API Gateway ──► S3 tasks ──► Registrar ──► EventBridge (per task)
                                              └──► Scheduler ──► Gemini ──► SNS / webhook / Slack
```

**Stack:** Lambda (Node 20), EventBridge, S3, Secrets Manager (Gemini key), SNS, optional DynamoDB observatory table.

## Task definition format

```json
{
  "task_name": "ai_news_digest",
  "schedule": "0 */6 * * *",
  "model": "gemini-3.5-flash-lite",
  "grounding": true,
  "enabled": true,
  "timeout_ms": 290000,
  "prompt": "Today is {{current_date}}. Topics: {{topics}}.",
  "input": {
    "topics": ["model releases", "research breakthroughs"],
    "region": "global"
  },
  "output": { "type": "sns" }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `task_name` | Yes | — | Lowercase `a-z0-9_`; S3 key and rule name |
| `schedule` | Yes | — | 5-field cron |
| `prompt` | Yes | — | Template with `{{variable}}` placeholders |
| `model` | No | `gemini-3.5-flash-lite` | Gemini model ID |
| `grounding` | No | `false` | Google Search grounding when true |
| `enabled` | No | `true` | Disable without deleting |
| `timeout_ms` | No | `290000` | 1 000 – 300 000 ms |
| `output.type` | Yes | — | `sns`, `webhook`, or `slack` |

Built-in template variables: `{{current_date}}`, `{{current_datetime}}`, `{{day_of_week}}`, plus keys from `input` and `variables`.

**Staying current:** prompts about "today" or "latest" should set `grounding: true` and include `{{current_date}}`. See `tasks/linkedin_topic_scout.json` for a grounded scout pattern (replace `REPLACE_ME` webhook credentials before use).

## Project structure

```
src/
  api.ts, lambda.ts, registrar.ts, orchestrator.ts, local.ts
  scheduler/   # Zod schemas, TaskLoader, JobRegistry
  engine/      # PromptRenderer, GeminiClient, ExecutionEngine
  output/      # SNS, webhook, Slack
  storage/, events/, config/, utils/
tasks/         # Sample definitions
examples/      # Offline runnable examples
aws/           # SAM template
docs/          # Architecture, integrations, security
```

## Deployment (AWS)

Production requires an AWS account. Minimal path:

1. Store Gemini key in Secrets Manager as `gemini/api_key` with JSON `{"key":"..."}`.
2. Configure GitHub Actions secrets/variables **or** run `sam deploy` locally — see [docs/DEPLOY_CONFIG.md](docs/DEPLOY_CONFIG.md) and [docs/architecture.md](docs/architecture.md).
3. Confirm the SNS email subscription for your notification address.
4. Call the API Gateway `ApiUrl` to manage tasks.

Do not commit account IDs, role ARNs, or API keys to documentation—parameterize them in your environment.

## Development

| Command | Purpose |
|---------|---------|
| `npm test` | Unit tests (mocked AWS/Gemini) |
| `npm run typecheck` | TypeScript |
| `npm run dev` | Local cron runner |

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
