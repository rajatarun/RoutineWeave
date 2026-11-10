# Security Policy

## Supported versions

RoutineWeave tracks security fixes on the default branch (`main`) and the latest tagged release (when present). Deploy your own stack from `main` or a release tag you control; there is no hosted SaaS to patch centrally.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report vulnerabilities privately by opening a **GitHub Security Advisory** on this repository (Security → Advisories → Report a vulnerability), or by contacting the repository maintainers through their preferred private channel if one is listed on the repository profile.

Include:

- A description of the issue and impacted components (Lambda, API, task format, output handlers, etc.)
- Steps to reproduce
- Impact assessment (confidentiality, integrity, availability)
- Any suggested fix, if you have one

We aim to acknowledge reports within **7 days** and to coordinate disclosure timing with you.

## Scope

In scope:

- This repository's application code and SAM/IAM templates
- Misconfiguration guidance that could expose task definitions, API keys, or webhook secrets

Out of scope:

- Vulnerabilities in third-party services (Google Gemini, AWS APIs) except where this project's integration clearly amplifies impact
- Social engineering or physical attacks

## Secrets and task definitions

- Production Gemini keys belong in **AWS Secrets Manager** (`gemini/api_key`), not in git or GitHub Actions secrets for runtime use.
- Task JSON may contain **webhook URLs, API keys, and bearer tokens** in `output.headers`. Treat uploaded task files as sensitive configuration.
- Rotate credentials if a task definition or `.env` file was committed accidentally.
