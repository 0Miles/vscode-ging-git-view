import type { GitRepoState, RepoScopeSettings } from "@/types";

/**
 * Per-repo settings resolution, kept free of vscode so it can be tested on its
 * own.
 *
 * A repo's state holds overrides, not values: null or missing means "use the
 * global setting", which is why the Repository Settings dialog (#183) can offer
 * a shortcut to them without becoming a second copy of them.
 */

/** Every field of {@link RepoScopeSettings}, in the order the loader reads them. */
const REPO_SCOPE_FIELDS: readonly (keyof RepoScopeSettings)[] = [
  "onlyFollowFirstParent",
  "includeReflogCommits",
  "showStashes",
  "showTagOnlyCommits",
  "showRemoteHeads"
];

/** The repo's load scope: its override where it has one, the global setting
 *  where it does not. `state` is undefined for a repo the manager does not
 *  hold, which gets the global settings throughout. */
export function resolveRepoScope(
  state: GitRepoState | undefined,
  defaults: RepoScopeSettings
): RepoScopeSettings {
  const resolved = { ...defaults };
  for (const field of REPO_SCOPE_FIELDS) {
    const override = state?.[field];
    if (typeof override === "boolean") resolved[field] = override;
  }
  return resolved;
}

/** The fields the Branches side-view draws itself from. */
const SIDE_VIEW_FIELDS = [
  "showRemoteBranches",
  "showInactiveBranches",
  "showMergedBranches"
] as const;

/** Whether a repo-state write moved anything the Branches side-view shows.
 *
 *  The webview persists its repo state for reasons that have nothing to do
 *  with the side-view — a column drag, a details-panel resize — so re-listing
 *  the view on every save would be work for nothing. A missing field and an
 *  explicit null both mean "use the global setting", so they compare equal. */
export function sideViewStateChanged(
  before: GitRepoState | undefined,
  after: GitRepoState
): boolean {
  return SIDE_VIEW_FIELDS.some((field) => (before?.[field] ?? null) !== (after[field] ?? null));
}
