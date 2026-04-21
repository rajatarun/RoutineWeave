# RoutineWeave — Architecture

## Overview

RoutineWeave is a serverless, event-driven execution engine. JSON task definitions stored in S3 drive two independent concerns: **scheduling** (when to run) and **execution** (what to run). These are decoupled through a dual EventBridge architecture so that adding, modifying, or deleting a task automatically reconfigures its schedule — with no redeployment required.

---

## Component Map

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Control Plane (task management)                                          │
│                                                                           │
│  Client  ──►  API Gateway HTTP v2  ──►  API Lambda (api.ts)              │
│                                              │                            │
│                                     S3TaskStore.ts                        │
│                                              │                            │
│                              ┌───────────────▼──────────────────┐        │
│                              │  S3 Task Store (versioned)        │        │
│                              │  routineweave-tasks-{env}-{acct}  │        │
│                              │  tasks/{task_name}.json           │        │
│                              └───────────────┬──────────────────┘        │
└──────────────────────────────────────────────┼──────────────────────────-┘
                                               │
                                    S3 EventBridge notification
                                    (Object Created / Object Deleted)
                                               │
┌──────────────────────────────────────────────▼───────────────────────────┐
│  Scheduling Plane (rule lifecycle)                                        │
│                                                                           │
│  EventBridge Rule 1: routineweave-s3-task-change                         │
│    source: aws.s3 | detail-type: Object Created | Object Deleted         │
│    filter: bucket = TasksBucket, key prefix = tasks/                     │
│                          │                                                │
│                          ▼                                                │
│              Registrar Lambda (registrar.ts)                             │
│                EventBridgeManager.ts                                      │
│                   Object Created → PutRule + PutTargets                  │
│                   Object Deleted → RemoveTargets + DeleteRule             │
│                          │                                                │
│                          ▼                                                │
│  EventBridge Rule 2 (×N): routineweave-task-{task_name}                  │
│    schedule: cron(…) derived from task.schedule                          │
│    state: ENABLED (task.enabled=true) or DISABLED                        │
│    input: { "task_name": "{task_name}" }                                 │
└──────────────────────────────────────────────┬───────────────────────────┘
                                               │ at schedule time
┌──────────────────────────────────────────────▼───────────────────────────┐
│  Execution Plane                                                          │
│                                                                           │
│  Scheduler Lambda (lambda.ts)                                            │
│    S3TaskStore.get(task_name)  ──►  S3 Task Store                        │
│    ExecutionEngine.ts                                                     │
│      PromptRenderer.ts   injects {{variables}} + {{input}} into prompt   │
│      GeminiClient.ts     calls Gemini API (optional Google Search)        │
│                                    ▲                                      │
│                         Secrets Manager: gemini/api_key → .key           │
│                          (cached in Lambda memory across warm invokes)    │
│    OutputRouter.ts                                                        │
│      SNSPublisher.ts  ──►  SNS Topic  ──►  Email subscriber              │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow — Task Lifecycle

### 1. Task creation

```
POST /tasks  →  API Lambda  →  S3TaskStore.put()  →  S3 (Object Created event)
                                                          │
                                               EventBridge Rule 1 fires
                                                          │
                                               Registrar Lambda
                                                  reads task from S3
                                                  calls EventBridgeManager.upsertRule()
                                                    PutRule(routineweave-task-{name}, cron(…))
                                                    PutTargets(Scheduler Lambda ARN)
```

### 2. Task execution

```
EventBridge Rule 2 fires at cron time
  → Scheduler Lambda invoked with { task_name: "…" }
  → S3TaskStore.get(task_name)  (reads current task JSON from S3)
  → PromptRenderer.render(task.prompt, merged_vars)
      merged_vars = defaults(current_date, …) + task.variables + task.input
      arrays in input are JSON.stringify'd before injection
  → GeminiClient.generate({ model, prompt, grounding })
      if grounding=true: attaches { googleSearch: {} } tool
      retries with exponential backoff on transient errors (quota/auth fail-fast)
  → SNSPublisher.publish(result)
      topicArn = SNS_TOPIC_ARN env var (injected by SAM)
```

### 3. Task deletion

```
DELETE /tasks/{name}  →  API Lambda  →  S3TaskStore.delete()  →  S3 (Object Deleted event)
                                                                        │
                                                             EventBridge Rule 1 fires
                                                                        │
                                                             Registrar Lambda
                                                               EventBridgeManager.deleteRule()
                                                                 RemoveTargets
                                                                 DeleteRule
                                                               (ResourceNotFoundException swallowed)
```

---

## AWS Resources

| Resource | Type | Purpose |
|----------|------|---------|
| `routineweave-tasks-{env}-{acct}` | S3 Bucket | Versioned task store; EventBridge notifications enabled |
| `routineweave-notifications-{env}` | SNS Topic | Delivers task results by email |
| `EmailSubscription` | SNS Subscription | `rajatarun12@gmail.com` (requires one-time confirmation) |
| `routineweave-scheduler-{env}` | Lambda | Executes a single task: render → Gemini → SNS |
| `routineweave-registrar-{env}` | Lambda | Manages per-task EventBridge rules in response to S3 events |
| `routineweave-api-{env}` | Lambda | HTTP CRUD API for task definitions |
| `RoutineWeaveHttpApi` | API Gateway HTTP v2 | 5 routes: `GET/POST /tasks`, `GET/PUT/DELETE /tasks/{taskName}` |
| `routineweave-s3-task-change-{env}` | EventBridge Rule | S3 Object Created/Deleted → Registrar |
| `routineweave-task-{name}` (×N) | EventBridge Rule | Per-task cron → Scheduler (created at runtime by Registrar) |
| `RoutineWeaveLambdaRole` | IAM Role | Shared across all three Lambdas; least-privilege |
| `gemini/api_key` | Secrets Manager | `{"key": "…"}` — Gemini API key, cached in Lambda memory |
| `routineweave-errors-{env}` | CloudWatch Alarm | Fires to SNS when Scheduler errors ≥ 3 in one hour |

---

## EventBridge Cron Conversion

Standard 5-field cron (`min hour dom month dow`) is converted to EventBridge 6-field format (`min hour dom month dow year`) with the `?` wildcard constraint (exactly one of `dom` / `dow` must be `?`):

| Standard | EventBridge | Rule applied |
|----------|-------------|--------------|
| `0 8 * * *` | `cron(0 8 * * ? *)` | Both `*` → dom stays `*`, dow becomes `?` |
| `0 9 * * 1` | `cron(0 9 ? * 1 *)` | dow specified → dom becomes `?` |
| `0 0 1 * *` | `cron(0 0 1 * ? *)` | dom specified → dow becomes `?` |

Logic lives in `EventBridgeManager.toEventBridgeCron()`.

---

## Prompt Variable Injection

`PromptRenderer` replaces `{{key}}` placeholders in the prompt template. Variables are merged in this order (later entries win):

1. **Built-in defaults**: `current_date`, `current_datetime`, `day_of_week`
2. **`task.variables`**: static key→string overrides
3. **`task.input`**: dynamic values; `string[]` values are `JSON.stringify`'d into the placeholder

Example — the injected prompt for a price tracker task:

```
products = ["Apple AirPods Pro", "Sony WH-1000XM5"]
→ {{products}} becomes ["Apple AirPods Pro","Sony WH-1000XM5"]
```

---

## Retry Strategy

`retry.ts` implements exponential backoff with random jitter:

```
delay = baseDelay * 2^(attempt-1) * (0.5 + random()*0.5)
```

**Fail-fast conditions** (no retry): HTTP 401, 403, or quota-exceeded errors from Gemini.  
**Configurable**: `MAX_RETRIES` env var (default 3), `RETRY_BASE_DELAY_MS` (default 1 000 ms).

---

## Secrets Management

`config/secrets.ts` loads the Gemini API key once per Lambda cold start and caches it in module-level memory:

1. Check `GEMINI_API_KEY` env var (local dev fallback).
2. If not set, call `secretsmanager:GetSecretValue` for `gemini/api_key`.
3. Parse JSON, extract `.key` field, validate as non-empty string.
4. Cache result — subsequent warm invocations skip Secrets Manager entirely.

---

## IAM Permissions Summary

The shared `RoutineWeaveLambdaRole` grants:

| Service | Actions | Scope |
|---------|---------|-------|
| S3 | `GetObject`, `PutObject`, `DeleteObject`, `ListBucket` | `TasksBucket` only |
| SNS | `Publish`, `Subscribe` | `RoutineWeaveNotificationTopic` only |
| EventBridge | `PutRule`, `PutTargets`, `DeleteRule`, `RemoveTargets`, `DescribeRule` | `routineweave-task-*` rules only |
| Secrets Manager | `GetSecretValue` | `gemini/api_key*` only |
| SSM | `GetParameter`, `GetParameters` | `/routineweave/*` only |
| CloudWatch Logs | `CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | `/aws/lambda/routineweave-*` only |
| Lambda (basic execution) | Via `AWSLambdaBasicExecutionRole` managed policy | — |

---

## CI/CD Pipeline

`.github/workflows/deploy.yml`:

```
push to main / manual trigger
  │
  ├─ npm ci
  ├─ npm run typecheck
  ├─ npm test
  ├─ npm run build
  │
  ├─ aws-actions/configure-aws-credentials (OIDC)
  │    role: arn:aws:iam::239571291755:role/teamweave-github-actions-sam-deployer
  │
  ├─ sam build --template aws/template.yaml   (timeout: 5 min)
  └─ sam deploy --resolve-s3
       --stack-name routineweave-production
       --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
       --parameter-overrides Environment=production
```

No secrets are stored in GitHub — the Gemini API key lives exclusively in Secrets Manager and is read at Lambda runtime.

---

## Local Development

`local.ts` uses `node-cron` + `TaskLoader` (filesystem) to run tasks in-process. This path is entirely separate from the Lambda path and requires `GEMINI_API_KEY` and `SNS_TOPIC_ARN` to be set in `.env`.

```
npm run dev
  → TaskLoader reads tasks/*.json
  → JobRegistry schedules each enabled task with node-cron
  → ExecutionEngine / GeminiClient / SNSPublisher — same as production
```
