import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// A reload lands on its own schedule. The file watcher fires on any `.git`
// write, so a commit made in the terminal — or a fetch finishing in another
// window — finishes a background reload at a moment nothing in the webview
// chose. That reload used to close *whatever* dialog was open.
//
// The line it did that from is not gratuitous: an action raises a progress
// dialog ("Checking out …"), the action's own reload is what finishes it, and
// leaving that dialog up strands the user behind an overlay whose only exit is
// Escape (droppedLoadRequests pins that). But the same line also closed
// questions the user was reading, and a confirmation that vanishes before it
// can be answered is not a question at all. `#actionRunning` is the mark that
// separates the two, which is why every progress dialog is now built from one
// place rather than by imitation.
//
// The dismissal hooks are the other half. `showDialog` used to bind `onDismiss`
// into the Dismiss button's click closure and nowhere else, so every close the
// user did not click skipped it — the reload's, and Escape's. A hook that runs
// on one route out of three is a coincidence, not a hook.
//
// What each hook then does is its own business, and the tests below keep them
// apart rather than treating "the hook ran" as the end of the story. The
// refetch's clears `cleanupState`, and clearing it is what stops the answer
// reopening the dialog — so that one is closed end to end. The scan's sends a
// cancel, and Stop is a "come back with what you found" contract, so the answer
// still arrives and still reopens the dialog; there is a test that says so, in
// as many words, because the neighbouring one would otherwise read as covering
// it.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: false });

// The "*" row is the Uncommitted Changes row, and it is where the plain
// confirmation used below (Reset uncommitted changes) is raised from.
const commits: GitCommitNode[] = [
  {
    hash: "*",
    parentHashes: ["aaa111"],
    author: "*",
    email: "",
    date: 1700000100,
    message: "Uncommitted Changes (3)",
    refs: []
  },
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
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: [{ hash: "bbb222", name: "feature", type: "head" }]
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

const MERGED: GG.CleanupCandidateFacts = { merged: true, redundant: false, inactive: false };

const cleanupPayload: GG.BranchCleanupPayload = {
  candidates: [{ ref: "merged", isRemote: false, facts: MERGED }],
  defaultBranch: "main",
  defaultBranchDate: 1_700_000_000,
  remotesHidden: false,
  // Non-zero, or the dialog renders no deep-check button and the scan scenario
  // has nothing to press.
  scannable: 1
};

let mock: ReturnType<typeof createVscodeMock>;
let cleanupSeq = 0;

const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** Activate a context-menu item by its label. `toBeDefined`, not `not.toBeNull`:
 *  `find` yields `undefined` when nothing matches, and a null check would pass
 *  on it — leaving the scenario to fail later, somewhere that reads like the
 *  behaviour under test (issue #131). */
function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function dialogIsOpen() {
  return document.getElementById("dialog")!.classList.contains("active");
}

function progressDialogIsUp() {
  return document.getElementById("actionRunning") !== null;
}

function contextMenuIsOpen() {
  return document.getElementById("contextMenu")!.classList.contains("active");
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
}

function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

/** A whole background reload, start to finish: the watcher's soft refresh, then
 *  both halves of the answer. The branch half carries `hard: true`, which is
 *  what makes the reload report a change — the reload has to actually reach its
 *  finishing line, or every assertion below would hold for the wrong reason. */
function backgroundReloadLands() {
  receive({ command: "refresh" });
  receive(branchesResponse);
  receive(commitsResponse);
  expect(
    document.getElementById("refreshBtn")!.classList.contains("refreshing"),
    "the reload never finished, so nothing was ever asked to close anything"
  ).toBe(false);
}

/** Open the cleanup dialog from the host, on a fresh token each time. */
function openCleanupDialog() {
  receive({
    command: "showBranchCleanup",
    repo: DEFAULT_REPO,
    seq: ++cleanupSeq,
    payload: cleanupPayload
  });
  expect(
    document.querySelector('#dialog .cleanupRow input[data-ref="merged"]'),
    "the cleanup dialog"
  ).not.toBeNull();
}

// One webview for the file. A second `setupHtml` + import would replace the
// body under the first instance while leaving it listening on `window`, so
// every message would then be handled twice — once by an instance whose element
// handles point into a detached document.
beforeAll(async () => {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(viewState);
  await import("@/webview/main");
  receive(branchesResponse);
  receive(commitsResponse);
});

beforeEach(() => {
  // Leave no dialog standing between scenarios: each opens its own, and a
  // leftover would be indistinguishable from the one under test.
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
  mock.clearMessages();
});

describe("a background reload landing under an open dialog", () => {
  it("leaves the question the user is reading standing", () => {
    openMenuOn("tr.unsavedChanges");
    clickItem(L.resetUncommitted + E);
    expect(dialogIsOpen(), "the confirmation never opened").toBe(true);

    backgroundReloadLands();

    expect(dialogIsOpen()).toBe(true);
    // Still the same question, not some other dialog that happens to be up.
    expect(dialogText()).toContain(L.dialogResetUncommittedConfirm);
  });

  it("still lets that question be answered afterwards", () => {
    openMenuOn("tr.unsavedChanges");
    clickItem(L.resetUncommitted + E);
    backgroundReloadLands();
    mock.clearMessages();

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(sentOf("resetUncommittedChanges")).toEqual([
      { command: "resetUncommittedChanges", repo: DEFAULT_REPO }
    ]);
  });

  it("closes the progress dialog its own action put up", () => {
    click("fetchBtn");
    expect(progressDialogIsUp(), "the fetch never raised its progress dialog").toBe(true);

    backgroundReloadLands();

    expect(progressDialogIsUp()).toBe(false);
    expect(dialogIsOpen()).toBe(false);
  });

  it("closes the context menu, whose items were computed against the old graph", () => {
    openMenuOn('.gitRef.head[data-name="feature"]');
    expect(contextMenuIsOpen(), "the menu never opened").toBe(true);

    backgroundReloadLands();

    expect(contextMenuIsOpen()).toBe(false);
  });

  // The hook, on the route the user did not take. Each of these dialogs owns
  // state that an answer still in flight would otherwise put back on screen.
  describe("and the progress dialog it closes had a dismissal hook", () => {
    it("stops the branch cleanup scan it was showing progress for", () => {
      openCleanupDialog();
      click("cleanupDeepCheck");
      expect(progressDialogIsUp(), "the scan never raised its progress dialog").toBe(true);
      expect(sentOf("branchCleanupScan")).toHaveLength(1);
      mock.clearMessages();

      backgroundReloadLands();

      expect(progressDialogIsUp()).toBe(false);
      // Without this the host keeps walking the branch list for a dialog that
      // is no longer on screen.
      expect(sentOf("branchCleanupScanCancel")).toHaveLength(1);
    });

    // And what cancelling does *not* do, stated here rather than left to be
    // discovered. Stop is a "come back with what you found" contract, so a
    // cancelled scan is answered like a finished one, and that answer still
    // carries the open dialog's token — so it fills the dialog back in, on top
    // of whatever the user is now looking at. The hook stops the work; only the
    // refetch's hook, which clears `cleanupState`, stops the reopen, because
    // clearing that state is what it *is*.
    //
    // This is not a regression: before the hook ran at all, the scan simply ran
    // to completion and reopened the dialog the same way. It is the gap the
    // hook does not close, and it is asserted so that the next reader finds it
    // written down instead of inferring from the test above that it is covered.
    it("but the cancelled scan's answer still brings the dialog back", () => {
      openCleanupDialog();
      click("cleanupDeepCheck");
      const scan = sentOf("branchCleanupScan").at(-1);
      expect(scan, "the scan request").toBeDefined();
      const token = (scan as Extract<GG.RequestMessage, { command: "branchCleanupScan" }>).token;

      backgroundReloadLands();
      expect(progressDialogIsUp(), "the scan dialog outlived the reload").toBe(false);
      expect(sentOf("branchCleanupScanCancel")).toHaveLength(1);

      receive({
        command: "branchCleanupScan",
        payload: cleanupPayload,
        cancelled: true,
        token
      });

      expect(dialogIsOpen()).toBe(true);
      expect(
        document.querySelector('#dialog .cleanupRow input[data-ref="merged"]'),
        "the cleanup dialog came back"
      ).not.toBeNull();
    });

    it("keeps the refetch answer from reopening the dialog the user lost", () => {
      openCleanupDialog();
      click("cleanupRefetch");
      expect(progressDialogIsUp(), "the refetch never raised its progress dialog").toBe(true);
      const request = sentOf("branchCleanupOpen").at(-1);
      expect(request, "the refetch request").toBeDefined();
      const token = (request as Extract<GG.RequestMessage, { command: "branchCleanupOpen" }>).token;

      backgroundReloadLands();
      expect(progressDialogIsUp(), "the refetch dialog outlived the reload").toBe(false);

      // The fetch itself cannot be recalled, so the answer still arrives.
      receive({ command: "branchCleanupOpen", payload: cleanupPayload, fetchFailed: false, token });

      expect(dialogIsOpen(), "the cleanup dialog came back on its own").toBe(false);
    });
  });
});

// The third route out, and the one the user takes most often. Escape reached
// `hideDialog` directly, so it skipped the hook exactly like the reload did —
// which is why "only Escape can get you out of this" was never the harmless
// escape hatch it reads as: it got you out and left the work running.
describe("closing a dialog with Escape", () => {
  it("stops the branch cleanup scan, the same as pressing Stop would", () => {
    openCleanupDialog();
    click("cleanupDeepCheck");
    expect(progressDialogIsUp(), "the scan never raised its progress dialog").toBe(true);
    mock.clearMessages();

    pressEscape();

    expect(dialogIsOpen(), "Escape did not close the dialog").toBe(false);
    expect(sentOf("branchCleanupScanCancel")).toHaveLength(1);
  });

  it("abandons the cleanup dialog the refetch was working for", () => {
    openCleanupDialog();
    click("cleanupRefetch");
    const request = sentOf("branchCleanupOpen").at(-1);
    expect(request, "the refetch request").toBeDefined();
    const token = (request as Extract<GG.RequestMessage, { command: "branchCleanupOpen" }>).token;

    pressEscape();
    expect(dialogIsOpen(), "Escape did not close the dialog").toBe(false);

    receive({ command: "branchCleanupOpen", payload: cleanupPayload, fetchFailed: false, token });

    expect(dialogIsOpen(), "the cleanup dialog came back on its own").toBe(false);
  });

  it("leaves a dialog that declared no hook simply closed", () => {
    openMenuOn("tr.unsavedChanges");
    clickItem(L.resetUncommitted + E);
    expect(dialogIsOpen(), "the confirmation never opened").toBe(true);
    mock.clearMessages();

    pressEscape();

    expect(dialogIsOpen()).toBe(false);
    // Escape is not an answer: nothing is sent, and in particular the action
    // the question was about is not taken.
    expect(mock.sentMessages).toEqual([]);
  });

  // The hook belongs to the dialog on screen, not to the webview. A dialog
  // opened over another one takes the stored hook with it — otherwise the
  // cleanup list, which declares none, would inherit the scan's cancel and send
  // it the moment the user closed the list.
  it("does not run the hook of a dialog that has since been replaced", () => {
    openCleanupDialog();
    click("cleanupDeepCheck");
    const scan = sentOf("branchCleanupScan").at(-1);
    const token = (scan as Extract<GG.RequestMessage, { command: "branchCleanupScan" }>).token;
    // The scan comes back and renders the list over its own progress dialog.
    receive({ command: "branchCleanupScan", payload: cleanupPayload, cancelled: false, token });
    expect(
      document.querySelector('#dialog .cleanupRow input[data-ref="merged"]'),
      "the scan's answer did not render the list"
    ).not.toBeNull();
    mock.clearMessages();

    pressEscape();

    expect(dialogIsOpen()).toBe(false);
    expect(sentOf("branchCleanupScanCancel")).toEqual([]);
  });
});

// The mark the split above rests on. It is only ever written in one place now;
// this is what says so, from the outside, for each of the three ways a progress
// dialog is raised. A fourth written out by hand would carry the mark by
// imitation at best, and go on surviving its own reload at worst.
describe("every progress dialog carries the mark that says a reload owns it", () => {
  it("the plain one, raised by an action with nothing to undo", () => {
    click("fetchBtn");
    expect(document.getElementById("actionRunning")).not.toBeNull();
    expect(dialogText()).toContain(L.fetching);
  });

  it("the dismissable one, raised by the cleanup refetch", () => {
    openCleanupDialog();
    click("cleanupRefetch");
    expect(document.getElementById("actionRunning")).not.toBeNull();
    expect(dialogText()).toContain(L.cleanupRefetch);
  });

  it("the cleanup scan's, which relabels Dismiss as Stop and used to be hand-built", () => {
    openCleanupDialog();
    click("cleanupDeepCheck");
    expect(document.getElementById("actionRunning")).not.toBeNull();
    // Its two departures from the other two, both pinned with `toBe` — the
    // scan's own dismiss label, and progress text that ends where the template
    // ends. The template supplies its own ellipsis, so the " ..." the shared
    // builder's other two callers pass in would show up as a second one. Only
    // an exact match says that; `toContain` is satisfied by the string plus
    // anything.
    expect(document.getElementById("dialogDismiss")!.textContent).toBe(L.cleanupScanStop);
    expect(document.getElementById("actionRunning")!.textContent).toBe(
      L.cleanupScanning.replace("{0}", "0").replace("{1}", "?")
    );
  });
});
