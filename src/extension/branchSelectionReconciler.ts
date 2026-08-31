/**
 * Reconciliation of the Branches side-view selection into branch-filter writes.
 * Free of any `vscode` import, so it is unit-tested in the fast backend test
 * project like its neighbours in this directory — but not pure: it performs the
 * writes too, through ports (see the foot of the file).
 *
 * A branch selection is the one set that serves both the graph filter and the
 * batch actions (ADR-0008), and an empty selection is the user's explicit
 * "show all" — but not every empty selection *event* is a user gesture. The
 * TreeView also emits one when its items are re-keyed (a repo switch, or the
 * search picker clearing the visual selection), and honouring those would
 * clobber a filter that was just written. This module owns the rules that tell
 * the gestures apart; `branchesView.ts` stays a thin adapter that pipes VS Code
 * events in and interprets the decisions.
 *
 * Not every filter write starts as a tree gesture, though. A **direct write** —
 * the multi-pick search's chosen set, "Show All"'s empty one — writes the filter
 * and clears the highlight itself, and the steps it takes around
 * {@link BranchSelectionReconciler.onDirectWrite} are the same whichever gesture
 * asked for it. They live here, as {@link createDirectFilterWriter}, and not
 * once per caller in the adapter, because a caller holding its own copy of the
 * sequence *is* a second place deciding how a side-view gesture becomes a filter
 * update. That is what let "Show All" write the store on its own (#43), and
 * before it what let one caller arm the suppression off the wrong set (#42; the
 * rule itself is stated on `onDirectWrite` below).
 *
 * Owning the sequence is what makes this module perform effects as well as
 * decide. They arrive as ports, so it stays vscode-free and the backend test
 * project can hold every side-view filter update to the sequence (ADR-0018).
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
  /** The repo the view is pointed at, as last stated by `onRepoSwitch`. Kept
   *  apart from `lastSelectionRepo`, which is the repo of the last selection
   *  *event*: the two answer different questions and lag each other (a switch
   *  is stated before the new repo's first selection event arrives), and only
   *  this one can say whether a call to `onRepoSwitch` moved anything. */
  let activeRepo: string | null = null;

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

    /** The filter is being written around the tree — no tree gesture produced
     *  it, so the adapter writes the store and clears the visual selection
     *  itself. Drops any pending debounced write and arms the one-shot
     *  suppression of the empty event the clearing will emit. Returns the write
     *  to perform, immediately. Reached through {@link createDirectFilterWriter},
     *  which is what makes the steps around it the same for every caller.
     *
     *  `selectionBeingCleared` is the branch selection that clearing is about to
     *  drop — the same set `onSelection` receives, so folders and group headings
     *  are already excluded — and it is the whole arming condition. The clear
     *  emits an event only when it actually changes the selection (see
     *  `clearSelection` in `branchesView.ts` for which rows it can touch);
     *  arming over a selection it leaves alone would strand the flag until the
     *  user's next genuine deselect-all, which it would then swallow.
     *
     *  Refs rather than the boolean only `.length` needs: this module speaks
     *  branch selections throughout, and a boolean parameter would hand the
     *  caller back the job of deciding *which* set to measure — measuring the
     *  wrong one is precisely what stranded the flag before. */
    onDirectWrite(
      repo: string,
      refs: readonly string[],
      opts: { selectionBeingCleared: readonly string[] }
    ): FilterWrite {
      pending = null;
      if (opts.selectionBeingCleared.length > 0) suppressEmptySelectionOnce = true;
      return { repo, branches: [...refs] };
    },

    /** The adapter's debounce timer fired: the write to perform, or null when
     *  the pending write was dropped in the meantime. One-shot. */
    onDebounceElapsed(): FilterWrite | null {
      const write = pending;
      pending = null;
      return write;
    },

    /** The view is being pointed at `repo`. The pending write is dropped
     *  whether or not that moved anything, so it cannot land on the previous
     *  repo after a switch — and dropping it on a re-point is this method's
     *  long-standing behaviour, which the guard below deliberately leaves
     *  alone.
     *
     *  A waiting suppression, though, is only given up on a *real* switch. It
     *  is one-shot and armed before the event it awaits exists (`clearSelection`
     *  re-keys the leaves, and VS Code emits the resulting empty selection when
     *  it next renders the tree), so a hidden or collapsed side view can strand
     *  it — and stranded it is spent on whatever empty event comes next, which
     *  after a switch is a genuine deselect-all in the repo just arrived at:
     *  the user asks for all branches and silently keeps the filter. Past a
     *  real switch the awaited event can no longer be coming, so this is the
     *  honest place to give up on it.
     *
     *  Which is why the repo is a parameter. The adapter re-points the view at
     *  the repo it is already on far more often than it switches — opening the
     *  graph does it, and so does an SCM selection growing while its first entry
     *  stays put — and `BranchesProvider.setRepo` already ignores those. That
     *  guard cannot be left there: it runs after this call, so the reconciler
     *  would give up on an event that is still coming, and the unsuppressed
     *  empty selection would land between a direct write and its own clear,
     *  writing "show all" over the non-empty filter the multi-pick search just
     *  set. Asking here means the rule is testable rather than inferred from
     *  two call sites in `extension.ts` (ADR-0018). */
    onRepoSwitch(repo: string | null): void {
      pending = null;
      if (repo !== activeRepo) suppressEmptySelectionOnce = false;
      activeRepo = repo;
    }
  };
}

/** What the side view has to lend a direct write. Ports rather than a direct
 *  dependency on the view: every one of them is a VS Code call, and this module
 *  stays vscode-free so the sequence below can be exercised in the backend test
 *  project (ADR-0018). */
export type DirectWriteEffects = {
  /** The branch selection the clear is about to drop, per the arming rule on
   *  `onDirectWrite` above. A port rather than an argument so that *which set*
   *  gets measured is settled once, where the effects are bound, and no call
   *  site is left to answer it. */
  branchSelection: () => readonly string[];
  /** Cancel the adapter's debounce timer. The reconciler drops the pending
   *  write regardless, so the timer would fire into nothing — this only spares
   *  the wakeup, and keeps the adapter's timer and the reconciler's `pending`
   *  from disagreeing about whether a write is still coming. */
  cancelPendingWrite: () => void;
  writeFilter: (write: FilterWrite) => void;
  /** Drop the tree's highlight, which is what emits the empty selection event
   *  the suppression is armed against. */
  clearVisualSelection: () => void;
};

/**
 * Bind a reconciler to the view's effects, yielding the one function that
 * performs a direct write. Bound once, so the adapter is left holding a function
 * that takes nothing but the repo and the refs.
 *
 * The order is load-bearing in one direction only — the filter is written
 * before the highlight goes, so the graph reloads once instead of reacting to
 * an intermediate state. The suppression is armed before either, so it cannot
 * matter how quickly VS Code delivers the clear's event.
 */
export function createDirectFilterWriter(
  reconciler: BranchSelectionReconciler,
  effects: DirectWriteEffects
): (repo: string, refs: readonly string[]) => void {
  return (repo, refs) => {
    effects.cancelPendingWrite();
    const write = reconciler.onDirectWrite(repo, refs, {
      selectionBeingCleared: effects.branchSelection()
    });
    effects.writeFilter(write);
    effects.clearVisualSelection();
  };
}
