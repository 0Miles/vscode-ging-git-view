import type { SimpleGit } from "simple-git";

import type { BranchSearchEntry, CommitOrdering } from "@ging/shared/backend/types";

import { gitLogScopeArgs, gitLogTraversalArgs } from "./gitLogScope";

type BranchSearchInput = {
  branchNames: string[];
  showRemoteBranches: boolean;
  commitOrder: CommitOrdering;
  onlyFollowFirstParent: boolean;
  showCommitsOnlyReferencedByTags?: boolean;
  includeCommitsMentionedByReflogs?: boolean;
  hiddenRemotes: string[];
};

function logArgs(input: BranchSearchInput): string[] {
  const args = [
    "log",
    "--format=%H",
    ...gitLogTraversalArgs(input.commitOrder, input.onlyFollowFirstParent)
  ];
  args.push(
    ...gitLogScopeArgs({
      ...input,
      includeTagOnlyCommits: input.showCommitsOnlyReferencedByTags,
      includeReflogCommits: input.includeCommitsMentionedByReflogs
    })
  );
  return args;
}

export async function loadBranchSearchIndex(
  git: SimpleGit,
  input: BranchSearchInput
): Promise<{ branches: BranchSearchEntry[] }> {
  const namespaces = input.showRemoteBranches ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
  const [refOutput, logOutput] = await Promise.all([
    git.raw(["for-each-ref", "--format=%(objectname)%09%(refname)%09%(symref)", ...namespaces]),
    git.raw(logArgs(input))
  ]);

  // Positions in `git log`, not rows on the graph: the graph splices stash rows
  // in among these commits, so the webview converts before either number can be
  // treated as a row (see `BranchSearchEntry.logDepth`).
  const logDepths = new Map<string, number>();
  for (const [logDepth, hash] of logOutput.trimEnd().split(/\r?\n/).entries()) {
    if (hash !== "") logDepths.set(hash, logDepth);
  }

  const branches: BranchSearchEntry[] = [];
  for (const line of refOutput.trimEnd().split(/\r?\n/)) {
    if (line === "") continue;
    const [hash, refname, symref] = line.split("\t");
    if (symref) continue;

    let name: string;
    let ref: string;
    if (refname.startsWith("refs/heads/")) {
      name = refname.slice("refs/heads/".length);
      ref = name;
    } else if (refname.startsWith("refs/remotes/")) {
      name = refname.slice("refs/remotes/".length);
      ref = "remotes/" + name;
      const remote = name.split("/", 1)[0];
      if (input.hiddenRemotes.includes(remote)) continue;
    } else {
      continue;
    }

    const logDepth = logDepths.get(hash);
    if (logDepth !== undefined) branches.push({ ref, name, hash, logDepth });
  }

  branches.sort((a, b) => a.logDepth - b.logDepth || a.name.localeCompare(b.name));
  return { branches };
}

/**
 * Where `hash` sits in the history the graph loads: its zero-based position in
 * that `git log` — the ruler `--max-count` is measured on, and the one
 * {@link BranchSearchEntry.logDepth} uses — or null when that history leaves it
 * out altogether (first parent only, a filter, a hidden remote, or a commit the
 * repository does not have). Walks the same log as the branch index, so the
 * graph can load exactly as far as it takes to draw the commit (#310).
 */
export async function findCommitLogDepth(
  git: SimpleGit,
  input: BranchSearchInput & { hash: string }
): Promise<number | null> {
  const logOutput = await git.raw(logArgs(input));
  const depth = logOutput.trimEnd().split(/\r?\n/).indexOf(input.hash);
  return depth === -1 ? null : depth;
}
