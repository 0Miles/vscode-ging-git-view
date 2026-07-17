import type { SimpleGit } from "simple-git";

import { isGitRepository } from "@/backend/utils/git";

type LoadBranchesInput = {
  showRemoteBranches: boolean;
  hard: boolean;
  currentRepo: string;
  gitPath: string;
  /** Also resolve each branch's last-commit time (one extra `for-each-ref`).
   *  The Branches side-view sets this to classify inactive branches; the graph
   *  panel omits it (it doesn't need dates), so its load is unchanged. */
  includeDates?: boolean;
};

/** The raw branch data. The `filter` field of the `loadBranches` response is
 *  attached by the message handler (from the per-repo filter store), not here:
 *  this query stays a pure git read. */
export type LoadBranchesResult = {
  branches: string[];
  head: string | null;
  hard: boolean;
  isRepo: boolean;
  /** ref → last commit time (unix seconds), keyed to match `branches` entries.
   *  Present only when `includeDates` was requested. */
  branchDates?: Record<string, number>;
};

/** Parse `git for-each-ref --format='%(refname)\t%(committerdate:unix)'` into a
 *  map keyed to match the branch-list format: `refs/heads/x` → `x`,
 *  `refs/remotes/o/x` → `remotes/o/x`. The symbolic `remotes/o/HEAD` is dropped
 *  (it isn't a real branch in the list). */
function parseBranchDates(raw: string): Record<string, number> {
  const dates: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const refname = line.slice(0, tab);
    const unix = Number(line.slice(tab + 1).trim());
    // `Number("") === 0`: a ref whose committerdate is empty (e.g. pointing at
    // a non-commit object) must be skipped, not dated to the 1970 epoch.
    if (!Number.isFinite(unix) || unix <= 0) continue;
    let key: string | null = null;
    if (refname.startsWith("refs/heads/")) {
      key = refname.slice("refs/heads/".length);
    } else if (refname.startsWith("refs/remotes/")) {
      const rest = refname.slice("refs/remotes/".length);
      if (rest.endsWith("/HEAD")) continue;
      key = "remotes/" + rest;
    }
    if (key !== null) dates[key] = unix;
  }
  return dates;
}

export async function loadBranches(
  git: SimpleGit,
  input: LoadBranchesInput
): Promise<LoadBranchesResult> {
  const { showRemoteBranches, hard, currentRepo, gitPath, includeDates } = input;

  let branches: string[];
  let head: string | null;
  let error: boolean;

  try {
    const summary = await (showRemoteBranches ? git.branch() : git.branchLocal());
    head = summary.detached ? null : summary.current || null;
    branches = head ? [head, ...summary.all.filter((b) => b !== head)] : [...summary.all];
    error = false;
  } catch {
    branches = [];
    head = null;
    error = true;
  }

  const isRepo = error ? await isGitRepository(currentRepo, gitPath) : true;

  const result: LoadBranchesResult = { branches, head, hard, isRepo };

  if (includeDates && !error) {
    try {
      const refs = showRemoteBranches ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
      const raw = await git.raw([
        "for-each-ref",
        "--format=%(refname)\t%(committerdate:unix)",
        ...refs
      ]);
      result.branchDates = parseBranchDates(raw);
    } catch {
      /* best-effort: without dates nothing is classified inactive */
    }
  }

  return result;
}
