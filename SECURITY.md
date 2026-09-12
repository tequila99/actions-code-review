# Security

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

- Prefer a [GitHub Security Advisory](https://github.com/tequila99/actions-code-review/security/advisories/new) on this repository.
- If that is unavailable, email or otherwise contact the maintainer privately, then open a public issue only after a fix is released (or after we agree the report is not sensitive).

Include a short description, the affected version or commit, and steps to reproduce.

## Secrets

Never put API keys or tokens in `.github/code-review.yml`. The action rejects keys that normalize to `token` / `secret` / `password` / `authorization` / `credential`. Pass `api_key` and `github_token` as workflow inputs or environment variables only.
