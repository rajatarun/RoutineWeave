# Launch draft (not published)

Use this as a starting point for a blog post, README announcement, or community post. **Do not invent adoption metrics.**

---

## Title (draft)

**RoutineWeave: cron-scheduled AI tasks as JSON, delivered to your inbox**

## Problem

Teams want recurring AI summaries—news digests, price checks, standup briefs—without maintaining a bespoke cron container, prompt glue, and notification pipeline. Serverless schedulers exist; model APIs exist; wiring them with safe secrets handling and per-task schedules is repetitive.

## Why it matters

- **Declarative tasks** — schedule + prompt + inputs live in versioned JSON
- **No redeploy to change schedules** — upload task files to S3; EventBridge rules follow automatically
- **Honest about cloud** — production runs on AWS Lambda, EventBridge, S3, SNS; local dev uses the same engine with `node-cron`

## What RoutineWeave does

1. Stores task definitions in S3 (or `tasks/` locally)
2. Converts each task's cron into an EventBridge rule via the Registrar Lambda
3. At fire time, renders `{{variables}}`, calls Google Gemini (optional search grounding), and routes output to SNS, webhook, or Slack

## Quick proof (synthetic)

Offline prompt-render throughput (see `examples/eval-prompt-render.ts` — run locally; results vary by machine):

Example run on Node 20 (synthetic; your numbers will differ):

```json
{
  "label": "synthetic_prompt_render",
  "iterations": 50000,
  "elapsed_ms": 71.69,
  "renders_per_second": 697484
}
```

Reproduce: `npx ts-node examples/eval-prompt-render.ts`

## Honest limits

- **AWS required for production** — not a fully local-first hosted product; you deploy the SAM stack
- **Gemini today** — other model providers are integration opportunities (see `docs/INTEGRATIONS.md`)
- **Task secrets** — webhook headers and bearer tokens live in task JSON; treat uploads as sensitive config
- **Slack** — uses Incoming Webhooks, not the full Slack OAuth app model

## Communities where this fits

- **AWS serverless** — EventBridge + Lambda practitioners
- **Indie hackers / personal automation** — scheduled digests via email or Slack
- **MCP / observability** — optional shared metrics contract with mcp-observatory
- **Open-source schedulers** — compare with Temporal, Windmill, or plain EventBridge; RoutineWeave is intentionally narrow (prompt + single model call + notify)

## Call to action (draft)

Clone the repo, run `npm test`, try `npx ts-node examples/render-prompt.ts`, deploy the SAM template to your account, and upload `tasks/ai_news_digest.json`.
