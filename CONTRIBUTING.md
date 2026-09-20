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

## Branches and pull requests

Work starts from an issue. Branch off `develop`:

```
feature/<issue>-<slug>   # new functionality
fix/<issue>-<slug>       # bug fix
chore/<issue>-<slug>     # tooling, docs, refactoring, dependencies
```

`<issue>` is the GitHub issue number, `<slug>` is lowercase letters, digits
and hyphens (e.g. `chore/10-pr-template-branch-guard`).

- PRs into `develop` must come from such a branch, with the title
  `[#<issue>] <name>` (e.g. `[#10] Add PR template and branch guard`); the
  number in the title must match the one in the branch name.
- `main` only receives release PRs from `develop`, titled with the version
  (`v1.2.3`). Nothing else may target `main`.
- Dependabot PRs target `develop` and are exempt from the naming rules.

`.github/workflows/branch-guard.yml` enforces all of the above; the PR
template lives in `.github/PULL_REQUEST_TEMPLATE.md`. Commit messages inside
a branch still follow the `type: subject` convention below.

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
