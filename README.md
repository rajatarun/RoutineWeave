# RoutineWeave

AI-powered scheduled execution engine. Runs prompts on a schedule, executes them via Google Gemini, and delivers results through AWS SNS email notifications.

---

## Architecture

```
EventBridge (cron)
       │
       ▼
  Lambda Handler  ──► TaskLoader (reads tasks/*.json)
       │
       ▼
  ExecutionEngine
    │   └─ PromptRenderer  (injects {{variables}})
    │   └─ GeminiClient    (Gemini API + retry)
       │
       ▼
  OutputRouter
    └─ SNSPublisher  ──► SNS Topic ──► Email subscribers
```

**Compute**: AWS Lambda (arm64, 5-min timeout)
**Scheduling**: AWS EventBridge rules (replaces in-process cron in production)
**Notifications**: AWS SNS (email subscription)
**Logging**: AWS CloudWatch Logs (structured JSON)
**Deployment**: AWS SAM + GitHub Actions OIDC

---

## Project Structure

```
routineweave/
├── src/
│   ├── scheduler/
│   │   ├── types.ts          # Zod schemas for task definitions
│   │   ├── TaskLoader.ts     # Loads and validates task JSON files
│   │   └── JobRegistry.ts    # node-cron registry (local dev only)
│   ├── engine/
│   │   ├── GeminiClient.ts   # Gemini API wrapper with retry
│   │   ├── PromptRenderer.ts # {{variable}} template engine
│   │   └── ExecutionEngine.ts
│   ├── output/
│   │   ├── interfaces.ts     # OutputHandler interface (extensible)
│   │   ├── SNSPublisher.ts   # AWS SNS v3 publisher
│   │   └── OutputRouter.ts   # Routes results to correct handler
│   ├── config/
│   │   └── environment.ts    # Zod-validated env vars
│   ├── utils/
│   │   ├── logger.ts         # Structured JSON logger
│   │   └── retry.ts          # Exponential backoff utility
│   ├── orchestrator.ts       # Wires engine + router together
│   ├── lambda.ts             # AWS Lambda entry point
│   └── local.ts              # Local development runner (node-cron)
├── tasks/                    # Task definition JSON files
│   ├── ai_news_digest.json
│   ├── daily_productivity_summary.json
│   └── weekly_health_report.json
├── aws/
│   ├── template.yaml         # AWS SAM template
│   └── iam-policy.json       # Required IAM permissions
└── .github/workflows/
    └── deploy.yml            # GitHub Actions CI/CD pipeline
```

---

## Task Definition Format

```json
{
  "task_name": "ai_news_digest",
  "schedule": "0 */6 * * *",
  "prompt": "Summarize AI news on {{current_date}} in 5 bullet points",
  "model": "gemini-1.5-pro",
  "enabled": true,
  "timeout_ms": 60000,
  "output": {
    "type": "sns",
    "sns_topic_arn": "arn:aws:sns:us-east-1:ACCOUNT:routineweave-notifications"
  }
}
```

### Built-in template variables

| Variable               | Value                       |
|------------------------|-----------------------------|
| `{{current_date}}`     | YYYY-MM-DD                  |
| `{{current_datetime}}` | Full ISO 8601 timestamp     |
| `{{day_of_week}}`      | e.g. "Monday"               |

Custom variables can be added in the `variables` field of the task.

---

## Local Development Setup

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
# Edit .env with your GEMINI_API_KEY, AWS_REGION, SNS_TOPIC_ARN
```

### Run locally (in-process cron scheduler)

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

---

## AWS Deployment Guide

### Step 1: Create SNS Topic

```bash
aws sns create-topic \
  --name routineweave-notifications-production \
  --region us-east-1
```

### Step 2: Subscribe your email

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT_ID:routineweave-notifications-production \
  --protocol email \
  --notification-endpoint your@email.com \
  --region us-east-1
```

**Important**: Check your inbox and click the confirmation link. SNS will not deliver until confirmed.

### Step 3: Update task files

Replace the `sns_topic_arn` in all `tasks/*.json` files with your actual topic ARN.

### Step 4: Store Gemini API key in SSM (recommended)

```bash
aws ssm put-parameter \
  --name /routineweave/gemini-api-key \
  --value "YOUR_GEMINI_API_KEY" \
  --type SecureString \
  --region us-east-1
```

### Step 5: Configure GitHub Secrets

In your GitHub repository settings add:

| Secret           | Value               |
|------------------|---------------------|
| `GEMINI_API_KEY` | Your Gemini API key |
| `SNS_TOPIC_ARN`  | Your SNS topic ARN  |

### Step 6: Deploy via GitHub Actions

Push to `main` or trigger the workflow manually. The pipeline will:

1. Run type checks and tests
2. Build TypeScript
3. Assume the OIDC IAM role `arn:aws:iam::239571291755:role/teamweave-github-actions-sam-deployer`
4. Deploy via SAM

### Step 7: Verify EventBridge schedule

```bash
aws events list-rules --name-prefix routineweave --region us-east-1
```

### Step 8: Monitor in CloudWatch

```bash
aws logs tail /aws/lambda/routineweave-scheduler-production --follow --region us-east-1
```

---

## Manual deploy (without GitHub Actions)

```bash
npm run build && npm prune --production

sam build --template aws/template.yaml
sam deploy \
  --stack-name routineweave-production \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=production \
    GeminiApiKey=YOUR_KEY \
    SnsTopicArn=YOUR_ARN
```

---

## Production Behavior

### How scheduling works

AWS EventBridge triggers the Lambda on a `rate(1 hour)` schedule. The Lambda loads all enabled task files and executes them. For per-task granularity, create a separate EventBridge rule per task that passes `{"detail": {"task_name": "your_task"}}` as input.

### How failures are retried

Gemini API calls and SNS publishes both use exponential backoff up to `MAX_RETRIES` attempts. Base delay doubles each attempt with jitter. Auth/quota errors fail fast without retrying.

### How logs are tracked

All logs are structured JSON. Lambda ships them to CloudWatch Logs at `/aws/lambda/routineweave-scheduler-production`. Every entry includes `timestamp`, `level`, `message`, and `meta`.

### How tasks are dynamically loaded

`TaskLoader` reads `tasks/*.json` at Lambda invocation. Add a JSON file and redeploy to activate a new task. No code changes required.

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

---

## Environment Variables

| Variable                | Required | Default       | Description                     |
|-------------------------|----------|---------------|---------------------------------|
| `GEMINI_API_KEY`        | Yes      | —             | Google Gemini API key           |
| `AWS_REGION`            | Yes      | `us-east-1`   | AWS region                      |
| `SNS_TOPIC_ARN`         | Yes      | —             | SNS topic ARN for notifications |
| `AWS_ACCESS_KEY_ID`     | No       | —             | Only if not using IAM role      |
| `AWS_SECRET_ACCESS_KEY` | No       | —             | Only if not using IAM role      |
| `NODE_ENV`              | No       | `development` | Environment                     |
| `LOG_LEVEL`             | No       | `info`        | debug / info / warn / error     |
| `TASKS_DIR`             | No       | `./tasks`     | Path to task JSON files         |
| `MAX_RETRIES`           | No       | `3`           | Max retry attempts              |
| `RETRY_BASE_DELAY_MS`   | No       | `1000`        | Base retry delay in ms          |
