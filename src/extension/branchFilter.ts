/**
 * Pure (vscode-free) branch-filter helpers shared by the extension host.
 *
 * The Branches side-view drives a per-repo filter: a list of selected branch
 * refs. An empty list means "show all branches" (matching `loadCommits`, which
 * treats an empty `branchNames` as all). These helpers compute the initial
 * selection from config and keep a stored selection valid as branches come and
 * go. Kept import-free of `vscode` so they can be unit-tested in the backend
 * test project.
 */

/** Order-insensitive equality of two branch-filter selections. */
export function branchFilterEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = b.toSorted();
  return a.toSorted().every((value, i) => value === sortedB[i]);
}

/** Drop selected refs that no longer exist (e.g. a deleted branch, or remote
 *  branches once "show remote branches" is turned off) so the graph's `git log`
 *  never references a missing ref. Preserves the original order of survivors. */
export function pruneBranchFilter(
  filter: readonly string[],
  available: readonly string[]
): string[] {
  const set = new Set(available);
  return filter.filter((branch) => set.has(branch));
}

/** The selection shown when a repo is first opened, mirroring the legacy
 *  dropdown default: the configured specific branches that exist, plus the
 *  checked-out branch when `selectCheckedOutBranch` is on. An empty result
 *  means "show all". */
export function computeDefaultBranchFilter(
  branches: readonly string[],
  head: string | null,
  opts: { showSpecificBranches: readonly string[]; showCurrentBranchByDefault: boolean }
): string[] {
  const result: string[] = [];
  for (const branch of opts.showSpecificBranches) {
    if (branches.includes(branch) && !result.includes(branch)) result.push(branch);
  }
  if (opts.showCurrentBranchByDefault && head !== null && !result.includes(head)) {
    result.push(head);
  }
  return result;
}

/** Resolve the filter to apply for a repo given its current branch list: prune
 *  an existing selection, falling back to the configured default when nothing
 *  valid remains or no selection has been made yet. */
export function resolveBranchFilter(
  existing: readonly string[] | undefined,
  branches: readonly string[],
  head: string | null,
  opts: { showSpecificBranches: readonly string[]; showCurrentBranchByDefault: boolean }
): string[] {
  if (existing !== undefined) {
    // An explicit empty selection is the user's "show all" choice — preserve it
    // rather than re-deriving the configured default.
    if (existing.length === 0) return [];
    const pruned = pruneBranchFilter(existing, branches);
    // Keep the selection while at least one ref survives; only fall back to the
    // default when a non-empty selection has been pruned away to nothing.
    if (pruned.length > 0) return pruned;
  }
  return computeDefaultBranchFilter(branches, head, opts);
}
