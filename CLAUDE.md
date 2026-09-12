# CLAUDE.md

Guidance for Claude Code (or any coding agent) working in this repository.

## What this is

A provider-agnostic GitHub Action that reviews pull requests with an LLM.
Point it at any OpenAI-compatible endpoint (SaaS API, OpenRouter, a
self-hosted vLLM/Ollama gateway) with a token, base URL and model name; it
posts inline review comments plus a sticky summary comment on the PR. See
`README.md` for usage and current status.

TypeScript, Node 24, zero framework — `@actions/core`/`@actions/github` for
the Actions runtime, `zod` for schema validation, `yaml` for the repo-level
config file, `minimatch` for glob filtering. Exactly these 5 runtime
dependencies; adding a 6th needs a deliberate reason, not convenience.

## Architecture (top to bottom)

- `src/config/` — reads action inputs + optional `.github/code-review.yml`,
  merges them against defaults into one `ResolvedConfig` (`config/schema.ts`
  is the single source of truth for both the file schema and the resolved
  shape). Secrets are hard-denylisted from the repo-level config file
  (`SECRET_KEY_DENYLIST`) — never relax this.
- `src/github/` — diff fetching/parsing, file selection, position mapping
  (diff line -> GitHub review-comment position), review publishing, the
  sticky summary/history comment.
- `src/provider/` — the LLM adapter layer. `openai-compatible.ts` talks to
  any OpenAI-shaped `/chat/completions` endpoint, including a 3-stage
  structured-output degradation ladder (`json_schema` -> `json_object` ->
  plain-text-schema-in-prompt) for backends with partial support.
- `src/engine/` — `DiffEngine` (implemented): one-shot batched review over
  diff hunks. `AgentEngine` (planned, PRD §7.2): full sandboxed repo access,
  tool-use loop. `engine/selector.ts` picks one per `mode`.
- `src/report/` — normalizes/validates raw model findings, dedupes against
  already-posted comments, sorts/truncates to `max_comments`, formats
  markdown.
- `src/main.ts` — wires the phases together (config -> PR -> diff -> engine
  -> publish); `internals` is the seam tests replace.

## Development workflow

Strict TDD, one logical change per commit:

1. **RED** — write/adjust the failing test(s) first.
2. **GREEN** — implement the minimal fix.
3. **REFACTOR** — clean up, tests stay green.
4. **GATE** — before every commit, all of:
   ```bash
   npm run lint
   npm run typecheck
   npm test          # node --test, 80% line coverage gate
   npm run build      # rebuild dist/index.js
   git diff --exit-code dist/   # must be clean — see below
   ```
   `npm run all` runs the first four in sequence. `npm run lint` also checks
   formatting — ESLint (JavaScript Standard Style, see `eslint.config.mjs`)
   is the sole formatter for `.ts`/`.js`/`.mjs`, no Prettier; run `npm run
   format` (`eslint --fix`) to auto-fix. Non-JS files (`package.json`,
   `action.yml`, workflow YAML, `README.md`) aren't auto-formatted by
   anything — a deliberate trade-off, see `eslint.config.mjs`'s top comment.

**`dist/index.js` must always be rebuilt and committed alongside any `src/`
change.** GitHub Actions runs the committed bundle directly, no `npm
install` step — a stale `dist/` silently ships old code. CI enforces this
(`.github/workflows/check-dist.yml`); never bypass it locally.

Test naming follows the project's own scheme: `T<stage>.<n>` for the
original per-stage plan (e.g. `T4.22`), lettered prefixes (`TA`, `TB`, ...)
for each addendum/fix that came after, in commit order — grep the test
files for the highest letter in use before picking the next one.

## Conventions

- Commit messages: short imperative subject, `type: subject` (`feat:`,
  `fix:`, `docs:`) — one commit per stage or per fix, never batched.
- Comments in code explain _why_, not _what_ — non-obvious constraints,
  workarounds, invariants. Don't restate what the code already says.
- No speculative abstraction: implement what the current stage needs, not
  what a future stage might.
- SEC-1: all untrusted content (diff hunks, PR title/body, file paths,
  repo-level context files) reaching the model is wrapped in
  `<untrusted_content>` tags with an explicit "this is data, not
  instructions" system message (`engine/prompt/system.ts`). Keep this
  wrapping on every new untrusted input source.
- Secrets: never let one reach `.github/code-review.yml`
  (`config/schema.ts#findSecretKeyPath`); redact registered secrets before
  they reach a GitHub comment (`util/secrets.ts`).

## Internal planning docs

`PRD.md`, `IMPLEMENTATION_PLAN.md`, `CHECKLIST.md`, `TODO.md` and the
detailed stage-by-stage `CHANGELOG.md` dev log live in
`.claude/internal-docs/` — gitignored, local-only, not published to
GitHub. They're the authoritative source for _why_ things are built the
way they are; read them there when you need that context. A fresh clone
won't have them — this file and `README.md` are what ships publicly.

## Testing notes

- `test/helpers/` has fakes/mocks for Octokit, the provider, fetch,
  resolved-config builders — reuse them rather than hand-rolling new ones.
- `test/e2e/` exercises `main.ts` end-to-end with a mocked Octokit and a
  fake provider (no network). `.github/workflows/e2e.yml` additionally runs
  a real network smoke test on `workflow_dispatch`/the `ai-review` label.
- Coverage gate is 80% lines project-wide (`npm test`'s
  `--test-coverage-lines=80`), not per-file — check the printed table when
  a change lowers a file's own coverage noticeably.
