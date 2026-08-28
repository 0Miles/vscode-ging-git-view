import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";

import { commitMatchesQuery } from "./utils/git";

/** The two numbers below are the same distance measured on two different
 *  rulers, and Find needs both: `depth` orders matches the way the user sees
 *  them, `logDepth` sizes the load that would reach one. They agree only in a
 *  repo with no stashes on screen. */
export type FindMatch = {
  hash: string;
  loaded: boolean;
  /** Zero-based row in the unbounded graph, excluding the working-tree row and
   *  including every rendered stash row. */
  depth: number;
  /** Zero-based position in `git log`, excluding rendered stash rows — the
   *  same ruler as {@link BranchSearchEntry.logDepth}, and the one
   *  `--max-count` is measured on. */
  logDepth: number;
  /** Branches whose display refs matched the query. */
  branches: Pick<BranchSearchEntry, "ref" | "name">[];
};

export function buildFindMatches(
  query: string,
  commits: readonly GitCommitNode[],
  branchIndex: readonly BranchSearchEntry[]
): FindMatch[] {
  const q = query.toLowerCase();
  if (q === "") return [];

  const matchingBranches = new Map<string, BranchSearchEntry[]>();
  for (const branch of branchIndex) {
    if (!branch.name.toLowerCase().includes(q)) continue;
    const entries = matchingBranches.get(branch.hash);
    if (entries === undefined) matchingBranches.set(branch.hash, [branch]);
    else entries.push(branch);
  }

  const matches: FindMatch[] = [];
  const loadedHashes = new Set<string>();
  const stashBoundaries: number[] = [];
  let logDepth = 0;
  let graphDepth = 0;
  for (const commit of commits) {
    if (commit.hash === "*") continue;
    loadedHashes.add(commit.hash);
    const commitLogDepth = logDepth;
    if (commit.refs.some((ref) => ref.type === "stash")) stashBoundaries.push(commitLogDepth);
    else logDepth++;
    const branches = matchingBranches.get(commit.hash) ?? [];
    if (commitMatchesQuery(commit, query) || branches.length > 0) {
      matches.push({
        hash: commit.hash,
        loaded: true,
        depth: graphDepth,
        logDepth: commitLogDepth,
        branches: branches.map(({ ref, name }) => ({ ref, name }))
      });
    }
    graphDepth++;
  }

  // The index arrives on the `git log` ruler, so converting to a graph row means
  // adding back the stash rows the graph splices in above this branch.
  for (const [hash, branches] of matchingBranches) {
    if (loadedHashes.has(hash)) continue;
    const branchLogDepth = Math.min(...branches.map((branch) => branch.logDepth));
    matches.push({
      hash,
      loaded: false,
      depth:
        branchLogDepth + stashBoundaries.filter((boundary) => boundary <= branchLogDepth).length,
      logDepth: branchLogDepth,
      branches: branches.map(({ ref, name }) => ({ ref, name }))
    });
  }

  matches.sort((a, b) => a.depth - b.depth);
  return matches;
}

export function resolveFindCurrent(
  matches: readonly FindMatch[],
  preferredHash: string | null,
  previousIndex: number,
  direction: -1 | 1,
  previousDepth?: number
): number {
  if (matches.length === 0) return -1;
  if (preferredHash !== null) {
    const preserved = matches.findIndex((match) => match.hash === preferredHash);
    if (preserved !== -1) return preserved;
  }
  if (previousDepth !== undefined) {
    if (direction === 1) {
      const next = matches.findIndex((match) => match.depth > previousDepth);
      return next === -1 ? 0 : next;
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].depth < previousDepth) return i;
    }
    return matches.length - 1;
  }
  if (direction === 1) return Math.min(Math.max(previousIndex, 0), matches.length - 1);
  return Math.min(Math.max(previousIndex - 1, 0), matches.length - 1);
}

export function planFindLoad(
  currentMaxCommits: number,
  match: Pick<FindMatch, "loaded" | "logDepth">
): { maxCommits: number; additionalCommits: number; confirm: boolean } | null {
  if (match.loaded) return null;
  // `maxCommits` becomes git's `--max-count`, which counts log entries — so the
  // window is sized off `logDepth`, never off the row the match renders at.
  const maxCommits = Math.max(currentMaxCommits, match.logDepth + 1);
  const additionalCommits = maxCommits - currentMaxCommits;
  return { maxCommits, additionalCommits, confirm: additionalCommits > 200 };
}
