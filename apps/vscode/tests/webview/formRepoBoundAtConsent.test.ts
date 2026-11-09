import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  dialogText,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

// `repoBoundAtConsent` is this premise for confirmations; this is the same one
// for the dialogs that answer with something — a form's values, a select's
// choice, a typed name. Their callbacks read `this.currentRepo` once the user
// had answered, and the host's `setRepo` closes no dialog, so the answer went
// to whichever repository was current by then (#132).
//
// Each of these acts on the repository alone, so it is re-aimed at the one the
// dialog opened on rather than refused, for `confirmForRepo`'s reason. The
// scenarios hand the view back and forth between two repos, so every other
// assertion names the *other* one, and a fix that hard-coded the boot repo
// would fail half of them.
//
// The HEAD sites among the forms (merge, reset, cherry-pick, revert) refuse
// instead; the ones reachable from `headBoundAtConsent`'s fixture are tested
// there, and the two only a merge commit reaches are at the bottom of this one.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const REPO_B = "/workspace/repo-b";

const viewState = makeViewState({
  // Separate chips, so the remote branch can be right-clicked on its own.
  combineLocalAndRemoteBranchLabels: false,
  repos: { [DEFAULT_REPO]: { columnWidths: null }, [REPO_B]: { columnWidths: null } }
});

function node(
  hash: string,
  parentHashes: string[],
  refs: GitCommitNode["refs"] = []
): GitCommitNode {
  return {
    hash,
    parentHashes,
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "commit " + hash,
    refs
  };
}

// `mmm000` is a merge commit, for the parent select that revert and
// cherry-pick put in front of one.
const commits: GitCommitNode[] = [
  node(
    "aaa111",
    ["mmm000"],
    [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "v1.0", type: "tag" }
    ]
  ),
  node("mmm000", ["bbb222", "ccc333"]),
  node(
    "bbb222",
    ["ccc333"],
    [
      { hash: "bbb222", name: "feature", type: "head" },
      { hash: "bbb222", name: "origin/feature", type: "remote" }
    ]
  ),
  node("ccc333", [])
];

const branchesResponse = {
  command: "loadBranches",
  token: 0,
  branches: ["main", "feature"],
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

let mock: ReturnType<typeof createVscodeMock>;
let current = DEFAULT_REPO;

const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

function loadView() {
  receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
  receive(branchesResponse);
  receive(commitsResponse);
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** Type into a form's text field the way a user does: the keyup is what lifts
 *  a ref field's "nothing entered" state. */
function typeInto(index: number, text: string) {
  const input = document.querySelector<HTMLInputElement>(`#dialogInput${index}`);
  expect(input, `field ${index}`).not.toBeNull();
  input!.value = text;
  input!.dispatchEvent(new KeyboardEvent("keyup"));
}

function choose(value: string) {
  const select = document.querySelector<HTMLSelectElement>("#dialog select");
  expect(select, "the select").not.toBeNull();
  select!.value = value;
}

function submit() {
  const action = document.getElementById("dialogAction");
  expect(action, "the dialog was dismissed").not.toBeNull();
  mock.clearMessages();
  action!.dispatchEvent(new MouseEvent("click"));
}

/** The host following the Source Control view onto the other repo, mid-dialog.
 *  Returns the repo the dialog was opened on. */
function hostMovesToOtherRepo() {
  const opened = current;
  current = current === DEFAULT_REPO ? REPO_B : DEFAULT_REPO;
  receive({ command: "setRepo", repo: current });
  expect(document.getElementById("dialogAction"), "setRepo closed the dialog").not.toBeNull();
  return opened;
}

describe("the repository a form was answered for", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    loadView();
  });

  // Answer the reload `setRepo` started, so the next scenario opens its menu
  // on a settled view of the repo it was handed.
  afterEach(() => {
    document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
    loadView();
    mock.clearMessages();
  });

  it("checks out a commit in the repo the form opened on", () => {
    openMenuOn('tr.commit[data-hash="bbb222"]');
    clickItem(L.checkout + E);
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("checkoutCommit")).toEqual([
      { command: "checkoutCommit", repo: opened, commitHash: "bbb222" }
    ]);
  });

  it("creates a branch in the repo the form opened on", () => {
    openMenuOn('tr.commit[data-hash="bbb222"]');
    clickItem(L.createBranch + E);
    typeInto(0, "topic");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("createBranch")).toEqual([
      expect.objectContaining({ repo: opened, branchName: "topic", commitHash: "bbb222" })
    ]);
  });

  // Whether the name is taken is read off the branch list on screen, which
  // after a move is another repository's. It cannot vouch for the captured
  // one, so no "replace it?" is asked on its word — and without that consent
  // nothing is forced: git refuses a name that does exist, out loud.
  it("does not offer to replace a branch on the word of another repo's branch list", () => {
    openMenuOn('tr.commit[data-hash="bbb222"]');
    clickItem(L.createBranch + E);
    typeInto(0, "feature");
    const opened = hostMovesToOtherRepo();
    receive(branchesResponse); // the other repo has a `feature` too
    submit();

    expect(sentOf("createBranch")).toEqual([
      expect.objectContaining({ repo: opened, branchName: "feature", force: false })
    ]);
  });

  it("adds a tag in the repo the form opened on", () => {
    openMenuOn('tr.commit[data-hash="bbb222"]');
    clickItem(L.addTag + E);
    typeInto(0, "v2.0");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("addTag")).toEqual([
      expect.objectContaining({
        repo: opened,
        tagName: "v2.0",
        commitHash: "bbb222",
        pushToRemote: null
      })
    ]);
  });

  it("renames a branch in the repo the form opened on", () => {
    openMenuOn('.gitRef.head[data-name="feature"]');
    clickItem(L.renameBranch + E);
    typeInto(0, "feature-2");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("renameBranch")).toEqual([
      { command: "renameBranch", repo: opened, oldName: "feature", newName: "feature-2" }
    ]);
  });

  it("deletes a branch in the repo the form opened on", () => {
    openMenuOn('.gitRef.head[data-name="feature"]');
    clickItem(L.deleteBranch + E);
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("deleteBranch")).toEqual([
      expect.objectContaining({ repo: opened, branchName: "feature" })
    ]);
  });

  it("deletes a batch of branches in the repo the form opened on", () => {
    receive({
      command: "runRefBatchAction",
      repo: current,
      action: "delete",
      targets: ["feature"],
      skipped: [],
      seq: 1
    });
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("deleteBranches")).toEqual([
      expect.objectContaining({ repo: opened, refs: ["feature"] })
    ]);
    // Summarise the run so it goes back to idle; a second batch is refused as
    // busy on purpose.
    receive({
      command: "deleteBranches",
      results: [{ ref: "feature", status: null, notFullyMerged: false }]
    });
  });

  it("fetches into a local branch of the repo the form opened on", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.fetchIntoLocalBranch + E);
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("fetchIntoLocalBranch")).toEqual([
      {
        command: "fetchIntoLocalBranch",
        repo: opened,
        remote: "origin",
        remoteBranch: "feature",
        localBranch: "feature",
        force: false
      }
    ]);
  });

  it("checks out the existing local branch of the repo the select opened on", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.checkoutBranch + E);
    choose("existing");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("checkoutBranch")).toEqual([
      {
        command: "checkoutBranch",
        repo: opened,
        branchName: "feature",
        remoteBranch: null,
        force: false
      }
    ]);
  });

  it("resets the local branch of the repo the select opened on", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.checkoutBranch + E);
    choose("reset");
    submit(); // the select, which opens the destructive confirmation
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("checkoutBranch")).toEqual([
      {
        command: "checkoutBranch",
        repo: opened,
        branchName: "feature",
        remoteBranch: "origin/feature",
        force: true
      }
    ]);
  });

  it("checks out a new local branch in the repo the select opened on", () => {
    openMenuOn('.gitRef.remote[data-name="origin/feature"]');
    clickItem(L.checkoutBranch + E);
    choose("new");
    submit(); // the select, which opens the name prompt
    typeInto(0, "feature-copy");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("checkoutBranch")).toEqual([
      {
        command: "checkoutBranch",
        repo: opened,
        branchName: "feature-copy",
        remoteBranch: "origin/feature",
        force: false
      }
    ]);
  });

  it("deletes a tag locally in the repo the select opened on", () => {
    openMenuOn('.gitRef.tag[data-name="v1.0"]');
    clickItem(L.deleteTag + E);
    choose("");
    const opened = hostMovesToOtherRepo();
    submit();

    expect(sentOf("deleteTag")).toEqual([
      { command: "deleteTag", repo: opened, tagName: "v1.0", deleteOnRemote: null }
    ]);
  });

  // `v1.0` is on no remote branch, so pushing it asks a warning first, and the
  // remote choice only opens once that is answered. The repo is the one the
  // first question was about, not whichever is current by the second.
  it("pushes a tag nowhere once the repo moved under its not-on-remote warning", () => {
    openMenuOn('.gitRef.tag[data-name="v1.0"]');
    clickItem(L.pushTag + E);
    expect(dialogText()).toContain(L.dialogPushTagNotOnRemote.replace("{0}", "v1.0"));
    hostMovesToOtherRepo();
    submit(); // the warning
    submit(); // the single-remote confirmation

    expect(sentOf("pushTag")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRepoMoved);
  });

  // Deleting on a remote is a push, and stands on the same premise as one
  // (`remoteBoundAtConsent`): the local delete and the remote one are a single
  // request, so a remote that cannot be pushed to refuses both halves rather
  // than leave the tag deleted here and still there.
  it("deletes nothing when the remote it was also to be deleted on is gone", () => {
    openMenuOn('.gitRef.tag[data-name="v1.0"]');
    clickItem(L.deleteTag + E);
    choose("origin");
    receive({ command: "loadRemotes", remotes: [], pushDefault: null });
    submit();

    expect(sentOf("deleteTag")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRemoteGone.replace("{0}", "origin"));
  });

  it("deletes nothing on a remote it can no longer check, once the repo moved", () => {
    openMenuOn('.gitRef.tag[data-name="v1.0"]');
    clickItem(L.deleteTag + E);
    choose("origin");
    hostMovesToOtherRepo();
    submit();

    expect(sentOf("deleteTag")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRepoMoved);
  });

  // The parent select only a merge commit puts in front of revert and
  // cherry-pick. Both commit onto whatever HEAD is when git runs.
  it.each([
    ["revertCommit", L.revert + E],
    ["cherrypickCommit", L.cherryPick + E]
  ])(
    "refuses %s of a merge commit once the branch it would write to has changed",
    (command, item) => {
      openMenuOn('tr.commit[data-hash="mmm000"]');
      clickItem(item);
      expect(document.querySelector("#dialog select"), "the parent select").not.toBeNull();

      // `git checkout feature` in the terminal, through the file watcher.
      receive({ command: "refresh" });
      receive({ ...branchesResponse, head: "feature", hard: false });
      submit();

      expect(sentOf(command)).toEqual([]);
      expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "main"));
    }
  );
});
