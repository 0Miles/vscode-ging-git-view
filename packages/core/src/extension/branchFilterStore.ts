import { type BranchFilterChange, branchFilterEquals } from "@ging/core/extension/branchFilter";

/**
 * The single source of truth for each repo's branch-filter selection, owned by
 * the host. The Branches side-view writes to it (user selection / "Show All");
 * the Graph webview panel subscribes and re-filters the graph. Decoupling the
 * two through this store means neither needs a reference to the other, and the
 * selection survives the panel being closed and reopened.
 *
 * Its listeners are told the way VS Code's `EventEmitter` told them, which is
 * what it used before it moved here: synchronously, each in turn, and a
 * listener that throws neither stops the rest nor makes `set` throw — its
 * error is rethrown on its own, after `set` has returned.
 */
export function createBranchFilterStore() {
  const filters = new Map<string, string[]>();
  const listeners = new Set<(change: BranchFilterChange) => void>();
  let disposed = false;

  const fire = (change: BranchFilterChange) => {
    // A copy: a listener subscribing or letting go mid-delivery changes the
    // next delivery, not this one.
    for (const listener of Array.from(listeners)) {
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
      if (disposed) return { dispose: () => {} };
      // Its own entry, so subscribing one function twice is two subscriptions.
      const entry = (change: BranchFilterChange) => listener(change);
      listeners.add(entry);
      return { dispose: () => listeners.delete(entry) };
    },

    /** Whether a selection has ever been recorded for `repo`. */
    has: (repo: string): boolean => filters.has(repo),

    /** The current selection for `repo` ([] = show all, also for unknown repos). */
    get: (repo: string): string[] => filters.get(repo) ?? [],

    /** Record a selection. Fires `onDidChangeFilter` when the value actually
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

    /** Stop telling listeners anything. The selections stay readable. */
    dispose: () => {
      disposed = true;
      listeners.clear();
    }
  };
}

export type BranchFilterStore = ReturnType<typeof createBranchFilterStore>;
