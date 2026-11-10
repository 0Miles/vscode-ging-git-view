import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@ging/shared/backend/types";
import type * as GG from "@ging/shared/types";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  dialogText,
  englishStrings,
  makeViewState,
  openMenuOn,
  receive,
  setupHtml
} from "./setup";

// The single-branch Push dialog asks for the force mode, offers "Remember my
// choice" for it, and folds the destination under "Advanced" (#17, #303): one
// tick per remote, the push-default remote alone ticked, then a target branch
// name, the branch's own to start with. Folding only hides them — they count
// collapsed or not — and left as they start they push where the dialog always
// did, with the message it always sent.

const L = englishStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const OTHER_REPO = "/workspace/other";

const viewState = makeViewState({
  repos: { [DEFAULT_REPO]: { columnWidths: null }, [OTHER_REPO]: { columnWidths: null } }
});

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Work",
    refs: [{ hash: "aaa111", name: "feature", type: "head" }]
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["feature"],
  head: "feature",
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

function remotesAre(remotes: string[], pushDefault: string | null = null) {
  receive({ command: "loadRemotes", remotes, pushDefault });
}

function openBranchPush() {
  openMenuOn('.gitRef.head[data-name="feature"]');
  clickItem(L.pushBranch + E);
}

function advancedSection() {
  return document.querySelector<HTMLDetailsElement>("#dialog details");
}

/** The control in the row labelled `label`. */
function field<T extends HTMLElement>(label: string): T {
  const cell = Array.from(document.querySelectorAll("#dialog td")).find(
    (td) => (td.textContent ?? "").trim() === label
  );
  expect(cell, label).toBeDefined();
  const control = cell!.parentElement!.querySelector<T>("select, input");
  expect(control, label).not.toBeNull();
  return control!;
}

function targetInput() {
  return field<HTMLInputElement>(L.dialogPushBranchTarget);
}

/** Type into the target box: the value, then the keyup validation listens to. */
function typeTarget(value: string) {
  const input = targetInput();
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keyup"));
}

function remoteBox(name: string) {
  const label = Array.from(document.querySelectorAll<HTMLLabelElement>("#dialog label")).find(
    (l) => (l.textContent ?? "").trim() === name
  );
  expect(label, name).toBeDefined();
  return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function forceSelect() {
  const select = document.querySelector<HTMLSelectElement>("#dialog select");
  expect(select, "the force-mode select").not.toBeNull();
  return select!;
}

function rememberBox() {
  return document.getElementById("dialogRememberChoice") as HTMLInputElement;
}

function submit() {
  const action = document.getElementById("dialogAction");
  expect(action, "the dialog was dismissed").not.toBeNull();
  mock.clearMessages();
  action!.dispatchEvent(new MouseEvent("click"));
}

describe("the Push dialog's advanced section", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@ging/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  afterEach(() => {
    document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
    receive({ command: "setRepo", repo: DEFAULT_REPO });
    receive(branchesResponse);
    receive(commitsResponse);
    mock.clearMessages();
  });

  it("sends exactly what it always sent when left alone, with one remote", () => {
    remotesAre(["origin"]);
    openBranchPush();
    expect(advancedSection()!.open, "collapsed by default").toBe(false);
    forceSelect().value = "force";

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["origin"],
        forceMode: "force"
      }
    ]);
  });

  it("pushes to the push-default remote alone when left alone, with several", () => {
    remotesAre(["origin", "upstream", "backup"], "upstream");
    openBranchPush();
    expect(advancedSection()!.open, "collapsed by default").toBe(false);

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["upstream"],
        forceMode: "normal"
      }
    ]);
  });

  it("asks for the force mode and its memory up front, and folds the destination under Advanced", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    const section = advancedSection()!;

    expect(section.querySelector("summary")!.textContent).toBe(L.dialogPushBranchAdvanced);
    expect(section.contains(forceSelect()), "the force mode is not folded").toBe(false);
    expect(
      rememberBox().compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
      "Remember my choice sits above the section"
    ).not.toBe(0);
    expect(section.contains(remoteBox("origin")), "the remote ticks are folded").toBe(true);
    expect(section.contains(targetInput()), "the target is folded").toBe(true);
    expect(section.querySelector("select"), "no remote dropdown").toBeNull();
    expect(remoteBox("origin").checked).toBe(true);
    expect(remoteBox("upstream").checked).toBe(false);
    expect(targetInput().value).toBe("feature");
  });

  it("offers no tick for a lone remote, the only destination there is", () => {
    remotesAre(["origin"]);
    openBranchPush();

    expect(advancedSection()!.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("pushes to every remote ticked", () => {
    remotesAre(["origin", "upstream", "backup"]);
    openBranchPush();
    advancedSection()!.open = true;
    remoteBox("backup").checked = true;
    forceSelect().value = "forceWithLease";

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["origin", "backup"],
        forceMode: "forceWithLease"
      }
    ]);
  });

  it("counts the ticks and the target once folded away again", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    advancedSection()!.open = true;
    remoteBox("origin").checked = false;
    remoteBox("upstream").checked = true;
    typeTarget("review/feature");
    advancedSection()!.open = false;

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["upstream"],
        forceMode: "normal",
        targetBranch: "review/feature"
      }
    ]);
  });

  it("names no target while the target is still the branch's own name", () => {
    remotesAre(["origin"]);
    openBranchPush();
    advancedSection()!.open = true;
    typeTarget("elsewhere");
    typeTarget("feature");

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["origin"],
        forceMode: "normal"
      }
    ]);
  });

  it("pushes nothing once every remote is unticked", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    remoteBox("origin").checked = false;

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["a name git would refuse", "bad..name"]
  ])("cannot push to a target that is %s", (_, target) => {
    remotesAre(["origin"]);
    openBranchPush();
    advancedSection()!.open = true;
    typeTarget(target);

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(document.getElementById("dialogAction"), "the dialog stays up").not.toBeNull();
  });

  it("refuses a bad target folded out of sight, and unfolds it to show why", () => {
    remotesAre(["origin"]);
    openBranchPush();
    advancedSection()!.open = true;
    typeTarget("");
    advancedSection()!.open = false;

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(advancedSection()!.open).toBe(true);
  });

  it("substitutes spaces in the target as in any other ref name box", () => {
    viewState.referenceInputSpaceSubstitution = "Hyphen";
    try {
      remotesAre(["origin"]);
      openBranchPush();
      advancedSection()!.open = true;
      typeTarget("review this");

      submit();
    } finally {
      viewState.referenceInputSpaceSubstitution = "None";
    }

    expect(mock.sentOf("pushBranch")).toMatchObject([{ targetBranch: "review-this" }]);
  });

  it("refuses, naming it, once a remote ticked is gone", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    remoteBox("upstream").checked = true;

    remotesAre(["origin"]);
    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRemoteGone.replace("{0}", "upstream"));
  });

  it("refuses once the repo moved", () => {
    remotesAre(["origin"]);
    openBranchPush();

    receive({ command: "setRepo", repo: OTHER_REPO });
    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRepoMoved);
  });

  it("remembers the force mode alone, and opens folded with fresh defaults next time", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    forceSelect().value = "force";
    advancedSection()!.open = true;
    remoteBox("origin").checked = false;
    remoteBox("upstream").checked = true;
    typeTarget("elsewhere");
    rememberBox().checked = true;

    submit();

    expect(mock.sentOf("saveDialogMemory")).toEqual([
      {
        command: "saveDialogMemory",
        dialogKey: "pushBranchForce",
        values: { [L.dialogPushForce]: "force" }
      }
    ]);

    // The push's own progress dialog is up; the next push replaces it.
    openBranchPush();
    expect(forceSelect().value).toBe("force");
    expect(advancedSection()!.open).toBe(false);
    expect(remoteBox("origin").checked).toBe(true);
    expect(remoteBox("upstream").checked).toBe(false);
    expect(targetInput().value).toBe("feature");
  });

  it("puts the summary in the Tab order, and lets Enter there toggle rather than push", () => {
    remotesAre(["origin"]);
    openBranchPush();
    const summary = advancedSection()!.querySelector("summary")!;

    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      reached = document.activeElement === summary;
    }
    expect(reached, "Tab reaches the summary").toBe(true);

    mock.clearMessages();
    summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(document.getElementById("dialogAction"), "the dialog stays up").not.toBeNull();
  });

  // git takes `<`, `&` and `"` in a remote's name. Shown as a tick's label it
  // must read as itself, not as markup, and what is pushed to is still the name
  // itself, unescaped.
  const ODD = 'x<b>&"y';

  it("shows a remote's name as text in its tick, and pushes to the name itself", () => {
    remotesAre(["origin", ODD]);
    openBranchPush();
    expect(document.querySelector("#dialog label b"), "no markup from the name").toBeNull();
    remoteBox(ODD).checked = true;

    submit();

    expect(mock.sentOf("pushBranch")).toMatchObject([{ remotes: ["origin", ODD] }]);
  });

  it("is not offered by the batch push, which sends what it always sent", () => {
    remotesAre(["origin", "upstream"]);
    receive({
      command: "runRefBatchAction",
      repo: DEFAULT_REPO,
      action: "push",
      targets: ["feature"],
      skipped: [],
      seq: 1
    });
    expect(advancedSection()).toBeNull();

    submit();

    expect(mock.sentOf("pushBranches")).toEqual([
      {
        command: "pushBranches",
        repo: DEFAULT_REPO,
        branchNames: ["feature"],
        remotes: ["origin"],
        forceMode: "normal"
      }
    ]);
    receive({
      command: "pushBranches",
      results: [
        { ref: "feature", status: null, remoteUpdatedSinceCheckout: false, staleInfoRefs: [] }
      ]
    });
  });
});
