import type { SimpleGit } from "simple-git";

import { branchKeyFromRefname, parseRefnames } from "@/backend/utils/branchRef";
import { isGitRepository } from "@/backend/utils/git";

import { detectDefaultBranch } from "./defaultBranch";

type LoadBranchesInput = {
  showRemoteBranches: boolean;
  hard: boolean;
  currentRepo: string;
  gitPath: string;
  /** Also resolve each branch's last-commit time (one extra `for-each-ref`).
   *  The Branches side-view sets this to classify inactive branches; the graph
   *  panel omits it (it doesn't need dates), so its load is unchanged. */
  includeDates?: boolean;
  /** Also resolve the default branch and the branches already merged into it.
   *  Both the side-view and the graph request this — the side-view badges, dims
   *  and hides them, the graph dims their ref chips. */
  includeMerged?: boolean;
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
  /** The default branch `mergedBranches` was computed against (`main` or
   *  `remotes/origin/main`), or null when it couldn't be resolved (in which
   *  case `mergedBranches` is empty and callers disable the feature). Present
   *  only when `includeMerged` was requested. */
  defaultBranch?: string | null;
  /** Refs whose tip is an ancestor of `defaultBranch`, keyed to match
   *  `branches`. Present only when `includeMerged` was requested. */
  mergedBranches?: string[];
};

/** The `refs/…` namespaces to scan, matching what the branch list contains. */
function refNamespaces(showRemoteBranches: boolean): string[] {
  return showRemoteBranches ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
}

/** Parse `git for-each-ref --format='%(refname)\t%(committerdate:unix)'` into a
 *  map keyed to match the branch-list format. */
function parseBranchDates(raw: string): Record<string, number> {
  const dates: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const unix = Number(line.slice(tab + 1).trim());
    // `Number("") === 0`: a ref whose committerdate is empty (e.g. pointing at
    // a non-commit object) must be skipped, not dated to the 1970 epoch.
    if (!Number.isFinite(unix) || unix <= 0) continue;
    const key = branchKeyFromRefname(line.slice(0, tab));
    if (key !== null) dates[key] = unix;
  }
  return dates;
}

export async function loadBranches(
  git: SimpleGit,
  input: LoadBranchesInput
): Promise<LoadBranchesResult> {
  const { showRemoteBranches, hard, currentRepo, gitPath, includeDates, includeMerged } = input;

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

  // The dates read and the default-branch detection ask git different questions
  // and neither needs the other's answer, so they go out together rather than
  // one after the other. A git spawn is tens of milliseconds on Windows and
  // this runs on every `branchFacts` cache miss — each side-view reload, each
  // graph branch load, each invalidation after a branch mutation — so the
  // chain is what the user waits on. The merged read stays behind both: it
  // needs the default branch to ask about.
  const readDates = async () => {
    if (!includeDates || error) return;
    try {
      const raw = await git.raw([
        "for-each-ref",
        "--format=%(refname)\t%(committerdate:unix)",
        ...refNamespaces(showRemoteBranches)
      ]);
      result.branchDates = parseBranchDates(raw);
    } catch {
      /* best-effort: without dates nothing is classified inactive */
    }
  };

  const readDefaultBranch = async () => {
    if (!includeMerged || error) return null;
    // Set before the read, not after: "we looked and found none" and "we did
    // not look" are different states downstream, and the catch below must not
    // leave the second one showing.
    result.defaultBranch = null;
    result.mergedBranches = [];
    try {
      return await detectDefaultBranch(git);
    } catch {
      /* best-effort: without a default branch nothing is marked merged */
      return null;
    }
  };

  const [, defaultBranch] = await Promise.all([readDates(), readDefaultBranch()]);

  if (defaultBranch !== null) {
    result.defaultBranch = defaultBranch;
    try {
      const raw = await git.raw([
        "for-each-ref",
        "--merged=" + defaultBranch,
        "--format=%(refname)",
        ...refNamespaces(showRemoteBranches)
      ]);
      result.mergedBranches = parseRefnames(raw);
    } catch {
      /* best-effort: without the merged set nothing is marked merged */
    }
  }

  return result;
}
