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

// A push form is built from `this.remotes` when it opens — one checkbox per
// remote, then the force-mode select — and its answer used to be read back
// against `this.remotes` as it stood when the user pressed Push:
//
//   this.remotes.filter((_, i) => values[i] === "checked")
//
// A `git remote add` / `remove` in the terminal reaches the webview through the
// file watcher while the form is still up, and that line then maps the user's
// ticks onto whichever remotes now occupy those positions. A tag ticked for
// `origin` went to `upstream`; the force mode was read off an index that now
// held a checkbox, or nothing. The single-remote forms read `this.remotes[0]`
// the same late way, and an emptied list made that `[undefined]` — length 1,
// so `push`'s own `remotes.length === 0` check waved it through and the
// branch was pushed to no remote at all.
//
// So the form now carries the *names* it showed, and re-takes the one premise
// a name stands on — that the remote still exists — at the moment of consent
// (ADR-0019). One vanished remote refuses the whole push, and says which: the
// user agreed to a set of remotes, and pushing to what is left of it is a
// push nobody agreed to.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const OTHER_REPO = "/workspace/other";

const viewState = makeViewState({
  repos: { [DEFAULT_REPO]: { columnWidths: null }, [OTHER_REPO]: { columnWidths: null } }
});

// No remote refs anywhere, so `tagCommitOnRemote` short-circuits to true and
// the tag goes straight to the remote choice.
const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tagged commit",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "v1.0", type: "tag" }
    ]
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

let mock: ReturnType<typeof createVscodeMock>;

const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

/** `git remote add` / `remove`, reaching the webview through the watcher. It
 *  closes no dialog — which the scenarios below check every time, since a
 *  dialog it had closed would have no Push left to press. */
function remotesBecome(remotes: string[]) {
  receive({ command: "loadRemotes", remotes, pushDefault: null });
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

/** The form's checkbox labelled `name`, which for a push form is a remote. */
function remoteBox(name: string) {
  const label = Array.from(document.querySelectorAll<HTMLLabelElement>("#dialog label")).find(
    (l) => (l.textContent ?? "").trim() === name
  );
  expect(label, name).toBeDefined();
  return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function chooseForceMode(mode: "normal" | "force" | "forceWithLease") {
  const select = document.querySelector<HTMLSelectElement>("#dialog select");
  expect(select, "the force-mode select").not.toBeNull();
  select!.value = mode;
}

function submit() {
  const action = document.getElementById("dialogAction");
  expect(action, "the dialog was dismissed").not.toBeNull();
  mock.clearMessages();
  action!.dispatchEvent(new MouseEvent("click"));
}

function openBranchPush() {
  openMenuOn('.gitRef.head[data-name="main"]');
  clickItem(L.pushBranch + E);
}

function openTagPush() {
  openMenuOn('.gitRef.tag[data-name="v1.0"]');
  clickItem(L.pushTag + E);
}

const remoteGone = (remote: string) => L.dialogPushRemoteGone.replace("{0}", remote);

describe("the remotes a push form showed", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  afterEach(() => {
    // Close whatever the scenario left up, and put the view back on the boot
    // repo with its branch list settled.
    document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
    receive({ command: "setRepo", repo: DEFAULT_REPO });
    receive(branchesResponse);
    receive(commitsResponse);
    mock.clearMessages();
  });

  it("pushes a branch to the remote ticked, by name, after the list was reordered", () => {
    remotesBecome(["origin", "upstream"]);
    openBranchPush();
    expect(remoteBox("origin").checked, "origin is the default").toBe(true);
    expect(remoteBox("upstream").checked).toBe(false);

    remotesBecome(["upstream", "origin"]);
    submit();

    expect(sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "main",
        remotes: ["origin"],
        forceMode: "normal"
      }
    ]);
  });

  it("keeps the force mode chosen when a remote is added under the form", () => {
    remotesBecome(["origin", "upstream"]);
    openBranchPush();
    chooseForceMode("force");

    remotesBecome(["origin", "upstream", "backup"]);
    submit();

    expect(sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "main",
        remotes: ["origin"],
        forceMode: "force"
      }
    ]);
  });

  it("refuses the whole push, naming the remote, when a ticked remote vanished", () => {
    remotesBecome(["origin", "upstream", "backup"]);
    openBranchPush();
    remoteBox("backup").checked = true;

    remotesBecome(["origin", "upstream"]);
    submit();

    // Not `["origin"]`: the user agreed to two remotes, and pushing to the one
    // that is left is a push nobody agreed to.
    expect(sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(remoteGone("backup"));
  });

  it("does not refuse over a remote that vanished without being ticked", () => {
    remotesBecome(["origin", "upstream"]);
    openBranchPush();

    remotesBecome(["origin"]);
    submit();

    expect(sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "main",
        remotes: ["origin"],
        forceMode: "normal"
      }
    ]);
  });

  it("pushes a branch nowhere rather than to an undefined remote once the only remote is gone", () => {
    remotesBecome(["origin"]);
    openBranchPush();

    remotesBecome([]);
    submit();

    // `[this.remotes[0]]` read here was `[undefined]`: length 1, so the empty
    // check let it through.
    expect(sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(remoteGone("origin"));
  });

  it("pushes a tag to the remote ticked, and refuses once that remote is gone", () => {
    remotesBecome(["origin", "upstream"]);
    openTagPush();
    expect(remoteBox("origin").checked).toBe(true);

    // origin removed: the index the tick sat at now holds `upstream`, which
    // the user left unticked.
    remotesBecome(["upstream"]);
    submit();

    expect(sentOf("pushTag")).toEqual([]);
    expect(dialogText()).toContain(remoteGone("origin"));
  });

  it("pushes a tag to the remotes ticked, by name, after the list was reordered", () => {
    remotesBecome(["origin", "upstream"]);
    openTagPush();

    remotesBecome(["upstream", "origin"]);
    submit();

    expect(sentOf("pushTag")).toEqual([
      { command: "pushTag", repo: DEFAULT_REPO, tagName: "v1.0", remotes: ["origin"] }
    ]);
  });

  it("pushes a tag nowhere rather than to an undefined remote once the only remote is gone", () => {
    remotesBecome(["origin"]);
    openTagPush();
    expect(document.getElementById("dialogAction")).not.toBeNull();

    remotesBecome([]);
    submit();

    expect(sentOf("pushTag")).toEqual([]);
    // Said out loud, not swallowed. `push`'s own empty-list return is silent
    // because reaching it means the user unticked every remote; this one is a
    // refusal of something they did ask for, and the file's own rule (see
    // `confirmForRepoAndHead`) is that those are visible.
    expect(dialogText()).toContain(remoteGone("origin"));
  });

  it("creates no tag at all when the remote it was also to be pushed to is gone", () => {
    remotesBecome(["origin"]);
    openMenuOn('tr.commit[data-hash="aaa111"]');
    clickItem(L.addTag + E);
    const name = document.querySelector<HTMLInputElement>("#dialogInput0")!;
    name.value = "v2.0";
    name.dispatchEvent(new KeyboardEvent("keyup"));
    remoteBox(L.dialogAddTagPushToRemote).checked = true;

    remotesBecome([]);
    submit();

    // The tag and its push are one request; creating the tag and failing the
    // push would leave half of what was agreed to.
    expect(sentOf("addTag")).toEqual([]);
    expect(dialogText()).toContain(remoteGone("origin"));
  });

  // A remote name is only a fact about one repository, and `this.remotes` only
  // describes the one on screen. Once the host has moved the view, whether the
  // names the form showed still exist in the repo it was opened on cannot be
  // read from here — the same reason {@link confirmForRepoAndHead} refuses
  // once the repo has moved, rather than re-aiming at the captured one.
  it("refuses rather than push by names it can no longer check, once the repo moved", () => {
    remotesBecome(["origin", "upstream"]);
    openBranchPush();

    receive({ command: "setRepo", repo: OTHER_REPO });
    submit();

    expect(sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRepoMoved);
  });

  it("pushes a batch to the remotes ticked, by name, in the repo it was confirmed for", () => {
    remotesBecome(["origin", "upstream"]);
    receive({
      command: "runRefBatchAction",
      repo: DEFAULT_REPO,
      action: "push",
      targets: ["main"],
      skipped: [],
      seq: 1
    });
    expect(remoteBox("origin").checked).toBe(true);

    remotesBecome(["upstream", "origin"]);
    submit();

    expect(sentOf("pushBranches")).toEqual([
      {
        command: "pushBranches",
        repo: DEFAULT_REPO,
        branchNames: ["main"],
        remotes: ["origin"],
        forceMode: "normal"
      }
    ]);
    // Summarise the run so it goes back to idle; a second batch is refused as
    // busy on purpose.
    receive({
      command: "pushBranches",
      results: [{ ref: "main", status: null, remoteUpdatedSinceCheckout: false }]
    });
  });
});
