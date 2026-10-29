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

/** `buttons` is what is held while the event fires: the pressed button from
 *  the press until the release, nothing from the release on. */
const mouse = (
  type: string,
  target: Element,
  x: number,
  y: number,
  button = 0,
  buttons = type === "mousedown" || type === "mousemove" ? (button === 0 ? 1 : 2) : 0
) =>
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button,
      buttons
    })
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

const running = () => document.getElementById("actionRunning");
/** The graph's answer to the refresh a finished action asks for. */
function reload() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature"],
    head: "main",
    hard: false,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: TIP,
    moreCommitsAvailable: false,
    hard: false
  });
}

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
  // A move's progress dialog has no Dismiss, so one left running is finished.
  if (running() !== null) {
    receive({ command: "moveBranch", status: null });
    reload();
  }
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

describe("a branch that moves while the question is on screen", () => {
  it('is refused at consent, since the dialog\'s "from" no longer holds', () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    // A background refresh: `feature` was moved to TIP from a terminal.
    receive({
      command: "loadCommits",
      token: 0,
      commits: commits.map((c) => ({
        ...c,
        refs:
          c.hash === TIP
            ? [...c.refs, { hash: TIP, name: "feature", type: "head" as const }]
            : c.refs.filter((r) => r.name !== "feature")
      })),
      head: TIP,
      moreCommitsAvailable: false,
      hard: false
    });
    confirm();

    expect(mock.sentOf("moveBranch")).toEqual([]);
    expect(dialogText()).toContain(L.dialogMoveBranchMoved.replace("{0}", "feature"));

    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: TIP,
      moreCommitsAvailable: false,
      hard: false
    });
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

describe("while the move runs", () => {
  it("shows the progress dialog from the confirmation until the move succeeds", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    expect(running()).toBeNull();
    confirm();

    expect(running()!.textContent).toBe(L.movingBranch + " ...");
    receive({ command: "moveBranch", status: null });
    // The refresh's own reload is what closes it, as for every other action.
    reload();
    expect(running()).toBeNull();
    expect(dialogOpen()).toBe(false);
  });

  it("gives way to git's error when the move fails", () => {
    drag(label(".gitRef.head[data-name='main']"), cellOf(MID));
    confirm();
    expect(running()).not.toBeNull();

    receive({ command: "moveBranch", status: "error: Entry 'tip.txt' not uptodate." });
    expect(running()).toBeNull();
    expect(dialogText()).toContain(L.unableToMoveBranch);
    expect(dialogText()).toContain("Entry 'tip.txt' not uptodate.");
    // Dismissing the error refreshes the graph; answer it, so the next test's
    // refresh is not left queued behind it.
    dismiss();
    reload();
  });

  it("offers no way to close it early, since closing it would not stop the move", () => {
    drag(label(".gitRef.head[data-name='feature']"), cellOf(BASE));
    confirm();

    expect(document.getElementById("dialogDismiss")).toBeNull();
    // Nor an empty button row, whose top margin would push the text off centre.
    expect(document.querySelector("#dialog .dialogButtons")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
    expect(running()).not.toBeNull();

    receive({ command: "moveBranch", status: null });
    reload();
    expect(dialogOpen()).toBe(false);
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
    expect(document.body.classList.contains("branchDragging")).toBe(false);
    mouse("mouseup", cellOf(BASE), 100, 140);
    // The release still fires its click, and a cancelled drag is still a drag:
    // the row it lands on must not expand.
    mouse("click", cellOf(BASE), 100, 140);

    expect(dialogOpen()).toBe(false);
    expect(mock.sentOf("commitDetails")).toEqual([]);
  });

  it("a release the webview never saw: the next move without the button held ends the drag", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(BASE), 100, 140);
    // Released outside the webview, then moved back in with nothing held.
    mouse("mousemove", cellOf(BASE), 100, 150, 0, 0);

    expect(document.body.classList.contains("branchDragging")).toBe(false);
    expect(document.querySelector(".branchDropTarget")).toBeNull();
    mouse("mouseup", cellOf(BASE), 100, 150);
    expect(dialogOpen()).toBe(false);
  });
});

const ghost = () => document.querySelector<HTMLElement>(".branchDragGhost");
const at = (elem: HTMLElement) => [parseFloat(elem.style.left), parseFloat(elem.style.top)];

describe("the label follows the pointer", () => {
  // Without it the press looks like it did nothing: the label stays put, and a
  // merged branch's label is already dim, so dimming it says nothing (#208).

  it("as a copy of the label that moves with the pointer, and is gone on release", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(MID), 100, 100 + BRANCH_DRAG_THRESHOLD - 1);
    expect(ghost()).toBeNull();

    mouse("mousemove", cellOf(BASE), 110, 140);
    const g = ghost()!;
    expect(g).not.toBeNull();
    expect(g.textContent).toBe("feature");
    const [x, y] = at(g);
    mouse("mousemove", cellOf(BASE), 130, 175);
    expect(at(g)).toEqual([x + 20, y + 35]);

    mouse("mouseup", cellOf(BASE), 130, 175);
    mouse("click", from, 130, 175);
    expect(ghost()).toBeNull();
  });

  it("without being one of the graph's labels, or a target for the pointer", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(BASE), 100, 140);

    const g = ghost()!;
    expect(document.getElementById("commitTable")!.contains(g)).toBe(false);
    expect(g.getAttribute("aria-hidden")).toBe("true");
    // Not the source's dimming either: the copy is what the eye follows.
    expect(g.classList.contains("branchDragSource")).toBe(false);
    expect(g.classList.contains("dimmedRef")).toBe(false);

    mouse("mouseup", cellOf(BASE), 100, 140);
    mouse("click", from, 100, 140);
  });

  it("and is gone when Escape cancels the drag", () => {
    const from = label(".gitRef.head[data-name='feature']");
    mouse("mousedown", from, 100, 100);
    mouse("mousemove", cellOf(BASE), 100, 140);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(ghost()).toBeNull();
    mouse("mouseup", cellOf(BASE), 100, 140);
    mouse("click", cellOf(BASE), 100, 140);
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
