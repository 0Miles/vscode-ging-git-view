import { type BranchFilterChange, branchFilterEquals } from "@ging/core/extension/branchFilter";

/**
 * The single source of truth for each repo's branch filter, owned by
 * the host. The Branches side-view writes to it (user selection / "Show All");
 * the Graph webview panel subscribes and re-filters the graph. Decoupling the
 * two through this store means neither needs a reference to the other, and the
 * filter survives the panel being closed and reopened.
 *
 * Its listeners are told the way VS Code's `EventEmitter` told them, which is
 * what it used before it moved here (#385): synchronously, each in turn, and a
 * listener that throws neither stops the rest nor makes `set` throw — its
 * error is rethrown on its own, after `set` has returned, for the host's
 * uncaught-error handling to report. One difference: a listener that changes a
 * filter while being told of a change has the new change told to everyone
 * before the rest hear the first, where VS Code finishes the first. No
 * listener does that today.
 */
export function createBranchFilterStore() {
  const filters = new Map<string, string[]>();
  /** `null` once disposed. */
  let listeners: Set<(change: BranchFilterChange) => void> | null = new Set();

  const fire = (change: BranchFilterChange) => {
    // As VS Code's emitter does: a listener subscribing mid-delivery hears the
    // next change, not this one; one letting go hears nothing more, this one
    // included.
    for (const listener of Array.from(listeners ?? [])) {
      if (!listeners?.has(listener)) continue;
      try {
        listener(change);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  };

  return {
    onDidChangeFilter(listener: (change: BranchFilterChange) => void): { dispose(): void } {
      listeners?.add(listener);
      return { dispose: () => listeners?.delete(listener) };
    },

    /** Whether a filter has ever been recorded for `repo`. */
    has: (repo: string): boolean => filters.has(repo),

    /** The current filter for `repo` ([] = show all, also for unknown repos). */
    get: (repo: string): string[] => filters.get(repo) ?? [],

    /** Record a filter. Fires `onDidChangeFilter` when the value actually
     *  changes, unless `silent` (used when seeding from a value already being
     *  delivered to the panel, to avoid a redundant reload). Returns whether
     *  the stored value changed. */
    set(repo: string, branches: readonly string[], opts?: { silent?: boolean }): boolean {
      const prev = filters.get(repo);
      if (prev !== undefined && branchFilterEquals(prev, branches)) return false;
      const next = [...branches];
      filters.set(repo, next);
      if (!opts?.silent) fire({ repo, branches: [...next] });
      return true;
    },

    /** Stop telling listeners anything. The filters stay readable. */
    dispose: () => {
      listeners = null;
    }
  };
}

export type BranchFilterStore = ReturnType<typeof createBranchFilterStore>;
