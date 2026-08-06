import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";

import { commitMatchesQuery } from "./utils/git";

export type FindMatch = {
  hash: string;
  loaded: boolean;
  /** Zero-based row in the unbounded graph, excluding the working-tree row. */
  depth: number;
  /** Zero-based position in `git log`, excluding rendered stash rows. */
  loadDepth: number;
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
    const commitLoadDepth = logDepth;
    if (commit.refs.some((ref) => ref.type === "stash")) stashBoundaries.push(commitLoadDepth);
    else logDepth++;
    const branches = matchingBranches.get(commit.hash) ?? [];
    if (commitMatchesQuery(commit, query) || branches.length > 0) {
      matches.push({
        hash: commit.hash,
        loaded: true,
        depth: graphDepth,
        loadDepth: commitLoadDepth,
        branches: branches.map(({ ref, name }) => ({ ref, name }))
      });
    }
    graphDepth++;
  }

  for (const [hash, branches] of matchingBranches) {
    if (loadedHashes.has(hash)) continue;
    const branchDepth = Math.min(...branches.map((branch) => branch.depth));
    matches.push({
      hash,
      loaded: false,
      depth: branchDepth + stashBoundaries.filter((boundary) => boundary <= branchDepth).length,
      loadDepth: branchDepth,
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
  match: Pick<FindMatch, "loaded" | "loadDepth">
): { maxCommits: number; additionalCommits: number; confirm: boolean } | null {
  if (match.loaded) return null;
  const maxCommits = Math.max(currentMaxCommits, match.loadDepth + 1);
  const additionalCommits = maxCommits - currentMaxCommits;
  return { maxCommits, additionalCommits, confirm: additionalCommits > 200 };
}
