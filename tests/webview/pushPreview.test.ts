import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  openMenuOn,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// The single-branch Push dialog says, while it is up, which remote refs the
// push would update (#304): `<branch> → <remote>/<target>`, one per
// destination, folded under "Advanced" with the ticks and target it describes.
// Each test that reads a preview then pushes, asserting the two
// agree — the preview is only worth showing if it is what gets sent.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const viewState = makeViewState();

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

/** The preview's lines as the user reads them, heading first. */
function previewLines(): string[] {
  const preview = document.querySelector("#dialog .dialogFormPreview");
  expect(preview, "the push preview").not.toBeNull();
  return Array.from(preview!.children).map((line) => (line.textContent ?? "").trim());
}

function remoteBox(name: string) {
  const label = Array.from(document.querySelectorAll<HTMLLabelElement>("#dialog label")).find(
    (l) => (l.textContent ?? "").trim() === name
  );
  expect(label, name).toBeDefined();
  return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
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
  return cell!.parentElement!.querySelector<T>("select, input")!;
}

/** Type into the target box: the value, `input`, then the keyup the ref
 *  validation and space substitution listen to. */
function typeTarget(value: string) {
  const input = field<HTMLInputElement>(L.dialogPushBranchTarget);
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new KeyboardEvent("keyup"));
}

function submit() {
  const action = document.getElementById("dialogAction");
  expect(action, "the dialog was dismissed").not.toBeNull();
  mock.clearMessages();
  action!.dispatchEvent(new MouseEvent("click"));
}

describe("the Push dialog's preview of where the push goes", () => {
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
    receive(branchesResponse);
    receive(commitsResponse);
    mock.clearMessages();
  });

  it("names the one remote's same-named branch the moment it opens", () => {
    remotesAre(["origin"]);
    openBranchPush();

    expect(previewLines()).toEqual([L.dialogPushBranchPreview, "feature → origin/feature"]);
    expect(
      advancedSection()!.contains(document.querySelector("#dialog .dialogFormPreview")),
      "folded with what it describes"
    ).toBe(true);

    submit();
    expect(mock.sentOf("pushBranch")).toMatchObject([{ remotes: ["origin"] }]);
    expect(mock.sentOf("pushBranch")[0]).not.toHaveProperty("targetBranch");
  });

  it("lists every ticked remote, dropping one the moment it is unticked", () => {
    remotesAre(["origin", "upstream", "backup"]);
    openBranchPush();
    remoteBox("backup").click();

    expect(previewLines()).toEqual([
      L.dialogPushBranchPreview,
      "feature → origin/feature",
      "feature → backup/feature"
    ]);

    remoteBox("origin").click();

    expect(previewLines()).toEqual([L.dialogPushBranchPreview, "feature → backup/feature"]);
    submit();
    expect(mock.sentOf("pushBranch")).toMatchObject([{ remotes: ["backup"] }]);
  });

  it("says plainly that nothing will be pushed once no remote is ticked", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    remoteBox("origin").click();

    expect(previewLines()).toEqual([L.dialogPushBranchPreview, L.dialogPushBranchPreviewNone]);
    submit();
    expect(mock.sentOf("pushBranch")).toEqual([]);
  });

  it("follows the target typed, on every remote ticked", () => {
    remotesAre(["origin", "upstream", "backup"]);
    openBranchPush();
    remoteBox("upstream").click();

    typeTarget("review/feature");
    expect(previewLines()).toEqual([
      L.dialogPushBranchPreview,
      "feature → origin/review/feature",
      "feature → upstream/review/feature"
    ]);

    submit();
    expect(mock.sentOf("pushBranch")).toMatchObject([
      { remotes: ["origin", "upstream"], targetBranch: "review/feature" }
    ]);
  });

  it("describes the same push whether the section is folded or not", () => {
    remotesAre(["origin", "upstream"]);
    openBranchPush();
    advancedSection()!.open = true;
    remoteBox("origin").click();
    remoteBox("upstream").click();
    typeTarget("elsewhere");
    advancedSection()!.open = false;

    expect(previewLines()).toEqual([L.dialogPushBranchPreview, "feature → upstream/elsewhere"]);
    submit();
    expect(mock.sentOf("pushBranch")).toMatchObject([
      { remotes: ["upstream"], targetBranch: "elsewhere" }
    ]);
  });

  it("names the target as it will be sent, spaces substituted", () => {
    viewState.referenceInputSpaceSubstitution = "Hyphen";
    try {
      remotesAre(["origin"]);
      openBranchPush();
      typeTarget("review this");

      expect(previewLines()).toEqual([L.dialogPushBranchPreview, "feature → origin/review-this"]);
      submit();
    } finally {
      viewState.referenceInputSpaceSubstitution = "None";
    }
    expect(mock.sentOf("pushBranch")).toMatchObject([
      { remotes: ["origin"], targetBranch: "review-this" }
    ]);
  });

  // git takes `<`, `&` and `"` in a remote's name and `<` and `&` in a
  // branch's; the target box takes `&`. Each must read as itself, not as markup.
  it("shows branch, remote and target names as text, and pushes to the names themselves", () => {
    const branch = "fix<i>&co";
    const odd = 'x<b>&"y';
    receive({ ...branchesResponse, branches: ["feature", branch] });
    receive({
      ...commitsResponse,
      commits: [
        {
          ...commits[0],
          refs: [...commits[0].refs, { hash: "aaa111", name: branch, type: "head" }]
        }
      ]
    });
    remotesAre(["origin", odd]);
    // By its data rather than a selector: jsdom's selector engine trips on the name.
    const ref = Array.from(document.querySelectorAll<HTMLElement>(".gitRef.head")).find(
      (elem) => elem.dataset.name === branch
    );
    expect(ref, branch).toBeDefined();
    rightClick(ref!);
    clickItem(L.pushBranch + E);
    remoteBox(odd).click();

    expect(
      document.querySelector("#dialog .dialogFormPreview b, #dialog .dialogFormPreview i"),
      "no markup from a name"
    ).toBeNull();
    expect(previewLines()).toEqual([
      L.dialogPushBranchPreview,
      `${branch} → origin/${branch}`,
      `${branch} → ${odd}/${branch}`
    ]);

    remoteBox("origin").click();
    typeTarget("a&b");

    expect(previewLines()).toEqual([L.dialogPushBranchPreview, `${branch} → ${odd}/a&b`]);
    submit();
    expect(mock.sentOf("pushBranch")).toMatchObject([
      { branchName: branch, remotes: [odd], targetBranch: "a&b" }
    ]);
  });

  // The preview describes one branch going to named refs. A batch pushes each
  // branch to its own name, so it has none — nor does any other form.
  it("is not shown by the batch push, which sends what it always sent", () => {
    remotesAre(["origin", "upstream"]);
    receive({
      command: "runRefBatchAction",
      repo: DEFAULT_REPO,
      action: "push",
      targets: ["feature"],
      skipped: [],
      seq: 1
    });
    expect(document.getElementById("dialogAction"), "the batch push form").not.toBeNull();
    expect(document.querySelector("#dialog .dialogFormPreview")).toBeNull();

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

  it("is not shown by a form that does not ask for one", () => {
    openMenuOn('tr.commit[data-hash="aaa111"]');
    clickItem(L.createBranch + E);

    expect(document.getElementById("dialogAction"), "the Create Branch form").not.toBeNull();
    expect(document.querySelector("#dialog .dialogFormPreview")).toBeNull();
  });
});
