/** The subset of a PR's own fields `shouldSkip` needs (not the full Octokit payload shape). */
export interface PullRequestInfo {
  draft: boolean
  labels: readonly string[]
}

export type SkipReason = 'draft' | 'label' | null

/** The subset of `ResolvedConfig` that `shouldSkip` needs. */
export interface SkipFiltersConfig {
  filters: {
    skip_drafts: boolean
    skip_labels: readonly string[]
  }
}

/**
 * FR-14/FR-15: decides whether this PR should be skipped entirely (no diff
 * fetched, no model call, no review published) before any other work
 * happens. `'draft'` is checked before `'label'` — both are mutually
 * exclusive skip *reasons* reported to the caller (only one is surfaced),
 * not a priority judgement about which condition "matters more".
 */
export function shouldSkip (pr: PullRequestInfo, config: SkipFiltersConfig): SkipReason {
  if (pr.draft && config.filters.skip_drafts) return 'draft'
  if (
    config.filters.skip_labels.length > 0 &&
    pr.labels.some((l) => config.filters.skip_labels.includes(l))
  ) {
    return 'label'
  }
  return null
}
