# Good first issues (for maintainers to file)

Concrete, scoped tasks discovered in the codebase. Copy into GitHub issues with labels `good first issue`.

---

### 1. ESLint in CI

**Files:** `.github/workflows/deploy.yml`, `package.json`

**Task:** Add an ESLint step (`npm run lint`) to the `quality` job alongside typecheck and test.

**Acceptance criteria:** Workflow fails on lint errors; README/CONTRIBUTING mention lint in CI.

---

### 2. Document Slack output in README task table

**Files:** `README.md`, `tasks/*.json`

**Task:** Add an example task JSON with `"output": { "type": "slack", "webhook_url": "..." }` under `examples/`.

**Acceptance criteria:** Example validates via `npx ts-node examples/validate-task.ts`; README links to it.

---

### 3. `save_result` user-facing documentation

**Files:** `README.md`, `src/storage/S3ResultStore.ts`, `src/api.ts`

**Task:** Document the `save_result` task flag and `GET /results` API paths.

**Acceptance criteria:** Accurate request/response examples; no invented fields.

---

### 4. Nova / Bedrock structurer path

**Files:** `src/engine/NovaStructurer.ts`, tests

**Task:** Add unit tests for `NovaStructurer` JSON fence stripping (mirror `WebhookPublisher` tests).

**Acceptance criteria:** Tests run offline; cover fenced and plain JSON.

---

### 5. Reduce duplication in cron conversion tests

**Files:** `src/__tests__/EventBridgeManager.test.ts`, `src/events/EventBridgeManager.ts`

**Task:** Add table-driven cases for edge cron strings (`0 0 1 * *`, `*/15 * * * *`).

**Acceptance criteria:** All cases assert `toEventBridgeCron` output; existing tests still pass.

---

### 6. Local dev "dry run" mode

**Files:** `src/local.ts`, `src/orchestrator.ts`, `src/config/environment.ts`

**Task:** `DRY_RUN=true` skips Gemini and SNS/webhook/Slack calls but logs rendered prompts.

**Acceptance criteria:** Documented in README quickstart; no cloud credentials required for dry run.

---

### 7. API CORS documentation

**Files:** `aws/template.yaml`, `README.md`

**Task:** Document whether API Gateway CORS is enabled and how to call the API from a browser.

**Acceptance criteria:** Matches SAM template; if CORS is missing, issue describes adding it.

---

### 8. Task name validation error messages

**Files:** `src/api.ts`, `src/__tests__/api.test.ts`

**Task:** Return clearer 400 responses when `task_name` fails regex validation.

**Acceptance criteria:** Test asserts error body mentions allowed pattern.

---

### 9. Contract conformance CLI

**Files:** `contracts/conformance.ts`, `package.json`

**Task:** Add `npm run check:contract` that validates a sample item JSON on stdin (synthetic fixture).

**Acceptance criteria:** Script exits 0 with valid fixture, non-zero with deliberate violations.

---

### 10. Parameterize SAM email subscription

**Files:** `aws/template.yaml`

**Task:** Replace hard-coded SNS email endpoint with a CloudFormation parameter defaulting to a placeholder.

**Acceptance criteria:** Deploy docs explain setting notification email at deploy time; **no breaking change** to existing stacks without migration note in PR.
