# Contributing to RoutineWeave

Thank you for helping improve RoutineWeave. This project is a TypeScript/AWS serverless scheduler for JSON-defined AI tasks.

## Development setup

**Requirements:** Node.js 20+, npm 10+.

```bash
git clone https://github.com/<owner>/RoutineWeave.git
cd RoutineWeave
npm install
cp .env.example .env   # optional for local runs that call Gemini/SNS
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript compile check |
| `npm test` | Jest unit tests (mocked AWS/Gemini) |
| `npm run build` | Emit `dist/` |
| `npm run dev` | Local scheduler (`node-cron` + `tasks/`) — needs `GEMINI_API_KEY` and `SNS_TOPIC_ARN` |
| `npm run lint` | ESLint on `src/` |

CI (`.github/workflows/deploy.yml`) runs `npm ci`, `typecheck`, `test`, and `build` on every push to `main`.

## Project layout

- `src/scheduler/` — task schema (Zod), local loader, cron registry
- `src/engine/` — prompt rendering and Gemini client
- `src/output/` — SNS, webhook, and Slack delivery handlers
- `src/storage/`, `src/events/` — S3 task store and EventBridge rule lifecycle
- `tasks/` — sample task JSON files
- `aws/template.yaml` — SAM stack for production

Architecture notes: [docs/architecture.md](docs/architecture.md). Extending output handlers: [docs/EXTENDING.md](docs/EXTENDING.md).

## Style

- TypeScript strict mode; prefer explicit types on public APIs
- Zod for runtime validation of external inputs (task JSON, env)
- Structured JSON logging via `src/utils/logger.ts`
- Keep IAM and SAM changes minimal and documented

## Tests

- Add or update tests in `src/__tests__/` for behavior changes
- Mock AWS SDK clients; do not require live cloud credentials in unit tests
- Run `npm test` before opening a PR

## Pull requests

1. Fork and create a branch from `main`
2. Keep changes focused; link related issues if any
3. Ensure `npm run typecheck` and `npm test` pass
4. Update README or `docs/` when behavior or task schema changes
5. Do not commit secrets, personal emails, or live ARNs in documentation

Maintainers review PRs for correctness, security (especially IAM and task secrets), and fit with the serverless scheduling model.
