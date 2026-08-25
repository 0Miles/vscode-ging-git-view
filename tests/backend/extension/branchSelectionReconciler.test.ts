import { describe, expect, it } from "vitest";

import {
  createBranchSelectionReconciler,
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
    reconciler.onSelection("/repo-a", ["main"]);
    reconciler.onRepoSwitch();
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });
});

describe("direct write (multi-pick search bypassing the tree)", () => {
  it("returns an immediate write and drops any pending debounced write", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    expect(reconciler.onDirectWrite("/repo", ["dev", "feat"], { clearedSelection: [] })).toEqual({
      repo: "/repo",
      branches: ["dev", "feat"]
    });
    expect(reconciler.onDebounceElapsed()).toBeNull();
  });

  it("when the visual selection is about to be cleared, the resulting empty event is swallowed once", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { clearedSelection: ["main"] });
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
    reconciler.onDirectWrite("/repo", ["dev"], { clearedSelection: [] });
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "schedule",
      delayMs: SELECTION_WRITE_DEBOUNCE_MS
    });
  });

  // Regression (#42): the arming condition asks whether the *branch* selection
  // is about to be dropped, not whether any row is highlighted. `clearSelection()`
  // re-keys leaf items only — folder and group ids carry a different generation
  // — so a highlight sitting on nothing but folders survives it untouched and
  // the TreeView emits no selection event at all. Arming there left the flag
  // hanging until the user's next real deselect-all, which it then swallowed.
  it("a highlight on nothing but folders arms nothing, so a later deselect-all still shows all", () => {
    const reconciler = createBranchSelectionReconciler();
    // Clicking a folder row selects it in the TreeView but adds no branch to
    // the selection, so the adapter reports an empty one either way.
    reconciler.onSelection("/repo", []);
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { clearedSelection: [] });
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
    reconciler.onDirectWrite("/repo", ["dev", "feat"], { clearedSelection: ["main"] });
    expect(reconciler.onSelection("/repo", [])).toEqual({
      kind: "ignore",
      reason: "suppressed-empty"
    });
  });

  it("the suppression only matches empty events: an intervening non-empty selection leaves it armed", () => {
    const reconciler = createBranchSelectionReconciler();
    reconciler.onSelection("/repo", ["main"]);
    reconciler.onDebounceElapsed();
    reconciler.onDirectWrite("/repo", ["dev"], { clearedSelection: ["main"] });
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
    reconciler.onDirectWrite("/repo-a", ["dev"], { clearedSelection: ["main"] });
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
