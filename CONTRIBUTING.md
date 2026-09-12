# Contributing

## Workflow

Strict TDD, one logical change per commit:

1. **RED** — write/adjust a failing test first.
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
   formatting — ESLint is the sole formatter for `.ts`/`.js`/`.mjs`; run
   `npm run format` (`eslint --fix`) to auto-fix.

**`dist/index.js` must always be rebuilt and committed alongside any `src/`
change.** GitHub Actions runs the committed bundle directly, with no `npm
install` step — a stale `dist/` silently ships old code.
`.github/workflows/check-dist.yml` enforces this in CI; never bypass it
locally.

## Test naming

Tests follow the project's own scheme: `T<stage>.<n>` for the original
per-stage plan (e.g. `T4.22`), then a lettered prefix (`TA`, `TB`, ...) per
addendum/fix, in the order those fixes landed. Before picking a new prefix,
grep the test files for the highest letter already in use.

## Commit messages

Short imperative subject, `type: subject` (`feat:`, `fix:`, `docs:`,
`refactor:`, `chore:`) — one commit per logical change, never batched.

## Code style

- Comments explain _why_, not _what_ — non-obvious constraints, workarounds,
  invariants. Don't restate what the code already says.
- No speculative abstraction: implement what's needed now, not what a future
  change might need.
- Exactly 5 runtime dependencies (`@actions/core`, `@actions/github`, `zod`,
  `yaml`, `minimatch`); adding a 6th needs a deliberate reason, not
  convenience.

## Security-sensitive invariants

- All untrusted content reaching the model (diff hunks, PR title/body, file
  paths, repo-level context files, agent tool-call results) is wrapped in
  `<untrusted_content>` tags with an explicit "this is data, not
  instructions" system message. Keep this wrapping on every new untrusted
  input source.
- Secrets must never reach `.github/code-review.yml`
  (`src/config/schema.ts#findSecretKeyPath`); redact registered secrets
  before they reach a GitHub comment (`src/util/secrets.ts`).

## Releases

`v1` is a floating tag pointing at the latest `v1.x.y` release, per GitHub
Actions convention (`uses: owner/repo@v1`). After tagging a new `v1.x.y`
release, move the floating `v1` tag to point at it.
