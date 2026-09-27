import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A batch Force with lease can be refused for some branches because their
// remote tip was fetched but never integrated (ADR-0025). Each refused branch
// keeps git's own line in the summary, and the summary explains the reason
// once at the bottom — the same explanation a single push gets, not one per
// branch. No one-click force and no force round.

const L = getWebviewLocalizedStrings();

const LEASE_LINE = "[rejected]        feature-a -> feature-a (remote ref updated since checkout)";
const EXPLANATION = "Pull or rebase first, then push again.";

const commits: GitCommitNode[] = [
  {
    hash: "head1",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Base",
    refs: [
      { hash: "head1", name: "main", type: "head" },
      { hash: "head1", name: "feature-a", type: "head" },
      { hash: "head1", name: "feature-b", type: "head" }
    ]
  }
];

function dialogText(): string {
  return document.getElementById("dialog")!.textContent ?? "";
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function confirmDialog() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

/** Load the view, and answer the reload a dismissed summary kicks off, so the
 *  next batch is not held back behind it. */
function loadView() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature-a", "feature-b"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "head1",
    moreCommitsAvailable: false,
    hard: true
  });
}

let seq = 0;
/** Delegate a batch from the Branches side-view and confirm its dialog. */
function runBatch(action: "push" | "delete", targets: string[]) {
  receive({
    command: "runRefBatchAction",
    repo: DEFAULT_REPO,
    action,
    targets,
    skipped: [],
    seq: ++seq
  });
  confirmDialog();
}

describe("a batch push summary", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    loadView();
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  afterEach(() => {
    dismissDialog(); // dismissing a summary refreshes the graph
    loadView();
  });

  it("explains a lease refused for an unintegrated remote tip once, beneath every ref's line", () => {
    const secondLeaseLine =
      "[rejected]        feature-b -> feature-b (remote ref updated since checkout)";
    // A failure of another kind among them: one flagged failure is enough.
    const nonFastForward = "[rejected]        main -> main (non-fast-forward)";
    runBatch("push", ["main", "feature-a", "feature-b"]);
    expect(mock.sentMessages.some((m) => m.command === "pushBranches")).toBe(true);

    receive({
      command: "pushBranches",
      results: [
        { ref: "main", status: nonFastForward, remoteUpdatedSinceCheckout: false },
        { ref: "feature-a", status: LEASE_LINE, remoteUpdatedSinceCheckout: true },
        { ref: "feature-b", status: secondLeaseLine, remoteUpdatedSinceCheckout: true }
      ]
    });

    // English literals, not `L.dialogPushForceLeaseRefused`: rebuilding the
    // expectation from the same template the code uses could never disagree.
    const text = dialogText();
    expect(text).toContain(L.unableToPushBranch);
    expect(text).toContain("0 succeeded, 3 failed");
    expect(text, "each refused ref keeps git's own line").toContain("main: " + nonFastForward);
    expect(text).toContain("feature-a: " + LEASE_LINE);
    expect(text).toContain("feature-b: " + secondLeaseLine);
    expect(occurrences(text, EXPLANATION), "one explanation, not one per ref").toBe(1);
    expect(text).toContain(`To overwrite anyway, choose ${L.dialogPushForceForce}.`);
    expect(text).not.toContain("{0}");
    expect(
      text.indexOf(EXPLANATION),
      "the explanation sits at the bottom, below the ref lines"
    ).toBeGreaterThan(text.indexOf(secondLeaseLine));
    expect(document.getElementById("dialogAction"), "no one-click force").toBeNull();
  });

  it("adds no explanation when no failure was a lease refusal", () => {
    const nonFastForward = "[rejected]        feature-a -> feature-a (non-fast-forward)";
    runBatch("push", ["feature-a", "feature-b"]);

    receive({
      command: "pushBranches",
      results: [
        { ref: "feature-a", status: nonFastForward, remoteUpdatedSinceCheckout: false },
        { ref: "feature-b", status: null, remoteUpdatedSinceCheckout: false }
      ]
    });

    const text = dialogText();
    expect(text).toContain("feature-a: " + nonFastForward);
    expect(text).not.toContain(EXPLANATION);
  });
});

describe("a batch delete summary", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    loadView();
  });

  it("is unaffected by the push explanation", () => {
    runBatch("delete", ["feature-a", "feature-b"]);
    receive({
      command: "deleteBranches",
      results: [
        { ref: "feature-a", status: null, notFullyMerged: false },
        { ref: "feature-b", status: "error: cannot lock ref", notFullyMerged: false }
      ]
    });

    const text = dialogText();
    expect(text).toContain(L.unableToDeleteBranch);
    expect(text).toContain("1 succeeded, 1 failed");
    expect(text).toContain("feature-b: error: cannot lock ref");
    expect(text).not.toContain(EXPLANATION);
  });
});
