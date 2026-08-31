import { describe, expect, it } from "vitest";

import {
  createBranchSelectionReconciler,
  createDirectFilterWriter,
  type FilterWrite,
  SELECTION_WRITE_DEBOUNCE_MS
} from "@/extension/branchSelectionReconciler";

describe("selection writes the filter", () => {
  it("a branch selection schedules a debounced write of exactly those refs", () => {
    const reconciler = createBranchSelectionReconciler();
    const decision = reconciler.onSelection("/repo", ["main", "dev"]);
    expect(decision).toEqual({ kind: "schedule", delayMs: SELECTION_WRITE_DEBOUNCE_MS });
    expect(reconciler.onDebounceElapsed()).toEqual({
      repo: "/repo",
      branches: ["main", "dev"]
    });
  });

  it("deselecting everything on the same repo writes show-all (empty filter)", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo", branches: [] });
  });
});

describe("events that are not user gestures are ignored", () => {
  it("ignores events while no repo is active", () => {
    const reconciler = createBranchSelectionReconciler();
    expect(reconciler.onSelection(null, ["main"])).toEqual({
      kind: "ignore",
      reason: "no-repo"
    });
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  it("ignores the empty event a repo switch emits, keeping the new repo's filter", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onDebounceElapsed();
    // Rebuilding the tree for another repo drops the old items' selection and
    // emits an empty selection for the new repo — not a user's "show all".
    expect(reconciler.onSelection("/repo-b", [])).toEqual({
      kind: "ignore",
      reason: "repo-switch-empty"
    });
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  it("ignores the very first empty event (the initial tree build)", () => {
    const reconciler = createBranchSelectionReconciler();
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "repo-switch-empty"
    });
  });

  it("trusts a non-empty selection even right after a repo switch", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onDebounceElapsed();
    expect(reconciler.onSelection("/repo-b", ["dev"])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo-b", branches: ["dev"] });
  });

  it("the ignored repo-switch event still marks the repo as seen, so the next empty event is a genuine deselect-all", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onSelection("/repo-b", []); // ignored: repo switch
    expect(reconciler.onSelection("/repo-b", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo-b", branches: [] });
  });
});

describe("debounce coalescing", () => {
  it("rapid selections coalesce: the elapsed debounce yields only the latest", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onSelection("/repo", ["main", "dev"]);
    expect(reconciler.onDebounceElapsed()).toEqual({
      repo: "/repo",
      branches: ["main", "dev"]
    });
  });

  it("the pending write is one-shot", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });
});

describe("repo switch", () => {
  it("drops the previous repo's pending write", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onRepoSwitch("/repo-a");
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onRepoSwitch("/repo-b");
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  // The adapter re-points the view at the repo it is already on more often than
  // it switches: opening the graph does it, and so does an SCM selection growing
  // while its first entry stays put. Dropping the pending write there is the
  // behaviour this method has always had, and the guard below must not take it
  // away — hence a guard on the one step rather than an early return.
  it("drops the pending write even when the repo is unchanged", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onRepoSwitch("/repo");
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onRepoSwitch("/repo");
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  // Disarming on those same re-points would be a regression of its own: the
  // clear's empty event is still coming, and unsuppressed it lands in the window
  // between a direct write and its own clear — writing "show all" over the
  // non-empty filter the multi-pick search just set.
  it("a re-point at the same repo keeps a suppression that is still waiting", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onRepoSwitch("/repo");
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { selectionBeingCleared: ["main"] });

    reconciler.onRepoSwitch("/repo");

    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
  });

  // A direct write arms the suppression against an event the clear has not
  // emitted yet, and a hidden side view may never deliver it. The flag is
  // one-shot, so a stranded one is spent on whatever empty event comes next —
  // and after a repo switch that is a genuine deselect-all in another repo,
  // which would silently keep the old filter. The switch is the point where
  // the awaited event can no longer be coming.
  it("disarms a suppression whose event never arrived, so the next repo's deselect-all still shows all", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onRepoSwitch("/repo-a");
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo-a", [], { selectionBeingCleared: ["main"] });

    reconciler.onRepoSwitch("/repo-b");

    // The user picks a branch in the new repo, then deselects everything: that
    // last event is the user's "show all" and has to reach the store.
    reconciler.onSelection("/repo-b", ["dev"]);
    reconciler.onDebounceElapsed();
    expect(reconciler.onSelection("/repo-b", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo-b", branches: [] });
  });
});

describe("direct write (multi-pick search bypassing the tree)", () => {
  it("returns an immediate write and drops any pending debounced write", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    expect(
      reconciler.onDirectWrite("/repo", ["dev", "feat"], { selectionBeingCleared: [] })
    ).toEqual({
      repo: "/repo",
      branches: ["dev", "feat"]
    });
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  it("when the visual selection is about to be cleared, the resulting empty event is swallowed once", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { selectionBeingCleared: ["main"] });
    // The re-key that clears the highlight emits an empty selection; honouring
    // it would clobber the filter just written with "show all".
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
    // A second empty event is the user again: a genuine deselect-all.
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo", branches: [] });
  });

  it("when the clear will drop no branch selection, the next empty event is honoured", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev"], { selectionBeingCleared: [] });
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
  });

  // Regression (#42): the arming condition used to ask whether any row was
  // highlighted, which a folder satisfies without the clear being able to drop
  // it — stranding the flag. From here the reconciler sees only the empty
  // branch selection a folder-only highlight denotes; that the adapter derives
  // it that way is pinned in `branchTree.test.ts` ("branch selection of a
  // highlight").
  it("a highlight on nothing but folders arms nothing, so a later deselect-all still shows all", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", []);
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { selectionBeingCleared: [] });
    // No event follows the clear. The next empty event is the user, and it must
    // reach the store as "show all".
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo", branches: [] });
  });

  it("one selected branch alongside folders still arms: the clear drops that branch", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    // Folders in the highlight are already filtered out; one leaf is enough for
    // the clear to change the selection and so emit the empty event.
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { selectionBeingCleared: ["main"] });
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
  });

  it("the suppression only matches empty events: an intervening non-empty selection leaves it armed", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev"], { selectionBeingCleared: ["main"] });
    expect(reconciler.onSelection("/repo", ["feat"])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
  });

  it("the suppression outranks the repo-switch rule and still marks the new repo as seen", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo-a", ["dev"], { selectionBeingCleared: ["main"] });
    // The user switches repo before the re-key event lands: the one armed
    // suppression is consumed by whichever empty event arrives first.
    expect(reconciler.onSelection("/repo-b", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
    // …and /repo-b now counts as seen: the next empty event is a deselect-all.
    expect(reconciler.onSelection("/repo-b", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
  });
});

describe("a direct write performs its own steps", () => {
  /** A reconciler wired to recording stand-ins for the side view's four
   *  effects, so a test can read back exactly what one direct write did. */
  function recordingWriter(branchSelection: readonly string[]) {
    const writes: FilterWrite[] = [];
    const log: string[] = [];
    const reconciler = createBranchSelectionReconciler();
    const directWrite = createDirectFilterWriter(reconciler, {
      branchSelection: () => branchSelection,
      cancelPendingWrite: () => log.push("cancel"),
      writeFilter: (write: FilterWrite) => {
        writes.push(write);
        log.push("write");
      },
      clearVisualSelection: () => log.push("clear")
    });
    return { reconciler, directWrite, writes, log };
  }

  // The acceptance of #43: the empty selection show-all's own clearing emits is
  // an artefact, and writing the store outside the reconciler let it through as
  // a second, identical show-all write.
  it("show all writes the empty filter once; the clear's empty event adds no second write", () => {
    const { reconciler, directWrite, writes, log } = recordingWriter(["main"]);
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();

    directWrite("/repo", []);

    expect(writes).toEqual([{ repo: "/repo", branches: [] }]);
    // The store is written before the highlight goes, so the graph reloads once
    // rather than once per step.
    expect(log).toEqual(["cancel", "write", "clear"]);
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  it("the multi-pick search's chosen set takes the very same route", () => {
    const { reconciler, directWrite, writes } = recordingWriter(["main"]);
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();

    directWrite("/repo", ["dev", "feat"]);

    expect(writes).toEqual([{ repo: "/repo", branches: ["dev", "feat"] }]);
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
  });

  // The #42 rule is pinned on `onDirectWrite` above; what this adds is that the
  // writer is where the branch selection gets read, so no call site is left to
  // answer "which set?" for itself.
  it("reads the branch selection itself, so a folder-only highlight arms nothing", () => {
    const { reconciler, directWrite } = recordingWriter([]);
    reconciler.onSelection("/repo", []);

    directWrite("/repo", ["dev"]);

    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
    expect(reconciler.onDebounceElapsed()).toEqual({ repo: "/repo", branches: [] });
  });

  // Show All is one click away from a branch row, so it lands inside the
  // selection debounce often. The click's write must not arrive afterwards and
  // put the filter back to that one branch.
  it("a tree click still inside its debounce window cannot land after the write", () => {
    const { reconciler, directWrite, log } = recordingWriter(["main"]);
    reconciler.onSelection("/repo", ["main"]);

    directWrite("/repo", []);

    expect(log[0]).toBe("cancel");
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });
});
