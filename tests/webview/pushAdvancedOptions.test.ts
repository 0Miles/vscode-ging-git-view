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
  openMenuOn,
  receive,
  setupHtml
} from "./setup";

// The single-branch Push dialog keeps a collapsed "Advanced options" section
// (#303). Collapsed, the dialog is the one it always was and sends what it
// always sent. Expanded, its own two fields decide where the branch goes: one
// remote from a dropdown and a target branch name on it, which need not be the
// branch's own — and the remote ticks above stop counting.

const L = getWebviewLocalizedStrings();
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

/** Expand the advanced section the way a click on its summary does, and let
 *  the `toggle` event it queues land. */
async function expandAdvanced() {
  const details = advancedSection();
  expect(details, "the advanced section").not.toBeNull();
  details!.open = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function collapseAdvanced() {
  advancedSection()!.open = false;
  await new Promise((resolve) => setTimeout(resolve, 0));
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

function remoteSelect() {
  return field<HTMLSelectElement>(L.dialogPushBranchRemote);
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

describe("the Push dialog's advanced options", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
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

  it("sends exactly what it always sent while collapsed, with one remote", () => {
    remotesAre(["origin"]);
    openBranchPush();
    expect(advancedSection()!.open, "collapsed by default").toBe(false);
    chooseForceMode("force");

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

  it("sends exactly what it always sent while collapsed, with the remotes ticked", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    expect(advancedSection()!.open, "collapsed by default").toBe(false);
    remoteBox("upstream").checked = true;

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["origin", "upstream"],
        forceMode: "normal"
      }
    ]);
  });

  it("pushes to the one remote chosen and the target named once expanded", async () => {
    remotesAre(["origin"]);
    openBranchPush();
    await expandAdvanced();
    typeTarget("review/feature");

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["origin"],
        forceMode: "normal",
        targetBranch: "review/feature"
      }
    ]);
  });

  it("offers every remote, the push-default one chosen, and the source's own name as target", async () => {
    remotesAre(["origin", "upstream", "backup"], "upstream");
    openBranchPush();
    await expandAdvanced();

    expect(Array.from(remoteSelect().options).map((o) => o.value)).toEqual([
      "origin",
      "upstream",
      "backup"
    ]);
    expect(remoteSelect().value).toBe("upstream");
    expect(targetInput().value).toBe("feature");
  });

  it("ignores the remote ticks once expanded, pushing to the remote chosen with the force mode chosen", async () => {
    remotesAre(["origin", "upstream", "backup"]);
    openBranchPush();
    remoteBox("upstream").checked = true;
    chooseForceMode("forceWithLease");
    await expandAdvanced();
    expect(remoteBox("origin").disabled, "the ticks stop counting, visibly").toBe(true);
    remoteSelect().value = "backup";

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([
      {
        command: "pushBranch",
        repo: DEFAULT_REPO,
        branchName: "feature",
        remotes: ["backup"],
        forceMode: "forceWithLease",
        targetBranch: "feature"
      }
    ]);
  });

  it("gives the remote ticks back when collapsed again", async () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    await expandAdvanced();
    remoteSelect().value = "upstream";
    await collapseAdvanced();
    expect(remoteBox("origin").disabled).toBe(false);

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

  it.each([
    ["empty", ""],
    ["a name git would refuse", "bad..name"]
  ])("cannot push to a target that is %s", async (_, target) => {
    remotesAre(["origin"]);
    openBranchPush();
    await expandAdvanced();
    typeTarget(target);

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(document.getElementById("dialogAction"), "the dialog stays up").not.toBeNull();
  });

  it("lets a target nobody can see stand in the way of nothing", async () => {
    remotesAre(["origin"]);
    openBranchPush();
    await expandAdvanced();
    typeTarget("");
    await collapseAdvanced();

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

  it("checks a target left invalid the moment the section is opened again", async () => {
    remotesAre(["origin"]);
    openBranchPush();
    await expandAdvanced();
    typeTarget("");
    await collapseAdvanced();
    await expandAdvanced();

    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
  });

  it("substitutes spaces in the target as in any other ref name box", async () => {
    viewState.referenceInputSpaceSubstitution = "Hyphen";
    try {
      remotesAre(["origin"]);
      openBranchPush();
      await expandAdvanced();
      typeTarget("review this");

      submit();
    } finally {
      viewState.referenceInputSpaceSubstitution = "None";
    }

    expect(mock.sentOf("pushBranch")).toMatchObject([{ targetBranch: "review-this" }]);
  });

  it("refuses, naming it, once the remote chosen in the dropdown is gone", async () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    await expandAdvanced();
    remoteSelect().value = "upstream";

    remotesAre(["origin"]);
    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRemoteGone.replace("{0}", "upstream"));
  });

  it("refuses once the repo moved", async () => {
    remotesAre(["origin"]);
    openBranchPush();
    await expandAdvanced();

    receive({ command: "setRepo", repo: OTHER_REPO });
    submit();

    expect(mock.sentOf("pushBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogPushRepoMoved);
  });

  it("remembers the force mode alone, and opens collapsed with fresh defaults next time", async () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    chooseForceMode("force");
    await expandAdvanced();
    remoteSelect().value = "upstream";
    typeTarget("elsewhere");
    (document.getElementById("dialogRememberChoice") as HTMLInputElement).checked = true;

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
    expect(document.querySelector<HTMLSelectElement>("#dialog select")!.value).toBe("force");
    expect(advancedSection()!.open).toBe(false);
    await expandAdvanced();
    expect(remoteSelect().value).toBe("origin");
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
