# Security notes and threat model

RoutineWeave is **operator-deployed software**. You run the SAM stack in your AWS account and supply third-party API keys. There is no multi-tenant hosted control plane in this repository.

## Assets

| Asset | Location | Sensitivity |
|-------|----------|-------------|
| Gemini API key | Secrets Manager `gemini/api_key` or `GEMINI_API_KEY` locally | High |
| Task definitions | S3 bucket `tasks/*.json` | Medium–High (may embed webhook secrets) |
| Task results | SNS, webhook endpoints, optional S3 results prefix | Medium |
| IAM role | `RoutineWeaveLambdaRole` | High (blast radius) |
| HTTP API | API Gateway (unauthenticated CRUD in default template) | High if exposed to internet |

## Trust boundaries

```
Internet / operators
        │
        ▼
  API Gateway ──► API Lambda ──► S3 (tasks)
        │
        ▼
  EventBridge ──► Scheduler Lambda ──► Gemini API
                    │
                    ├──► Secrets Manager
                    ├──► SNS / webhook / Slack
                    └──► Optional DynamoDB (observatory metrics)
```

## Threats and mitigations

### Unauthorized task modification (API)

**Risk:** Default stack exposes task CRUD over HTTP without application-level auth documented in SAM.

**Mitigations (operator responsibility):**

- Restrict API Gateway with IAM auth, JWT authorizer, or private API + VPN
- Use WAF rate limits if public
- Audit S3 bucket policies

### Secret leakage via tasks

**Risk:** `output.headers` may store API keys; S3 versioning retains history.

**Mitigations:** Use Secrets Manager/SSM references where possible; rotate keys; restrict S3 read IAM.

### Prompt injection

**Risk:** Untrusted content in `input` flows into model prompts.

**Mitigations:** Treat task authors as trusted; sanitize external feeds before injecting; limit grounding to trusted use cases.

### Webhook SSRF (outbound)

**Risk:** Scheduler Lambda POSTs to arbitrary URLs from task JSON.

**Mitigations:** Network egress policies, allow-listed domains in a fork, or a proxy layer (not implemented in core).

### Supply chain

**Risk:** npm dependencies in Lambda bundle.

**Mitigations:** `npm ci`, lockfile, periodic audit; CI runs tests on `main`.

## Local vs production

| Mode | Cloud account | Model key |
|------|---------------|-----------|
| `npm run dev` | SNS publish needs AWS creds | `GEMINI_API_KEY` in `.env` |
| Lambda | IAM role | Secrets Manager |

Examples under `examples/` run **without** API keys except where documented.

## Reporting

See [SECURITY.md](../../SECURITY.md) for vulnerability disclosure.
