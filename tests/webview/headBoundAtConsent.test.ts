import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

// Pull, merge-style rebase and friends bake the checked-out branch into their
// own question — "pull origin/feature into **main**" — but git is handed HEAD,
// not that name. A `git checkout` in the terminal reaches the webview through
// the file watcher and moves `gitBranchHead` while the dialog is still up, so
// "Yes" rebased or merged into a branch the user never agreed to. That is
// history-rewriting damage, and unlike the repo case it cannot be repaired by
// aiming at the captured value: you cannot pull into a branch that is not
// checked out. So this family refuses, and says so — the precedent is
// `dialogBatchBusy`, which opens an error dialog when state moved under an
// action (ADR-0019: guard where the state changes, and when the change is
// deferred into a callback, re-take the reading there).

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const OTHER_REPO = "/workspace/other";

const viewState = makeViewState({
  // Separate chips, so the remote branch can be right-clicked on its own.
  combineLocalAndRemoteBranchLabels: false,
  // A second repo, so the host can switch under an open dialog.
  repos: { [DEFAULT_REPO]: { columnWidths: null }, [OTHER_REPO]: { columnWidths: null } }
});

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    // One parent and a linear, non-merge path down to HEAD: what
    // `dropCommitPossible` asks for before it offers Drop at all.
    hash: "bbb222",
    parentHashes: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: [
      { hash: "bbb222", name: "feature", type: "head" },
      { hash: "bbb222", name: "origin/feature", type: "remote" }
    ]
  },
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Initial commit",
    refs: []
  }
];

// `satisfies` rather than a `GG.ResponseMessage` annotation: the scenarios below
// respread this with a different head, and an annotation widens it to the whole
// response union, which no longer knows it has a `head` to override.
const branchesResponse = {
  command: "loadBranches",
  token: 0,
  branches: ["main", "feature", "release"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
} satisfies GG.ResponseMessage;

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

function row(hash: string) {
  const elem = document.querySelector<HTMLElement>(`tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

function clickYes() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

describe("the branch a confirmation dialog named", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive(commitsResponse);
    mock.clearMessages();
  });

  afterEach(() => {
    receive(commitsResponse); // settle the reload the scenario left in flight
    receive(branchesResponse); // and put HEAD back on main for the next one
    mock.clearMessages();
  });

  /** A `git checkout release` in the terminal, arriving through the file
   *  watcher. Only the branch half of the reload is answered, so the reload
   *  never finishes and nothing dismisses the dialog — exactly the window the
   *  user is reading in. */
  function hostChecksOutRelease() {
    receive({ command: "refresh" });
    receive({ ...branchesResponse, head: "release", hard: false });
    expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();
  }

  it("refuses to pull into a branch that was checked out after the question was asked", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.pullIntoCurrentBranch + E);
    // The dialog's own wording is the consent: it promises `main`.
    expect(dialogText()).toContain("main");

    hostChecksOutRelease();
    expect(dialogText(), "the dialog restated its question").toContain("main");

    mock.clearMessages();
    clickYes();

    expect(sentOf("pullBranch")).toEqual([]);
    // A refusal the user cannot see is indistinguishable from a dead button.
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
  });

  it("refuses to rebase onto a branch once the branch being rebased has changed", () => {
    openMenuOn('.gitRef.head[data-name="feature"]');
    clickItem(L.rebaseOnBranch + E);
    expect(dialogText()).toContain("main");

    hostChecksOutRelease();
    mock.clearMessages();
    clickYes();

    expect(sentOf("rebaseOn")).toEqual([]);
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
  });

  it("refuses to rebase onto a commit once the branch being rebased has changed", () => {
    row("bbb222").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.rebaseOnCommit + E);
    expect(dialogText()).toContain("main");

    hostChecksOutRelease();
    mock.clearMessages();
    clickYes();

    expect(sentOf("rebaseOn")).toEqual([]);
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
  });

  // `dropCommit` names no branch in its own message, but it is a HEAD site all
  // the same: `git rebase --onto <hash>~1 <hash>` leaves out git's `<branch>`,
  // so git supplies HEAD. If HEAD has moved to a branch that does not contain
  // the commit, the replayed range is `<hash>..HEAD` — every commit on the new
  // branch, rewritten onto `<hash>~1`, with no git error to show for it. The
  // dialog does say it out loud: "rewrites the history of the current branch".
  it("refuses to drop a commit once the branch it would rewrite has changed", () => {
    row("bbb222").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.drop + E);
    expect(dialogText()).toContain("the history of the current branch");

    hostChecksOutRelease();
    mock.clearMessages();
    clickYes();

    expect(sentOf("dropCommit")).toEqual([]);
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
  });

  // Last, because it leaves the view on another repo.
  //
  // `gitBranchHead` is one scalar for whichever repo is on screen, not a
  // per-repo fact. So when the host switches repos under an open dialog, the
  // head this guard compares against stops being the captured repo's — and two
  // repos both sitting on `main` would satisfy it by coincidence, letting the
  // pull through having verified nothing about the repo it is aimed at. The
  // repo has to be checked before the head is worth reading at all.
  it("refuses when the repo moved, even though both repos are on a branch of the same name", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.pullIntoCurrentBranch + E);
    expect(dialogText()).toContain("main");

    // The host follows the Source Control view to another repo, and that repo's
    // branch list lands: same head *name*, entirely different repository.
    receive({ command: "setRepo", repo: OTHER_REPO });
    receive(branchesResponse);
    expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();

    mock.clearMessages();
    clickYes();

    expect(sentOf("pullBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
  });
});
