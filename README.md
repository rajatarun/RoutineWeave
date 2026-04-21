# RoutineWeave

AI-powered scheduled execution engine. Define prompts as JSON tasks, store them in S3, and RoutineWeave runs them on a cron schedule via Google Gemini — delivering results to your inbox through AWS SNS.

---

## How it works

1. **Define a task** — a JSON file with a cron schedule, a Gemini prompt, and optional input variables.
2. **Upload to S3** — via the REST API or directly. The Registrar Lambda detects the change and provisions a per-task EventBridge cron rule automatically.
3. **At schedule time** — EventBridge fires the Scheduler Lambda, which renders the prompt, calls Gemini, and publishes the result to SNS.
4. **Receive the result** — SNS delivers it to your subscribed email address.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  API Gateway (HTTP v2)                                          │
│  GET/POST /tasks  ·  GET/PUT/DELETE /tasks/{taskName}           │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
         ┌────────────────┐         ┌──────────────────────────────┐
         │  API Lambda    │ ──PUT──► │  S3 Task Store               │
         │  (api.ts)      │         │  routineweave-tasks-{env}-    │
         └────────────────┘         │  {accountId}                 │
                                    │  tasks/{task_name}.json      │
                                    └──────────────┬───────────────┘
                                                   │ EventBridge
                                                   │ Object Created / Deleted
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  EventBridge Rule 1          │
                                    │  routineweave-s3-task-change │
                                    └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  Registrar Lambda            │
                                    │  (registrar.ts)              │
                                    │  PutRule / DeleteRule        │
                                    └──────────────┬───────────────┘
                                                   │ creates per-task rule
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  EventBridge Rule 2 (×N)     │
                                    │  routineweave-task-{name}    │
                                    │  cron(…) per task schedule   │
                                    └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  Scheduler Lambda            │
                                    │  (lambda.ts)                 │
                                    │  ExecutionEngine             │
                                    │    PromptRenderer            │
                                    │    GeminiClient (grounding)  │
                                    └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  SNS Topic                   │
                                    │  → Email (rajatarun12@…)     │
                                    └──────────────────────────────┘
```

**Compute**: AWS Lambda (arm64, Node.js 20)  
**Scheduling**: Dual EventBridge — S3 events → Registrar → per-task cron rules → Scheduler  
**Task storage**: AWS S3 (versioned, EventBridge-enabled)  
**AI**: Google Gemini `gemini-3.1-flash-lite-preview` via `@google/genai`  
**API key**: AWS Secrets Manager (`gemini/api_key` → field `key`)  
**Notifications**: AWS SNS email subscription (provisioned by SAM)  
**Observability**: CloudWatch Logs (structured JSON) + CloudWatch Alarm on Lambda errors  
**Deployment**: AWS SAM + GitHub Actions OIDC  

---

## Project Structure

```
routineweave/
├── src/
│   ├── api.ts                    # API Gateway HTTP handler (CRUD)
│   ├── lambda.ts                 # Scheduler Lambda entry point
│   ├── registrar.ts              # Registrar Lambda — manages EventBridge rules
│   ├── orchestrator.ts           # Wires ExecutionEngine + OutputRouter
│   ├── local.ts                  # Local dev runner (node-cron)
│   ├── scheduler/
│   │   ├── types.ts              # Zod schemas for task definitions
│   │   ├── TaskLoader.ts         # Filesystem loader (local dev only)
│   │   └── JobRegistry.ts        # node-cron registry (local dev only)
│   ├── engine/
│   │   ├── GeminiClient.ts       # Gemini API wrapper with retry + grounding
│   │   ├── PromptRenderer.ts     # {{variable}} template engine
│   │   └── ExecutionEngine.ts    # Renders prompt, calls Gemini
│   ├── storage/
│   │   └── S3TaskStore.ts        # S3 CRUD for task definitions
│   ├── events/
│   │   └── EventBridgeManager.ts # PutRule / DeleteRule for per-task cron rules
│   ├── output/
│   │   ├── interfaces.ts         # OutputHandler interface
│   │   ├── SNSPublisher.ts       # AWS SNS v3 publisher
│   │   └── OutputRouter.ts       # Routes results to the correct handler
│   ├── config/
│   │   ├── environment.ts        # Zod-validated env vars
│   │   └── secrets.ts            # Gemini API key from Secrets Manager (cached)
│   └── utils/
│       ├── logger.ts             # Structured JSON logger
│       └── retry.ts              # Exponential backoff with jitter
├── tasks/                        # Sample task definitions (upload to S3 to activate)
│   ├── ai_news_digest.json
│   ├── daily_productivity_summary.json
│   ├── price_tracker.json
│   └── weekly_health_report.json
├── aws/
│   ├── template.yaml             # AWS SAM template (full stack)
│   └── iam-policy.json           # Reference IAM policy
└── .github/workflows/
    └── deploy.yml                # CI/CD — typecheck → test → SAM build → SAM deploy
```

---

## Task Definition Format

```json
{
  "task_name": "ai_news_digest",
  "schedule": "0 */6 * * *",
  "model": "gemini-3.1-flash-lite-preview",
  "grounding": true,
  "enabled": true,
  "timeout_ms": 60000,
  "prompt": "Today is {{current_date}}. Summarize AI news across {{topics}} in 5 bullet points. Region: {{region}}.",
  "input": {
    "topics": ["model releases", "research breakthroughs", "industry news"],
    "region": "global"
  },
  "output": {
    "type": "sns"
  }
}
```

### Fields

| Field          | Required | Default                        | Description |
|----------------|----------|--------------------------------|-------------|
| `task_name`    | Yes      | —                              | Lowercase alphanumeric + underscores; used as S3 key and EventBridge rule name |
| `schedule`     | Yes      | —                              | Standard 5-field cron (e.g. `0 8 * * *`) |
| `prompt`       | Yes      | —                              | Prompt template with `{{variable}}` placeholders |
| `model`        | No       | `gemini-3.1-flash-lite-preview`| Gemini model ID |
| `grounding`    | No       | `false`                        | Enables Google Search grounding tool |
| `enabled`      | No       | `true`                         | Set `false` to disable without deleting the task |
| `timeout_ms`   | No       | `60000`                        | Max execution time (1 000 – 300 000 ms) |
| `max_retries`  | No       | —                              | Override default retry count (0–10) |
| `variables`    | No       | —                              | Static string overrides merged into prompt variables |
| `input`        | No       | —                              | Dynamic input values; strings injected directly, arrays `JSON.stringify`'d |
| `output.type`  | Yes      | —                              | `sns`, `slack`, or `webhook` |

### Built-in template variables

| Variable               | Value                             |
|------------------------|-----------------------------------|
| `{{current_date}}`     | `YYYY-MM-DD`                      |
| `{{current_datetime}}` | Full ISO 8601 timestamp           |
| `{{day_of_week}}`      | e.g. `Monday`                     |

All keys from `input` and `variables` are also injected. `input` takes precedence over `variables`.

---

## Local Development

### Prerequisites

- Node.js 20+
- AWS CLI configured (for SNS publishing)
- Google Gemini API key

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# Set GEMINI_API_KEY, AWS_REGION, SNS_TOPIC_ARN
```

### Run locally

```bash
npm run dev    # in-process node-cron scheduler, loads tasks/ from filesystem
```

### Build & test

```bash
npm run build
npm run typecheck
npm test
```

---

## Deployment

### Prerequisites

1. **Gemini API key in Secrets Manager**

   ```bash
   aws secretsmanager create-secret \
     --name gemini/api_key \
     --secret-string '{"key":"YOUR_GEMINI_API_KEY"}' \
     --region us-east-1
   ```

2. **GitHub OIDC role** — the workflow assumes:
   `arn:aws:iam::239571291755:role/teamweave-github-actions-sam-deployer`

### Deploy via GitHub Actions

Push to `main` or trigger the workflow manually. The pipeline:

1. Runs `npm run typecheck` and `npm test`
2. Builds TypeScript (`npm run build`)
3. Assumes the OIDC IAM role
4. Runs `sam build --template aws/template.yaml`
5. Runs `sam deploy --resolve-s3 ...`

SAM provisions: S3 bucket, SNS topic + email subscription, three Lambdas, API Gateway, EventBridge rules, CloudWatch log groups and alarm.

**After the first deploy**, confirm the SNS subscription email before tasks will deliver.

### Manual deploy

```bash
npm run build

sam build --template aws/template.yaml
sam deploy \
  --stack-name routineweave-production \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides Environment=production
```

---

## Managing Tasks

Once deployed, use the API Gateway URL (output `ApiUrl`) to manage tasks:

```bash
BASE_URL="https://<api-id>.execute-api.us-east-1.amazonaws.com/production"

# List all tasks
curl "$BASE_URL/tasks"

# Create or upload a task
curl -X POST "$BASE_URL/tasks" \
  -H "Content-Type: application/json" \
  -d @tasks/ai_news_digest.json

# Get a specific task
curl "$BASE_URL/tasks/ai_news_digest"

# Update a task
curl -X PUT "$BASE_URL/tasks/ai_news_digest" \
  -H "Content-Type: application/json" \
  -d @tasks/ai_news_digest.json

# Delete a task
curl -X DELETE "$BASE_URL/tasks/ai_news_digest"
```

Uploading or deleting a task triggers the Registrar Lambda within seconds, which provisions or removes the corresponding EventBridge cron rule automatically.

---

## Monitoring

```bash
# Tail Scheduler logs
aws logs tail /aws/lambda/routineweave-scheduler-production --follow --region us-east-1

# Tail Registrar logs
aws logs tail /aws/lambda/routineweave-registrar-production --follow --region us-east-1

# Tail API logs
aws logs tail /aws/lambda/routineweave-api-production --follow --region us-east-1

# List per-task EventBridge rules
aws events list-rules --name-prefix routineweave-task- --region us-east-1
```

A CloudWatch Alarm (`routineweave-errors-production`) fires to the SNS topic when the Scheduler Lambda records ≥ 3 errors in a one-hour window.

---

## Environment Variables

| Variable              | Required | Default       | Description |
|-----------------------|----------|---------------|-------------|
| `GEMINI_API_KEY`      | No*      | —             | Local dev fallback; production reads from Secrets Manager |
| `AWS_REGION`          | Yes      | `us-east-1`   | AWS region |
| `SNS_TOPIC_ARN`       | Yes      | —             | SNS topic ARN; injected by SAM via `!Ref RoutineWeaveNotificationTopic` |
| `TASKS_BUCKET`        | Yes      | —             | S3 bucket name; injected by SAM |
| `TASKS_S3_PREFIX`     | No       | `tasks/`      | S3 key prefix for task JSON files |
| `SCHEDULER_LAMBDA_ARN`| Yes†     | —             | Scheduler Lambda ARN; injected by SAM into Registrar only |
| `NODE_ENV`            | No       | `development` | `production` or `staging` in AWS |
| `LOG_LEVEL`           | No       | `info`        | `debug` / `info` / `warn` / `error` |
| `MAX_RETRIES`         | No       | `3`           | Max Gemini API retry attempts |
| `RETRY_BASE_DELAY_MS` | No       | `1000`        | Base retry delay in ms |

\* Required for local development  
† Registrar Lambda only

---

## Adding custom output handlers

```typescript
import { OutputHandler, OutputPayload } from "./output/interfaces";

class SlackHandler implements OutputHandler {
  name = "slack";
  async publish(payload: OutputPayload, config: Record<string, unknown>) {
    // POST to config.webhook_url
  }
}

router.registerHandler(new SlackHandler());
```

Slack and webhook output types are already defined in the Zod schema (`SlackOutputSchema`, `WebhookOutputSchema`) and can be wired up this way.
