import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import { BRANCH_DRAG_THRESHOLD } from "@/webview/branchDrag";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// Dragging a local branch's label onto another commit row moves the branch
// there (#208), behind a confirmation that names the branch and both commits.

const L = getWebviewLocalizedStrings();

const TIP = "11111111aaaa";
const MID = "22222222bbbb";
const BASE = "33333333cccc";

const commits: GitCommitNode[] = [
  {
    hash: TIP,
    parentHashes: [MID],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "tip",
    refs: [
      { hash: TIP, name: "main", type: "head" },
      { hash: TIP, name: "origin/main", type: "remote" },
      { hash: TIP, name: "v1", type: "tag" }
    ]
  },
  {
    hash: MID,
    parentHashes: [BASE],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "mid",
    refs: [{ hash: MID, name: "feature", type: "head" }]
  },
  {
    hash: BASE,
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "base",
    refs: []
  }
];

const row = (hash: string) =>
  document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
/** The label's name span — what a pointer actually lands on. */
const label = (selector: string) =>
  document.querySelector<HTMLElement>(`#commitTable ${selector} .gitRefName`) ??
  document.querySelector<HTMLElement>(`#commitTable ${selector}`)!;
/** A cell of the row, which is where a drop lands. */
const cellOf = (hash: string) => row(hash).querySelectorAll("td")[1] as HTMLElement;

const mouse = (type: string, target: Element, x: number, y: number, button = 0) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
  );

/** Press on `from`, travel `distance` px, then release on `to` — followed, for
 *  the primary button, by the click a browser fires after a release. Where
 *  that click lands is `clickOn`; it defaults to the label, whose own handler
 *  keeps it from the row, so only the suite that is about it aims it at a row. */
function drag(
  from: Element,
  to: Element,
  {
    distance = 40,
    button = 0,
    clickOn = from
  }: { distance?: number; button?: number; clickOn?: Element } = {}
) {
  mouse("mousedown", from, 100, 100, button);
  mouse("mousemove", to, 100, 100 + distance, button);
  mouse("mouseup", to, 100, 100 + distance, button);
  if (button === 0) mouse("click", clickOn, 100, 100 + distance, button);
}

const dialogOpen = () => document.getElementById("dialog")!.className === "active";
const dialogText = () => document.getElementById("dialog")!.textContent ?? "";
const confirm = () =>
  document
    .getElementById("dialogAction")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
const dismiss = () =>
  document
    .getElementById("dialogDismiss")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));

let mock: ReturnType<typeof createVscodeMock>;

beforeAll(async () => {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(makeViewState({ combineLocalAndRemoteBranchLabels: false }));
  await import("@/webview/main");
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: TIP,
    moreCommitsAvailable: false,
    hard: true
  });
});

beforeEach(() => {
  if (dialogOpen()) dismiss();
  mock.clearMessages();
});

describe("dragging a branch that is not checked out", () => {
  it("asks first, naming the branch and both commits, and sends nothing until confirmed", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));

    expect(dialogOpen()).toBe(true);
    const expected = L.dialogMoveBranchConfirm
      .replace("{0}", "feature")
      .replace("{1}", MID.substring(0, 8))
      .replace("{2}", BASE.substring(0, 8));
    expect(dialogText()).toContain(expected);
    // The checked-out note belongs to the other case only.
    expect(dialogText()).not.toContain(L.dialogMoveBranchCheckedOut);
    expect(mock.sentOf("moveBranch")).toEqual([]);
  });

  it("moves the branch once confirmed", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    confirm();

    expect(mock.sentOf("moveBranch")).toEqual([
      { command: "moveBranch", repo: DEFAULT_REPO, branchName: "feature", commitHash: BASE }
    ]);
  });

  it("moves nothing when the dialog is dismissed", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    dismiss();

    expect(mock.sentOf("moveBranch")).toEqual([]);
  });
});

describe("dragging the checked-out branch", () => {
  it("says it moves with reset --keep, and sends the same request", () => {
    drag(label(".gitRef.head[data-name='main']"), cellOf(MID));

    expect(dialogText()).toContain(L.dialogMoveBranchCheckedOut);
    confirm();
    expect(mock.sentOf("moveBranch")).toEqual([
      { command: "moveBranch", repo: DEFAULT_REPO, branchName: "main", commitHash: MID }
    ]);
  });
});

describe("what does not move a branch", () => {
  it("a press that travels less than the threshold, so a click stays a click", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE), {
      distance: BRANCH_DRAG_THRESHOLD - 1
    });

    expect(dialogOpen()).toBe(false);
  });

  it("a drop onto the commit the branch already points at", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(MID));

    expect(dialogOpen()).toBe(false);
  });

  it("a drop outside any commit row", () => {
    drag(label(".gitRef.head[data-name='feature']"), document.body);

    expect(dialogOpen()).toBe(false);
  });

  it("a remote branch or a tag label — the issue leaves both out", () => {
    drag(label(".gitRef.remote[data-name='origin/main']"), cellOf(BASE));
    expect(dialogOpen()).toBe(false);

    drag(label(".gitRef.tag[data-name='v1']"), cellOf(BASE));
    expect(dialogOpen()).toBe(false);
  });

  it("a drag with the right button, which is how the label's menu opens", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE), { button: 2 });

    expect(dialogOpen()).toBe(false);
  });

  it("a drag cancelled with Escape before it is released", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(BASE), 100, 140);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    mouse("mouseup", cellOf(BASE), 100, 140);

    expect(dialogOpen()).toBe(false);
  });
});

describe("while and after a drag", () => {
  it("marks the row under the pointer as the drop target, and clears it on release", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(BASE), 100, 140);

    expect(row(BASE).classList.contains("branchDropTarget")).toBe(true);
    expect(document.body.classList.contains("branchDragging")).toBe(true);

    mouse("mouseup", document.body, 100, 140);
    mouse("click", document.body, 100, 140);

    expect(document.querySelector(".branchDropTarget")).toBeNull();
    expect(document.body.classList.contains("branchDragging")).toBe(false);
  });

  it("does not let the release click through to the row it landed on", () => {
    // Had the click after the release reached the row, the row would have
    // expanded and asked the host for that commit's details.
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE), { clickOn: cellOf(BASE) });

    expect(mock.sentOf("commitDetails")).toEqual([]);
  });

  it("leaves a later, ordinary click on a row alone", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    dismiss();
    cellOf(BASE).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(mock.sentOf("commitDetails")).toHaveLength(1);
  });
});
