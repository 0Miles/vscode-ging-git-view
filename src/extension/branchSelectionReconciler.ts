/**
 * Pure (vscode-free) reconciliation of the Branches side-view selection into
 * branch-filter writes, unit-tested in the fast backend test project like its
 * neighbours in this directory.
 *
 * A branch selection is the one set that serves both the graph filter and the
 * batch actions (ADR-0008), and an empty selection is the user's explicit
 * "show all" — but not every empty selection *event* is a user gesture. The
 * TreeView also emits one when its items are re-keyed (a repo switch, or the
 * search picker clearing the visual selection), and honouring those would
 * clobber a filter that was just written. This module owns the rules that tell
 * the gestures apart; `branchesView.ts` stays a thin adapter that pipes VS Code
 * events in and interprets the decisions.
 */

/** How long selection events coalesce before the filter is written, so a rapid
 *  multi-select (Ctrl/Cmd-click several branches) causes one graph reload. */
export const SELECTION_WRITE_DEBOUNCE_MS = 200;

/** A write of a repo's branch filter ([] = show all branches). */
export type FilterWrite = { repo: string; branches: string[] };

export type SelectionDecision =
  | { kind: "schedule"; delayMs: number }
  | { kind: "ignore"; reason: "no-repo" | "repo-switch-empty" | "suppressed-empty" };

export type BranchSelectionReconciler = ReturnType<typeof createBranchSelectionReconciler>;

export function createBranchSelectionReconciler() {
  /** The debounced write not yet performed; what `onDebounceElapsed` returns. */
  let pending: FilterWrite | null = null;
  /** The repo whose selection was last observed: lets us tell a genuine user
   *  "deselect all" (→ show all) apart from the empty selection the TreeView
   *  emits when it is rebuilt for a different repo (whose items have different
   *  ids). Null until the first event arrives. */
  let lastSelectionRepo: string | null = null;
  /** Armed by a direct write whose clearing of the tree's visual selection will
   *  actually drop a branch selection: the empty event that clearing emits must
   *  not clobber the filter just written with "show all". Consumed by the first
   *  empty event; a non-empty event passes through and leaves it armed. */
  let suppressEmptySelectionOnce = false;

  return {
    /** A TreeView selection event: `refs` are the selected leaf branches.
     *  Returns what the adapter should do — (re)start its debounce timer, or
     *  nothing when the event is a tree-rebuild artefact rather than a user
     *  gesture. Only *empty* events are ever distrusted: an empty selection is
     *  the one gesture ("show all") the TreeView also emits on its own. */
    onSelection(repo: string | null, refs: readonly string[]): SelectionDecision {
      if (repo === null) return { kind: "ignore", reason: "no-repo" };
      if (refs.length === 0 && suppressEmptySelectionOnce) {
        suppressEmptySelectionOnce = false;
        lastSelectionRepo = repo;
        return { kind: "ignore", reason: "suppressed-empty" };
      }
      // The empty event that follows a repo switch is the rebuild, not the
      // user; honouring it would clobber the new repo's filter with "show all".
      if (refs.length === 0 && repo !== lastSelectionRepo) {
        lastSelectionRepo = repo;
        return { kind: "ignore", reason: "repo-switch-empty" };
      }
      lastSelectionRepo = repo;
      pending = { repo, branches: [...refs] };
      return { kind: "schedule", delayMs: SELECTION_WRITE_DEBOUNCE_MS };
    },

    /** The filter is being written around the tree (the multi-pick search:
     *  there is no API to set a TreeView multi-selection, so the adapter writes
     *  the store directly and clears the visual selection instead). Drops any
     *  pending debounced write and arms the one-shot suppression of the empty
     *  event the clearing will emit. Returns the write to perform, immediately.
     *
     *  `clearedSelection` is the branch selection the clearing is about to drop
     *  — the caller's *current* selection, folders and group headings already
     *  excluded, exactly as `onSelection` receives it. It is the whole arming
     *  condition, and it is refs rather than a boolean on purpose: clearing
     *  re-keys leaves only, so a selection of nothing but folders survives it
     *  and emits no event at all. Arming on such a selection would leave the
     *  flag hanging and swallow the user's next genuine deselect-all. */
    onDirectWrite(
      repo: string,
      refs: readonly string[],
      opts: { clearedSelection: readonly string[] }
    ): FilterWrite {
      pending = null;
      if (opts.clearedSelection.length > 0) suppressEmptySelectionOnce = true;
      return { repo, branches: [...refs] };
    },

    /** The adapter's debounce timer fired: the write to perform, or null when
     *  the pending write was dropped in the meantime. One-shot. */
    onDebounceElapsed(): FilterWrite | null {
      const write = pending;
      pending = null;
      return write;
    },

    /** The view is being pointed at another repo: drop any pending write so it
     *  cannot land on the previous repo after the switch. */
    onRepoSwitch(): void {
      pending = null;
    }
  };
}
