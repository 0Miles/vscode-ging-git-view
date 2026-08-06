import type { CommitOrdering } from "@/backend/types";

const commitOrderFlag: Record<CommitOrdering, string> = {
  date: "--date-order",
  "author-date": "--author-date-order",
  topo: "--topo-order"
};

export function gitLogTraversalArgs(
  commitOrder: CommitOrdering,
  onlyFollowFirstParent: boolean
): string[] {
  return onlyFollowFirstParent
    ? [commitOrderFlag[commitOrder], "--first-parent"]
    : [commitOrderFlag[commitOrder]];
}

export type GitLogScope = {
  branchNames: string[];
  showRemoteBranches: boolean;
  hiddenRemotes: string[];
  includeTagOnlyCommits?: boolean;
  includeReflogCommits?: boolean;
};

/** Build the revision arguments shared by bounded and unbounded graph queries. */
export function gitLogScopeArgs(scope: GitLogScope): string[] {
  const args: string[] = [];
  const globs = scope.branchNames
    .filter((branch) => branch.startsWith("glob:"))
    .map((branch) => branch.slice(5));
  const named = scope.branchNames.filter((branch) => branch !== "" && !branch.startsWith("glob:"));
  const showAll = scope.branchNames.length === 0 || scope.branchNames.includes("");

  if (!showAll) {
    for (const glob of globs) {
      args.push("--branches=" + glob);
      if (scope.showRemoteBranches) {
        for (const remote of scope.hiddenRemotes) args.push("--exclude=" + remote + "/*");
        args.push("--remotes=" + glob);
      }
    }
    if (named.length > 0) args.push(...named, "--");
    return args;
  }

  args.push("--branches");
  if (scope.includeTagOnlyCommits) args.push("--tags");
  if (scope.showRemoteBranches) {
    for (const remote of scope.hiddenRemotes) args.push("--exclude=" + remote + "/*");
    args.push("--remotes");
  }
  if (scope.includeReflogCommits) args.push("--reflog");
  args.push("HEAD");
  return args;
}
