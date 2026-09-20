# AI Code Review

Provider-agnostic AI code review for GitHub pull requests. Point it at any
OpenAI-compatible endpoint — a SaaS API, OpenRouter, a self-hosted
vLLM/Ollama gateway — with just a token, base URL and model name, and it
posts inline review comments plus a running-history summary comment on the
PR.

> **Status: public beta.** `mode: diff` (single-shot review over the PR's
> diff) and `mode: agent` (full sandboxed repo access, tool-use loop) are
> both implemented and tested, against `api_flavor: openai` (any
> OpenAI-compatible endpoint) or the native `api_flavor: anthropic`.
> `mode: auto` (pick diff vs. agent by PR size) and a native `gemini` wire
> dialect are still planned — see [Status](#status--roadmap) below.

## What it does

- Reviews a pull request's diff and posts findings as inline review
  comments (severity, category, message), plus one review-level summary.
- Maintains a **sticky comment** with a capped history (last 20 entries) of
  every run on the PR — mode, model, files/findings/tokens/cost and the
  model's own summary of the change (sanitised, capped at 3000 chars) —
  instead of overwriting itself each time, so you can compare multiple runs
  (different models, incremental re-reviews) at a glance.
- Deduplicates findings against comments already posted on the PR, so
  re-running on a PR (e.g. after new commits) doesn't repeat itself.
- Supports **incremental review**: on a re-run, only reviews commits added
  since the last review when possible.
- Auto-detects Russian vs. English from the PR title when no language is
  configured explicitly (falls back to English).
- Every finding's inline comment carries a small `<sub>` footer naming the
  model that produced it — useful when comparing several models on the
  same PR.
- Splits large diffs into multiple batched model calls (`max_model_calls`)
  and reports anything it had to skip (`truncated`, `notes`) rather than
  silently dropping it.
- `dry_run: true` runs the full pipeline (including cost/token accounting)
  without publishing anything; the model's summary, the engine's notes and the
  findings it would have posted are printed to the step log (group
  `dry-run: findings`).

## Quick start

```yaml
name: AI Code Review
on:
  pull_request:
    types: [labeled, synchronize]

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >
      (github.event.action == 'labeled' && github.event.label.name == 'ai-review') ||
      (github.event.action == 'synchronize' && contains(github.event.pull_request.labels.*.name, 'ai-review'))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # needed for agent mode and incremental review

      - uses: tequila99/actions-code-review@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          api_key: ${{ secrets.LLM_API_KEY }}
          api_base_url: https://openrouter.ai/api/v1
          model: qwen/qwen3-coder
          mode: diff
          language: ru
          fail_on_severity: none
```

Switching to an internal gateway (self-hosted vLLM/Ollama) is a `with:` diff:

```yaml
api_base_url: http://vllm.internal.corp/v1
allow_insecure_base_url: true # plain http inside a trusted perimeter
model: Qwen3-Coder-30B
api_headers: |
  X-Tenant-Id: platform
```

Switching to [gptunnel.ru](https://gptunnel.ru) (RUB billing, no
international card needed) is also just a `with:` diff — its
`/chat/completions` auth is a raw API key, not `Bearer <key>`, so the key
goes through `api_headers` instead of `api_key`:

```yaml
api_base_url: https://gptunnel.ru/v1
api_key: '' # gptunnel takes a raw key, not "Bearer <key>" — leave this empty
api_headers: |
  Authorization: ${{ secrets.GPTUNNEL_API_KEY }}
model: deepseek-v4-flash # see https://gptunnel.ru/v1/models for other ids
```

Prices are quoted in ₽/1K tokens on gptunnel.ru's own pricing page and run
roughly 1.5–5x+ OpenRouter for the same underlying model (median ≈3.4x on
input tokens across its catalog, checked 2026-08-09) — the reason to use
it is RUB billing or access to models OpenRouter doesn't carry, not price.
Within its own catalog the closest-to-fair pricing is DeepSeek V4
Pro/Flash and Qwen 3 Coder (~$0.3–$2 per 1M tokens, ~1.6–2.5x OpenRouter
rather than the usual 3x+). `mode: agent`'s tool-calling and `mode:
diff`'s structured output aren't documented for this endpoint — check
`dry_run: true` output before relying on either.

gptunnel.ru also proxies YandexGPT and GigaChat, the two most prominent
Russian-market models — neither fits this action well today. YandexGPT
tops out at 32K context (2K on most variants), too small for anything but
a trivial diff and unworkable for `mode: agent`'s growing tool-loop
history. GigaChat 2 Max/Lite reach 128K, technically enough for `mode:
diff` on small-to-medium PRs, but neither vendor's function-calling
support through this proxy is confirmed, and 128K is still well below the
400K+ windows the models above already handle comfortably. Pick either
only if data residency, not price or capability, is the deciding factor.

## Agent mode

`mode: diff` above is a single batched pass over the PR's diff hunks —
cheap and fast, but the model only ever sees the diff itself. `mode: agent`
instead runs a tool-use loop (`get_diff`, `grep`, `read_file`,
`list_files`, `post_comment`, `finish`): the model can read whole files,
grep the repo for related code, and report findings as it goes, which
matters for anything where correctness depends on context outside the
diff (a changed function's callers, a type defined elsewhere, an
unawaited promise whose effect only shows up two files away).

Because it can read a file in full, `post_comment` may also attach a
literal code-suggestion (GitHub's "Apply suggestion" button) — the
handler re-reads the target lines from disk and only keeps the
suggestion if they match exactly what the model was shown, so a stale
read can't corrupt the file. Off-switch: `agent_allow_suggestions: false`.

It costs more and needs `fetch-depth: 0` (agent mode reads arbitrary
files from the checkout, not just the diff). Two configurations with
budget numbers tuned on real PRs, not guessed:

```yaml
# Anthropic Messages API (native api_flavor: anthropic)
- uses: tequila99/actions-code-review@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    api_base_url: https://api.anthropic.com
    api_flavor: anthropic
    model: claude-opus-4-6
    mode: agent
    language: ru
    fail_on_severity: none
    incremental: false
    agent_token_budget: 800000
    max_output_tokens: 10000
    agent_max_iterations: 30
```

```yaml
# glm-5.2 via OpenRouter
- uses: tequila99/actions-code-review@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    api_key: ${{ secrets.LLM_API_KEY }}
    api_base_url: https://openrouter.ai/api/v1
    model: z-ai/glm-5.2
    mode: agent
    language: ru
    fail_on_severity: none
    incremental: false
    agent_token_budget: 800000
    max_output_tokens: 10000
    agent_max_iterations: 30
    request_timeout_ms: 240000
```

### Tuning the loop's budgets

The loop resends its full, growing message history on every iteration
(no context pruning), so cost grows faster than linearly with iteration
count — raise these deliberately, not by reflex:

| Input                   | Default  | What it caps                                             | When to raise it                                                                                                                          |
| ------------------------ | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_max_iterations`   | `20`     | Tool-use round-trips.                                     | Run ends with `stopped (iteration_limit)` in the sticky comment/debug log while the other budgets below still have headroom, and the findings already posted look genuine (not repeated/empty exploration). |
| `agent_token_budget`     | `300000` | Cumulative prompt+completion tokens across the whole run. | Same signal as above, or you raised `agent_max_iterations` and this becomes the new binding limit.                                          |
| `agent_max_tool_calls`   | `200`    | Total tool invocations.                                  | A ceiling, not a working budget: models batch several calls per turn, so a low value silently binds before `agent_max_iterations` does. Look for `stopped (tool_call_limit)` in the debug log.       |
| `max_output_tokens`      | `4000`   | Output tokens per single model call.                     | Reasoning-heavy models can spend this entire budget on hidden reasoning tokens with nothing left for the actual response, forcing a costly truncate-and-retry. `10000` avoids this in practice.        |
| `request_timeout_ms`     | -        | Timeout for one model call.                               | Slower providers/models (e.g. some OpenRouter-routed models) need more headroom than the default; `240000` has worked well.                 |
| `total_timeout_ms`       | `900000` | Wall-clock budget for the whole run.                       | Rarely the binding constraint once the above are sized correctly.                                                                            |

Each of the five budgets above has its own independent "wrap up now"
nudge: a one-time message telling the model to post everything it has
found and call `finish` rather than keep exploring. It fires when only
~3 iterations remain, or when less than 20% is left of
`total_timeout_ms`, `agent_token_budget`, `agent_max_tool_calls` or
`budget.max_cost_usd`. Each needs its own trigger because any one of
them can be exhausted long before the others — a slow model burns the
clock in a handful of iterations, a thorough one burns tokens, and a
model that batches 4-6 calls per turn burns the tool-call ceiling. This
is why a well-tuned run reliably ends with `stopped (finished)` instead
of running out of something.

If a run is cut short anyway *and* has posted nothing at all, the engine
makes one final call with the tool surface narrowed to
`post_comment`/`finish`, so whatever the model had already worked out
still reaches the PR instead of the whole run being wasted. The one
exception is `budget.max_cost_usd`: that ceiling is a hard cost limit
and is already spent, so nothing further is spent against it.

Set `debug: true` to see the nudges, the last-chance turn, and every
tool call/response in the workflow log.

### Web search (opt-in)

Off by default. When enabled (`agent_web_search: true`), the model gets
a `web_search` tool for questions the checkout genuinely can't answer —
how a dependency behaves internally, current API/CVE details — instead
of either guessing or burning iterations grepping for `node_modules`
source that was never installed (the action never runs `npm install`).

Requirements and limits:

- **OpenRouter only, for now.** The handler calls OpenRouter's native
  `openrouter:web_search` server tool directly, so `api_base_url` must
  be `https://openrouter.ai/api/v1`. Enabling it against any other
  endpoint logs a warning at config time and the tool errors on every
  call at runtime.
- `agent_web_search_max_calls` (default `4`) caps calls to this tool
  specifically, independent of `agent_max_tool_calls` — it's the actual
  cost control for this feature.
- This sub-call's tokens/cost are **not** included in
  `cost_estimate_usd` / `budget.max_cost_usd` — `agent_web_search_max_calls`
  is what bounds it instead.

Security tradeoff, in plain terms: this is the only tool in the project
that makes an outbound network call, so it's also the only place a
successful prompt injection (a malicious PR title/description/comment
tricking the model) could exfiltrate something via the search query. The
query is passed through the same `redact()` used everywhere else in this
project, which **only** masks the exact `api_key`/`github_token` values
if they appear verbatim — it is not a general secrets/PII scrubber and
does not stop a crafted query from leaking other repository content.
Leave this off unless the investigation-loop failure mode above is
something you've actually hit.

Not every finding the model reports ends up as an inline PR comment: if
a finding's line isn't part of the diff (the model read a whole file via
`read_file` and something outside the changed lines caught its eye),
GitHub's Reviews API would reject the entire review over that one
comment, so it's demoted to text-only and listed under **Findings not
posted inline** in the sticky comment instead — nothing is lost, it's a
safety net, not a bug.

## Permissions

The action itself does not declare `permissions:` — that is the calling
workflow's responsibility. It needs:

```yaml
permissions:
  contents: read # read code and diffs
  pull-requests: write # publish the review and inline comments
```

`issues: write` is **not** required: the sticky summary comment is published
via `issues.createComment`, but pull requests are issues under the hood, so
`pull-requests: write` alone is sufficient. `id-token: write` is not required
either — there is no OIDC usage in v1.

**Pull requests from forks:** on the default `pull_request` trigger, GitHub
issues a read-only `GITHUB_TOKEN` for PRs opened from a fork, regardless of
the `permissions:` block above. This action's own `createReview` call gets
an HTTP 403 in that case, which fails the run with a clear error message
(rather than silently doing nothing or falling back to a partial review).
Getting write access for fork PRs requires switching to the
`pull_request_target` trigger, which runs with the base repo's token and
permissions against untrusted fork code — this action does not currently
document or test a safe `pull_request_target` setup, so it isn't supported
yet.

## Inputs and outputs

`action.yml` is the single source of truth for every input (37 total) and
its default, and for the 14 outputs this action produces. See it directly
for the full, exact list.

The inputs worth knowing about first:

| Input                         | Purpose                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `model`                       | **Required**, no default. Model name in the terms the provider expects.                                                  |
| `api_key` / `github_token`    | Secrets. Read from inputs, or the `CODE_REVIEW_API_KEY` / `GITHUB_TOKEN` env vars if left empty.                         |
| `api_base_url` / `api_flavor` | Which provider/dialect to talk to. `api_flavor` is `openai` or `anthropic` today (`gemini` planned). For `anthropic`, `api_base_url` must be the bare host (`https://api.anthropic.com`, no `/v1`) — the adapter appends `/v1/messages` itself. |
| `mode`                        | `diff` (default) or `agent` — see [Agent mode](#agent-mode). `auto` is planned.                                          |
| `config_path`                 | Where to look for the repo-level config file (default `.github/code-review.yml`).                                        |
| `fail_on_severity`            | `none \| medium \| high` — fail the job when findings at/above this severity are found, _after_ the review is published. |
| `dry_run`                     | Run the full review, publish nothing. Summary, notes and findings are printed to the step log.                           |
| `incremental`                 | Only review new commits since the last review, when possible (default `true`).                                           |

Every output is always set, even on an early exit (draft PR, skip label,
etc.) — check `skipped_reason` to tell a real review apart from a skip.

## Repository-level configuration

An optional YAML file in the _reviewed_ repository (default
`.github/code-review.yml`, configurable via the `config_path` input) lets
you set review scope, focus areas, and per-path instructions without
touching the workflow file. Every field is optional; an absent or empty
file is valid.

```yaml
version: 1

filters:
  include: ['src/**'] # empty/absent = everything not excluded
  exclude: ['**/*.generated.ts']
  max_files: 50
  max_diff_bytes: 400000
  skip_drafts: true
  skip_labels: ['no-ai-review']
  context_lines: 6 # 0-30, unchanged lines of context shown around each diff hunk

review:
  language: ru
  max_comments: 25
  fail_on_severity: high
  summary_only: false
  focus:
    - SQL injection
    - N+1 queries
  ignore:
    - formatting nitpicks
  path_instructions:
    - path: 'src/payments/**'
      instructions: 'Pay extra attention to currency rounding and idempotency.'
  custom_instructions: 'Prefer terse comments. This is a legacy codebase — do not suggest large refactors.'

context:
  always: ['docs/STYLE_GUIDE.md'] # sent on every review, regardless of files touched
  layers:
    - path: 'src/payments/**'
      context_files: ['docs/payments-architecture.md']
  max_context_bytes: 60000

agent: # only used by mode: agent — see Agent mode below
  max_iterations: 30
  token_budget: 800000
  web_search:
    enabled: true
    max_calls: 4

budget:
  max_cost_usd: 2.0
  pricing: # only needed if your provider doesn't report cost itself
    input_per_1m: 0.15
    output_per_1m: 0.6

api:
  headers:
    X-Tenant-Id: platform
```

A few built-in excludes (lock files, minified assets, source maps, common
generated/vendor directories, binary/image formats, snapshot files) are
always applied on top of your own `filters.exclude`.

**Never put secrets in this file.** `api_key`, `github_token`, and any key
that normalizes to `token`/`secret`/`password`/`authorization`/`credential`
is rejected outright, wherever it appears in the file — those belong to
workflow inputs only.

The `agent` block above (`max_iterations`, `max_tool_calls`,
`token_budget`, `tool_output_max_bytes`, `tools`, `web_search`) mirrors the
`agent_max_iterations`/`agent_max_tool_calls`/`agent_token_budget`/
`agent_web_search`/`agent_web_search_max_calls` workflow inputs described
in [Agent mode](#agent-mode) — set the budgets here to tune them per-repo
without touching the workflow file; a workflow input, when set, wins over
this file.

**Known limitation — the token budgets are blind to prompt caching.**
Providers bill a cached prompt token at a fraction of the input rate
(OpenRouter prices `x-ai/grok-4.6`'s cache read at $0.50/1M against a
$2.00/1M input rate), but it still arrives in `usage.prompt_tokens` at full
weight, and nothing here subtracts it. Two consequences, both specific to
`mode: agent`, which re-sends a growing prefix every turn and therefore
caches extremely well:

- `agent_token_budget` measures how much context the run moved, not how
  much it cost.
- `budget.max_cost_usd` is enforced by applying `pricing.input_per_1m` to
  every prompt token, cached or not, so it stops a run earlier than you
  asked. On a measured production run — 1.38M prompt tokens over 23 turns,
  ~93% of them cache hits — the formula gives $2.89 where the provider
  actually charged $0.96.

`cost_estimate_usd` is unaffected whenever the provider reports its own
cost (OpenRouter does): the real figure always wins over the estimate. So
if you set `max_cost_usd`, size it against what your provider actually
bills rather than against the token math. Note that leaving `pricing` unset
does not sidestep this — `max_cost_usd` is then not enforced at all, and
the run logs a warning saying so.

## Status / Roadmap

Implemented and tested: project scaffolding,
config loading/merging, GitHub diff handling, the OpenAI-compatible
provider adapter (with a structured-output degradation ladder for
partial-support backends), the native Anthropic Messages API adapter
(`api_flavor: anthropic` — tool calling via `tool_use`/`tool_result`
blocks, structured output via `output_config`, no sampling params/legacy
thinking config sent, per Claude Opus 5/Sonnet 5's own constraints),
`DiffEngine`, `AgentEngine` (full sandboxed repository access via a
tool-use loop, with wrap-up nudging and provider-error recovery), review
publishing (inline comments + sticky history comment + dedup +
truncation), and the packaged action itself (`action.yml`, `dist/index.js`,
e2e smoke test).

Planned next: a native `gemini` wire dialect, `mode: auto` (pick diff vs.
agent based on PR size) with cost budgets and richer metrics, and a v1.0
documentation pass.

## Development

```bash
npm ci
npm test          # node --test, 80% line coverage gate
npm run build      # esbuild -> dist/index.js (must be committed, see check-dist.yml)
npm run lint        # eslint - typescript-eslint recommended + JavaScript Standard Style
npm run format      # eslint --fix - Standard is also the formatter (no Prettier)
npm run typecheck  # tsc --noEmit
npm run all        # lint + typecheck + test + build
```

`dist/index.js` is committed and must always match `src/` — GitHub Actions
runs the bundle directly, without an install step. CI
(`.github/workflows/check-dist.yml`) rebuilds and diffs it on every PR.

## License

[MIT](./LICENSE)
