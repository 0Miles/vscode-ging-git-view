import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as GG from "@/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const REPO = DEFAULT_REPO;

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: false });

const candidate = (ref: string, facts: Partial<GG.CleanupCandidateFacts>): GG.CleanupCandidate => ({
  ref,
  isRemote: ref.startsWith("remotes/"),
  facts: { merged: false, redundant: false, inactive: false, ...facts }
});

const payload = (candidates: GG.CleanupCandidate[]): GG.BranchCleanupPayload => ({
  candidates,
  defaultBranch: "main",
  defaultBranchDate: 1_700_000_000,
  remotesHidden: false,
  scannable: 3
});

function rowBoxes(): HTMLInputElement[] {
  const found: HTMLInputElement[] = [];
  document
    .querySelectorAll<HTMLInputElement>("#dialog .cleanupRow input")
    .forEach((box) => found.push(box));
  return found;
}

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

function notices(): string {
  return document.getElementById("cleanupNotices")!.textContent ?? "";
}

function groupToggle(isRemote: boolean): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    `#dialog .cleanupGroupToggle[data-remote="${isRemote}"]`
  )!;
}

describe("the branch cleanup dialog delivered by the host", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "merged", "old", "remotes/origin/squashed"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits: [],
      head: null,
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("opens with the mainline-content rows ticked and the idle one not", () => {
    receive({
      command: "showBranchCleanup",
      repo: REPO,
      seq: 1,
      payload: payload([
        candidate("remotes/origin/squashed", { redundant: true }),
        candidate("merged", { merged: true }),
        candidate("old", { inactive: true })
      ])
    });

    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(true);
    const state = Object.fromEntries(rowBoxes().map((b) => [b.dataset.ref, b.checked]));
    expect(state).toEqual({
      "remotes/origin/squashed": true,
      merged: true,
      old: false
    });
    // Remote rows are shown by their display ref, never the canonical one.
    expect(document.getElementById("dialog")!.textContent).toContain("origin/squashed");
  });

  it("deletes exactly the ticked branches, through the shared batch request", () => {
    // The dialog's own confirmation is the only one (ADR-0014): confirming goes
    // straight into the same `deleteBranches` request the side-view's batch
    // delete uses, with no second dialog in between.
    rowBoxes()
      .find((b) => b.dataset.ref === "merged")!
      .click();
    mock.clearMessages();
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages.find((m) => m.command === "deleteBranches")).toMatchObject({
      repo: REPO,
      refs: ["remotes/origin/squashed"],
      forceDelete: false
    });
    dismissDialog();
  });

  it("warns about the force round for any ticked local branch git may refuse", () => {
    // `merged` is the only fact carrying git's `branch -d` guarantee, so the
    // warning tracks its absence — an idle branch that was never merged is
    // refused just as surely as a redundant one.
    receive({
      command: "showBranchCleanup",
      repo: REPO,
      seq: 2,
      payload: payload([
        candidate("merged", { merged: true }),
        candidate("old", { inactive: true })
      ])
    });
    // Only the guaranteed-safe row is ticked to begin with.
    expect(notices()).not.toContain("force");

    rowBoxes()
      .find((b) => b.dataset.ref === "old")!
      .click();
    expect(notices()).toContain("force");
    dismissDialog();
  });

  it("offers one delete option only — never an implied remote delete", () => {
    // A remote is deleted by ticking its own row, so "also delete on remotes"
    // would be a second, invisible route to the same refs.
    receive({
      command: "showBranchCleanup",
      repo: REPO,
      seq: 3,
      payload: payload([
        candidate("remotes/origin/squashed", { redundant: true }),
        candidate("merged", { merged: true })
      ])
    });
    expect(document.getElementById("dialogInput0")).not.toBeNull();
    expect(document.getElementById("dialogInput1")).toBeNull();
    dismissDialog();
  });

  it("selects and clears a whole group from its heading", () => {
    receive({
      command: "showBranchCleanup",
      repo: REPO,
      seq: 4,
      payload: payload([
        candidate("remotes/origin/squashed", { redundant: true }),
        candidate("remotes/origin/idle", { inactive: true }),
        candidate("merged", { merged: true })
      ])
    });

    // Two of the three remote rows' states differ, so the heading is neither.
    expect(groupToggle(true).checked).toBe(false);
    expect(groupToggle(true).indeterminate).toBe(true);
    // The local group is fully ticked by the default rule.
    expect(groupToggle(false).checked).toBe(true);
    expect(groupToggle(false).indeterminate).toBe(false);

    // Clicking an indeterminate heading ticks the group, and leaves the other
    // group alone.
    groupToggle(true).click();
    const ticked = () =>
      rowBoxes()
        .filter((b) => b.checked)
        .map((b) => b.dataset.ref);
    expect(ticked()).toEqual(["remotes/origin/squashed", "remotes/origin/idle", "merged"]);
    expect(groupToggle(true).indeterminate).toBe(false);

    // And clearing it takes only its own rows away.
    groupToggle(true).click();
    expect(ticked()).toEqual(["merged"]);
    expect(groupToggle(true).checked).toBe(false);
    expect(groupToggle(false).checked).toBe(true);
    dismissDialog();
  });

  it("ignores a duplicate delivery of the same seq", () => {
    // The host posts over two paths to survive a panel that is still loading, so
    // the cleanup message shares the ref actions' dedupe (ADR-0014).
    receive({
      command: "showBranchCleanup",
      repo: REPO,
      seq: 1,
      payload: payload([candidate("merged", { merged: true })])
    });
    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(false);
  });
});
