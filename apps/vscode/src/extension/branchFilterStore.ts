import * as vscode from "vscode";

import { branchFilterEquals } from "./branchFilter";

/** A change to a repo's branch filter. `branches` is the new selection; an
 *  empty array means "show all branches". */
export type BranchFilterChange = { repo: string; branches: string[] };

/**
 * The single source of truth for each repo's branch-filter selection, owned by
 * the extension host. The Branches side-view writes to it (user selection /
 * "Show All"); the Graph webview panel subscribes and re-filters the graph.
 * Decoupling the two through this store means neither needs a reference to the
 * other, and the selection survives the panel being closed and reopened.
 */
export function createBranchFilterStore() {
  const filters = new Map<string, string[]>();
  const emitter = new vscode.EventEmitter<BranchFilterChange>();

  return {
    onDidChangeFilter: emitter.event,

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
      if (!opts?.silent) emitter.fire({ repo, branches: [...next] });
      return true;
    },

    dispose: () => emitter.dispose()
  };
}

export type BranchFilterStore = ReturnType<typeof createBranchFilterStore>;
