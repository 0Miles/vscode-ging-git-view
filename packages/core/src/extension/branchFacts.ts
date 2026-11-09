/**
 * The single holder of a repo's branch classification facts (ADR-0013).
 *
 * Both surfaces consume this one module: the Branches side-view builds its tree
 * from it, and the graph's `loadBranches` response carries the merged half of
 * its `hidable` set. Assembling the classifier inputs in two places is what let
 * the two disagree about a branch like `develop` — merged, but never hidden.
 *
 * The cache holds **only the git read** — the snapshot. Classification and the
 * exemptions are recomputed on every call from the current branch filter, the
 * current configuration and the current clock. That split is the point: those
 * three change without any filesystem event behind them (inactivity in
 * particular expires purely with time), so a cached `hidable` would go stale
 * with nothing available to detect it.
 *
 * Kept free of any `vscode` import so it runs in the fast backend test project,
 * like the three classifiers it drives. The branch-filter store is therefore
 * taken as a narrow structural view rather than its concrete (vscode-bearing)
 * type.
 */

import type { SimpleGit } from "simple-git";

import { loadBranches } from "@/backend/queries/loadBranches";

import { classifyInactive } from "./branchActivity";
import { type BranchClassification, type BranchExemptions } from "./branchExempt";
import { resolveBranchFilter } from "./branchFilter";
import { classifyMerged } from "./branchMerged";

/** One git read of a repo's branches — the only part of the facts that costs
 *  subprocesses, and so the only part worth caching. */
export type BranchSnapshot = {
  branches: string[];
  head: string | null;
  /** False when the path isn't a git repository. */
  isRepo: boolean;
  /** ref → last commit time (unix seconds). */
  dates: Record<string, number>;
  /** Refs git reported as merged into `defaultBranch`, in branch-list format. */
  merged: string[];
  /** Null when it couldn't be resolved, which disables merged classification. */
  defaultBranch: string | null;
};

export type BranchFacts = ReturnType<typeof createBranchFacts>;

export type BranchFactsResult = {
  branches: readonly string[];
  head: string | null;
  isRepo: boolean;
  defaultBranch: string | null;
  dates: Readonly<Record<string, number>>;
  /** The branch filter in force for this repo, resolved (and seeded back) as
   *  part of producing the exemptions. Empty = show all. */
  filter: string[];
  /** Fact set + hidable subset, kept as a pair: the `✓` badge reads `matched`
   *  (exempt branches are badged too, ADR-0003) while the graph's dimming reads
   *  `hidable`. */
  merged: BranchClassification;
  inactive: BranchClassification;
  /** The union of both rules' hidable sets — what the side-view dims, and what
   *  either hide toggle would remove. */
  hidable: ReadonlySet<string>;
};

/** The part of the branch-filter store this module needs. Structural on purpose
 *  (see the module note): the real store imports `vscode`. */
export type BranchFilterStoreView = {
  has: (repo: string) => boolean;
  get: (repo: string) => string[];
  set: (repo: string, branches: readonly string[], opts?: { silent?: boolean }) => boolean;
};

export type BranchFactsDeps = {
  /** Perform the git read. Injected so the module stays testable without git. */
  readSnapshot: (repo: string, showRemoteBranches: boolean) => Promise<BranchSnapshot>;
  filterStore: BranchFilterStoreView;
  /** The repo's "show remote branches" state. Resolved here rather than taken
   *  from the caller: the webview's copy is a one-way echo of this value and
   *  can only ever be staler, and two callers passing their own is exactly the
   *  drift this module exists to remove. */
  resolveShowRemote: (repo: string) => boolean;
  /** "Always show" name/glob patterns exempting a branch from hiding. */
  resolveExemptPatterns: () => string[];
  /** The inactivity cutoff in days (`<= 0` disables the rule). */
  resolveInactiveThresholdDays: () => number;
  /** Branches the configuration wants pre-selected when a repo is first seen. */
  resolveShowSpecificBranches: () => string[];
  resolveShowCurrentBranchByDefault: () => boolean;
  nowMs: () => number;
  /** How long a snapshot may serve later callers, in ms. Its job is to coalesce
   *  the side-view's read and the graph's read of the same refresh into one —
   *  not to be a real cache — and to bound how stale things can get if an
   *  invalidation edge is ever missed. */
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 1000;

/**
 * The real reader behind {@link BranchFactsDeps.readSnapshot}: one `loadBranches`
 * against a client bound to the target repo.
 *
 * Dates are always requested, even though only the side-view consumes
 * inactivity. One snapshot shape is what lets both surfaces share a read; a
 * lazily-dated variant would put "the same thing in two shapes" back, just
 * inside this module instead of across two call sites.
 */
export function createGitSnapshotReader(deps: {
  gitClientFor: (repo: string) => SimpleGit;
  gitPath: () => string;
}): BranchFactsDeps["readSnapshot"] {
  return async (repo, showRemoteBranches) => {
    const result = await loadBranches(deps.gitClientFor(repo), {
      showRemoteBranches,
      hard: true,
      currentRepo: repo,
      gitPath: deps.gitPath(),
      includeDates: true,
      includeMerged: true
    });
    return {
      branches: result.branches,
      head: result.head,
      isRepo: result.isRepo,
      dates: result.branchDates ?? {},
      merged: result.mergedBranches ?? [],
      defaultBranch: result.defaultBranch ?? null
    };
  };
}

type CacheEntry = {
  /** The value `readSnapshot` was called with; a changed answer must not be
   *  served from an entry read under the old one. */
  showRemote: boolean;
  readAtMs: number;
  /** The in-flight or settled read. Held as the promise (not its value) so two
   *  callers in the same tick share one read rather than starting two. */
  snapshot: Promise<BranchSnapshot>;
};

export function createBranchFacts(deps: BranchFactsDeps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  function readCached(repo: string, showRemote: boolean, hard: boolean): Promise<BranchSnapshot> {
    const now = deps.nowMs();
    const entry = cache.get(repo);
    if (
      !hard &&
      entry !== undefined &&
      entry.showRemote === showRemote &&
      now - entry.readAtMs < ttlMs
    ) {
      return entry.snapshot;
    }
    const snapshot = deps.readSnapshot(repo, showRemote);
    const next: CacheEntry = { showRemote, readAtMs: now, snapshot };
    cache.set(repo, next);
    // A rejected read must not be served to the next caller — drop the entry,
    // but only if it is still the one we installed (a `hard` read may have
    // replaced it in the meantime).
    snapshot.catch(() => {
      if (cache.get(repo) === next) cache.delete(repo);
    });
    return snapshot;
  }

  return {
    /**
     * Every classification fact for `repo`, from one git read.
     *
     * **Writes**: resolves the repo's branch filter and seeds it back into the
     * store (silently — the value travels to its consumers in this same
     * result). Seeding needs the branch list and head, which only exist here;
     * splitting it out would turn the single entry point into three steps.
     *
     * `hard` bypasses the coalescing window, so a user-initiated Refresh is
     * always a real read.
     */
    async facts(repo: string, opts?: { hard?: boolean }): Promise<BranchFactsResult> {
      const showRemote = deps.resolveShowRemote(repo);
      const snapshot = await readCached(repo, showRemote, opts?.hard === true);

      // Resolving against an empty branch list would prune any stored selection
      // away and fall back to the configured default, so a non-repo path or a
      // failed read would silently clobber the user's filter. Leave it alone
      // and classify against what is stored.
      const canSeed = snapshot.isRepo && snapshot.branches.length > 0;
      const filter = canSeed
        ? resolveBranchFilter(
            deps.filterStore.has(repo) ? deps.filterStore.get(repo) : undefined,
            snapshot.branches,
            snapshot.head,
            {
              showSpecificBranches: deps.resolveShowSpecificBranches(),
              showCurrentBranchByDefault: deps.resolveShowCurrentBranchByDefault()
            }
          )
        : deps.filterStore.get(repo);
      if (canSeed) deps.filterStore.set(repo, filter, { silent: true });

      const exemptions: BranchExemptions = {
        head: snapshot.head,
        selected: filter,
        patterns: deps.resolveExemptPatterns()
      };
      const inactive = classifyInactive({
        branches: snapshot.branches,
        dates: snapshot.dates,
        nowSec: Math.floor(deps.nowMs() / 1000),
        thresholdDays: deps.resolveInactiveThresholdDays(),
        exemptions
      });
      const merged = classifyMerged({
        branches: snapshot.branches,
        merged: snapshot.merged,
        defaultBranch: snapshot.defaultBranch,
        exemptions
      });
      return {
        branches: snapshot.branches,
        head: snapshot.head,
        isRepo: snapshot.isRepo,
        defaultBranch: snapshot.defaultBranch,
        dates: snapshot.dates,
        filter,
        merged,
        inactive,
        hidable: new Set([...inactive.hidable, ...merged.hidable])
      };
    },

    /** Drop cached snapshots, so the next `facts` call re-reads git. Called from
     *  the repo-mutating message path (the file watcher is deliberately muted
     *  across exactly those operations — see ADR-0013) and from the watcher
     *  itself for changes made outside the extension. Without `repo`, drops
     *  every entry: the mutating path knows an operation ran, not which repo it
     *  touched, and re-reading a handful of repos costs far less than serving
     *  one stale answer. */
    invalidate(repo?: string): void {
      if (repo === undefined) cache.clear();
      else cache.delete(repo);
    }
  };
}
