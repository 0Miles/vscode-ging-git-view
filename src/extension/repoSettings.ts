import type { GitRepoState, RepoScopeSettings } from "@/types";

/**
 * Per-repo settings resolution, kept free of vscode so it can be tested on its
 * own.
 *
 * A repo's state holds overrides, not values: null or missing means "use the
 * global setting", which is why the Repository Settings drawer (#183) can offer
 * a shortcut to them without becoming a second copy of them.
 */

/** Every field of {@link RepoScopeSettings}. A record rather than a list so the
 *  compiler holds it to the type: a field added there and missed here would
 *  be written by the drawer and silently ignored by the loader. */
const REPO_SCOPE_FIELDS = Object.keys({
  onlyFollowFirstParent: true,
  includeReflogCommits: true,
  showStashes: true,
  showTagOnlyCommits: true,
  showRemoteHeads: true
} satisfies Record<keyof RepoScopeSettings, true>) as (keyof RepoScopeSettings)[];

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

/** One of the side-view's toggles, named by the repo-state field it writes. */
export type SideViewField = (typeof SIDE_VIEW_FIELDS)[number];

/** Whether a repo-state write moved anything the Branches side-view shows.
 *
 *  Most writes have nothing to do with the side-view — the graph persists its
 *  repo state on a column drag or a details-panel resize — so re-listing the
 *  view on every write would be work for nothing. A missing field and an
 *  explicit null both mean "use the global setting", so they compare equal. */
export function sideViewStateChanged(
  before: GitRepoState | undefined,
  after: GitRepoState
): boolean {
  return SIDE_VIEW_FIELDS.some((field) => (before?.[field] ?? null) !== (after[field] ?? null));
}
