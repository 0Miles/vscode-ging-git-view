import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: false });

// A remote branch "origin/feature" that also has a divergent local branch "feature".
const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: [{ hash: "abc123", name: "origin/feature", type: "remote" }]
  }
];

describe("checking out a remote branch when a divergent local branch already exists", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "feature"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits,
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("offers a reset option that force-checks-out from the remote after confirmation", () => {
    const ref = document.querySelector<HTMLElement>(".gitRef.remote");
    expect(ref).not.toBeNull();

    // Double-clicking the ref triggers the checkout-branch action; because a
    // local branch named "feature" already exists, a select dialog is shown.
    ref!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const select = document.getElementById("dialogInput0") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.value)).toContain("reset");

    // Pick the reset option and action the dialog.
    select.value = "reset";
    mock.clearMessages();
    document
      .getElementById("dialogAction")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // The destructive checkout is gated behind a confirmation: nothing sent yet.
    expect(mock.sentMessages.find((m) => m.command === "checkoutBranch")).toBeUndefined();

    // Confirm -> a forced checkoutBranch message is sent against the remote ref.
    document
      .getElementById("dialogAction")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const checkout = mock.sentMessages.find((m) => m.command === "checkoutBranch");
    expect(checkout).toMatchObject({
      command: "checkoutBranch",
      branchName: "feature",
      remoteBranch: "origin/feature",
      force: true
    });
  });
});
