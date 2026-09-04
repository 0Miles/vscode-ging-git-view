import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// `attachCdvFileListeners` binds the Commit Details View's file actions, and it
// used to bind them through `addListenerToClass`, which is
// `document.getElementsByClassName` and so has no scope at all. The
// branch-redundancy dialog builds its commit's files from the very same
// generator, so its rows carry the same class names; every call of
// `attachCdvFileListeners` therefore reached into the modal and wired the
// panel's handlers onto rows belonging to another commit entirely (issue #128).
//
// What that cost is not a stray listener. The handlers read the *path* off the
// row that was clicked and the *commit* off the graph's expanded one, so a click
// in the dialog opened a diff of a file the user was looking at, at a revision
// they were not — and nothing on screen said so. Each further redraw bound
// another copy to the same rows, so one click sent two messages, then three.
//
// The fix is a scope, not a guard: the panel's handlers are bound within
// `#commitDetails`, the same boundary `cdvFileRows` already draws for the focus
// path (#113). So the invariant this suite is really about is stated whole in
// "a dialog file row and each of the four action buttons on it" — they do
// *nothing* — and the scenarios around it are the measured defects that
// invariant retires, plus the panel's own rows, which say the boundary landed
// between the two lists rather than around nothing. The last of those is the
// one place the binding scope and the focus scope must *differ*, and it is
// there because the difference was documented and unguarded until it wasn't.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds; re-importing the module per scenario would
// leave the previous instance still listening on `window` (#80).

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

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
  token: 0,
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

/** `hard`, so the reload never takes `loadCommits`'s unchanged short-circuit:
 *  each one is a real redraw, which is the only thing that rebinds. */
const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

/** The commit the graph has expanded — the one whose hash the panel's handlers
 *  carry, and so the one a message sent from the dialog would be wrong about. */
const tipDetails: GitCommitDetails = {
  hash: "aaa111",
  parents: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Tip commit",
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 },
    { oldFilePath: "src/b.ts", newFilePath: "src/b.ts", type: "M", additions: 2, deletions: 1 },
    { oldFilePath: "README.md", newFilePath: "README.md", type: "M", additions: 3, deletions: 0 }
  ]
};

/** A commit only the dialog is showing, and not one the graph has loaded at all.
 *  `dialog/only.ts` is in neither the panel's list nor its folders, so a message
 *  naming it can only have come from a dialog row; `src/dialog-only.ts` puts a
 *  `src` folder in both lists, which is the overlap the folder handler needed to
 *  write one view's collapse into the other's tree. */
const dialogDetails: GitCommitDetails = {
  hash: "ddd444",
  parents: [],
  author: "Dana",
  email: "dana@example.com",
  committer: "Dana",
  committerEmail: "dana@example.com",
  authorDate: 1698500000,
  commitDate: 1698500000,
  body: "Dialog commit",
  fileChanges: [
    {
      oldFilePath: "dialog/only.ts",
      newFilePath: "dialog/only.ts",
      type: "M",
      additions: 7,
      deletions: 0
    },
    {
      oldFilePath: "src/dialog-only.ts",
      newFilePath: "src/dialog-only.ts",
      type: "M",
      additions: 8,
      deletions: 0
    }
  ]
};

const redundancyResult: BranchRedundancy = {
  kind: "unmerged",
  defaultBranch: "main",
  defaultBranchDate: 1700000000,
  commits: [
    {
      hash: "ddd444",
      subject: "Dialog commit",
      author: "Dana",
      email: "dana@example.com",
      date: 1698500000,
      covered: false
    }
  ],
  truncated: false
};

let mock: ReturnType<typeof createVscodeMock>;

function click(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function rightClick(elem: Element) {
  elem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** The keyboard's way of raising a context menu, mirroring `main.ts`'s private
 *  `MENU_KEY_EVENT`. Dispatched directly rather than via Shift+F10, because the
 *  document keydown handler that would normally synthesise it returns early
 *  while a dialog stands — so today no key reaches a dialog row at all (#141,
 *  #145). What is asserted here is the *binding*, which is what
 *  `addCdvContextMenuListener` wires and what would outlive either of those
 *  tickets landing. */
const MENU_KEY_EVENT = "ging.contextMenuKey";

function row(hash: string) {
  const elem = document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

/** A file row inside `root`, addressed by the path it carries. Both lists hold
 *  rows for `src/…`, so the selector has to say which list as well as which
 *  path — that is the whole subject of this suite. */
function fileRow(root: string, path: string) {
  const elem = document.querySelector<HTMLElement>(
    `${root} .gitFile[data-newfilepath="${encodeURIComponent(path)}"]`
  );
  expect(elem, `${root} ${path}`).not.toBeNull();
  return elem!;
}

function folderRow(root: string, folderPath: string) {
  const elem = document.querySelector<HTMLElement>(
    `${root} .gitFolder[data-folderpath="${encodeURIComponent(folderPath)}"]`
  );
  expect(elem, `${root} ${folderPath}`).not.toBeNull();
  return elem!;
}

/** Whether the panel's saved file tree still has `name` open. Read out of
 *  `vscode.setState` rather than off the screen, because that is where the
 *  pollution landed: the folder handler wrote into `expandedCommit.fileTree`
 *  and persisted it, while the panel's own markup was never touched. */
function savedPanelFolderOpen(name: string): boolean | undefined {
  const tree = mock.getState()?.expandedCommit?.fileTree;
  const folder = tree?.children.find((child) => child.name === name);
  return folder !== undefined && folder.type === "folder" ? folder.open : undefined;
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  rightClick(elem!);
}

/** Activate a context-menu item by its label. `toBeDefined`, not
 *  `not.toBeNull`: `find` yields `undefined` when nothing matches (#131). */
function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  click(item!);
}

function contextMenuEntries() {
  return Array.from(document.getElementById("contextMenu")!.children).map((li) =>
    (li.textContent ?? "").trim()
  );
}

/** A soft refresh landing behind the standing dialog — the file watcher's, or
 *  any of the other redraws that leave the panel open. Each one runs
 *  `attachCdvFileListeners` again, which is the only thing that binds. */
function redrawPanel() {
  receive(commitsResponse);
  expect(document.getElementById("commitDetails"), "the panel survived the redraw").not.toBeNull();
}

describe("the Commit Details View's file actions, with a dialog showing its own copy", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);

    // The graph's Commit Details View, expanded on the tip commit.
    click(row("aaa111"));
    receive({ command: "commitDetails", commitDetails: tipDetails });

    // The branch-redundancy dialog, driven the way a user reaches it, down to
    // the row they expand — the dialog's file list is built by the answer to
    // that expansion, not by the dialog opening.
    openMenuOn('#commitTable .gitRef.head[data-name="feature"]');
    clickItem(L.checkRedundancy);
    const requested = mock.sentMessages.filter((m) => m.command === "branchRedundancy");
    expect(requested).toHaveLength(1);
    receive({
      command: "branchRedundancy",
      branch: "feature",
      result: redundancyResult,
      token: (requested[0] as Extract<GG.RequestMessage, { command: "branchRedundancy" }>).token
    });
    click(document.querySelector('#dialog .commitList tr.commit[data-hash="ddd444"]')!);
    receive({
      command: "redundancyCommitDetails",
      commitHash: "ddd444",
      commitDetails: dialogDetails
    });
  });

  it("has both lists standing, each with its own commit's files", () => {
    // Without this the scenarios below could pass on a dialog that never
    // rendered a file row at all.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile")).map((f) =>
        decodeURIComponent(f.dataset.newfilepath!)
      )
    ).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#dialog .gitFile")).map((f) =>
        decodeURIComponent(f.dataset.newfilepath!)
      )
    ).toEqual(["dialog/only.ts", "src/dialog-only.ts"]);
  });

  describe("a file row of the dialog's, clicked after the panel has been redrawn", () => {
    let sent: GG.RequestMessage[] = [];

    beforeAll(() => {
      redrawPanel();
      mock.clearMessages();
      click(fileRow("#dialog", "dialog/only.ts"));
      sent = [...mock.sentMessages];
    });

    it("sends nothing at all", () => {
      // What it used to send was a `viewDiff` carrying this row's path and the
      // graph's expanded commit — a diff of the right file at the wrong
      // revision, with nothing on screen to say which commit it came from.
      expect(sent).toEqual([]);
    });
  });

  describe("a file row of the dialog's, asked for a menu by either route", () => {
    let byPointer: string[] = [];
    let byMenuKey: string[] = [];
    let sentOnMenuAction: GG.RequestMessage[] = [];

    beforeAll(() => {
      mock.clearMessages();
      rightClick(fileRow("#dialog", "dialog/only.ts"));
      byPointer = contextMenuEntries();
      fileRow("#dialog", "dialog/only.ts").dispatchEvent(
        new Event(MENU_KEY_EVENT, { bubbles: true })
      );
      byMenuKey = contextMenuEntries();
      sentOnMenuAction = [...mock.sentMessages];
    });

    it("opens no menu, by pointer or by menu key", () => {
      // The pointer's is the easier of the two to trip over and the harder to
      // catch: the menu that used to open here is the panel's own file menu,
      // complete and plausible, and every action on it mixed this row's path
      // with the graph's commit. The menu key's is bound alongside it, so a
      // scope applied to one and not the other would leave half the door open.
      expect(byPointer).toEqual([]);
      expect(byMenuKey).toEqual([]);
      expect(document.getElementById("contextMenu")!.classList.contains("active")).toBe(false);
      expect(sentOnMenuAction).toEqual([]);
    });
  });

  describe("a folder row of the dialog's, clicked while the panel is open", () => {
    let dialogFolderCollapsed = false;
    let panelFolderOpenInSavedTree: boolean | undefined;

    beforeAll(() => {
      mock.clearMessages();
      click(folderRow("#dialog", "src"));
      dialogFolderCollapsed = folderRow("#dialog", "src").parentElement!.classList.contains(
        "closed"
      );
      panelFolderOpenInSavedTree = savedPanelFolderOpen("src");
    });

    it("leaves the panel's own file tree untouched, and sends nothing", () => {
      // Both lists have a `src` — real commits usually do — and the handler
      // resolved the clicked folder's path against `expandedCommit.fileTree`,
      // so collapsing the dialog's collapsed the *panel's* in the saved state.
      // Nothing on screen changed, which is what made it silent.
      expect(panelFolderOpenInSavedTree).toBe(true);
      expect(mock.sentMessages).toEqual([]);
    });

    it("does not fold the dialog's own folder either", () => {
      // The dialog's rows are not the panel's to drive, and folding them was
      // never the point of the handler that reached them — it was the half of
      // its work that happened to be visible.
      expect(dialogFolderCollapsed).toBe(false);
    });
  });

  // The invariant the scope establishes, stated once over every control the
  // panel binds a handler to rather than once per defect: the dialog's file list
  // is inert. The row's other spans — icon, rename marker, the addition and
  // deletion counts — carry no handler on either list and are not what this is
  // about. Of the five that do, four sent a message the moment a redraw had run,
  // which is what the panel's comment claimed all along could not happen.
  describe("a dialog file row and each of the four action buttons on it", () => {
    const sentBy: Record<string, GG.RequestMessage[]> = {};

    beforeAll(() => {
      const target = fileRow("#dialog", "dialog/only.ts");
      for (const control of [
        "the row",
        "gitFileDiffWorking",
        "gitFileViewRev",
        "gitFileOpen",
        "gitFileCopyPath"
      ]) {
        mock.clearMessages();
        click(control === "the row" ? target : target.querySelector(`.${control}`)!);
        sentBy[control] = [...mock.sentMessages];
      }
    });

    it("does nothing, whichever is clicked", () => {
      expect(sentBy).toEqual({
        "the row": [],
        gitFileDiffWorking: [],
        gitFileViewRev: [],
        gitFileOpen: [],
        gitFileCopyPath: []
      });
    });
  });

  describe("the same row, after three more redraws", () => {
    let sent: GG.RequestMessage[] = [];

    beforeAll(() => {
      redrawPanel();
      redrawPanel();
      redrawPanel();
      mock.clearMessages();
      click(fileRow("#dialog", "dialog/only.ts"));
      sent = [...mock.sentMessages];
    });

    it("still does nothing, rather than one thing per redraw", () => {
      // The dialog's rows are never replaced, so each redraw used to leave
      // another copy of the handler on them: one click sent two messages, then
      // three, then four. Nothing is not a small number here — it is the only
      // count that does not depend on how long the dialog has been open.
      expect(sent).toEqual([]);
    });
  });

  // The other half of a scope, and the half a scope drawn too tightly would
  // fail: everything above holds just as well for a panel whose rows were never
  // bound at all. These say the boundary lands between the two lists rather
  // than around nothing.
  describe("the panel's own rows, with the dialog still standing", () => {
    let sentOnFileClick: GG.RequestMessage[] = [];
    let entriesOnRightClick: string[] = [];
    let collapsedOnFolderClick = false;
    let savedAfterCollapse: boolean | undefined;
    let savedAfterReopen: boolean | undefined;

    beforeAll(() => {
      mock.clearMessages();
      click(fileRow("#commitDetails", "src/a.ts"));
      sentOnFileClick = [...mock.sentMessages];

      rightClick(fileRow("#commitDetails", "src/a.ts"));
      entriesOnRightClick = contextMenuEntries();

      click(folderRow("#commitDetails", "src"));
      collapsedOnFolderClick = folderRow("#commitDetails", "src").parentElement!.classList.contains(
        "closed"
      );
      savedAfterCollapse = savedPanelFolderOpen("src");
      // Put it back, so the scenario after this one starts from the tree the
      // suite has described all along rather than one this test folded.
      click(folderRow("#commitDetails", "src"));
      savedAfterReopen = savedPanelFolderOpen("src");
    });

    it("still opens the diff, once, for the commit the panel is showing", () => {
      expect(sentOnFileClick).toEqual([
        {
          command: "viewDiff",
          repo: DEFAULT_REPO,
          commitHash: "aaa111",
          fromHash: undefined,
          oldFilePath: "src/a.ts",
          newFilePath: "src/a.ts",
          type: "M"
        }
      ]);
    });

    it("still raises the file context menu", () => {
      expect(entriesOnRightClick).toEqual([
        L.viewDiff,
        L.viewFileAtRevision,
        L.viewDiffWithWorking,
        L.openFile,
        L.resetFileToRevision + "…",
        L.copyFilePath
      ]);
    });

    it("still folds a folder, and remembers that it is folded", () => {
      expect(collapsedOnFolderClick).toBe(true);
      expect(savedAfterCollapse).toBe(false);
      expect(savedAfterReopen).toBe(true);
    });
  });

  // Where the binding scope and the *focus* scope have to differ, and the only
  // scenario that can tell them apart. `cdvFileRows` drops rows inside a
  // collapsed folder, because focus must not step onto something `display:
  // none` — but binding runs once per render and opening a folder re-shows its
  // rows without re-rendering anything, so a bind that skipped them would leave
  // every file under a folder the user opens permanently dead. Unifying the two
  // scopes is the obvious tidy-up, and this is what stands between the next
  // reader and doing it: without this scenario that mutation passes 602 tests.
  describe("a row bound while its folder was collapsed, clicked after it opens", () => {
    let hiddenAtBindTime = false;
    let sent: GG.RequestMessage[] = [];

    beforeAll(() => {
      // Fold `src`, then redraw: the panel comes back with the fold persisted,
      // so `attachCdvFileListeners` runs while `src/a.ts` is inside `.hidden`.
      click(folderRow("#commitDetails", "src"));
      redrawPanel();
      hiddenAtBindTime = fileRow("#commitDetails", "src/a.ts").closest(".hidden") !== null;

      // Now the user opens it. Nothing re-binds — the handler this row will use
      // is the one it was given while it was out of sight.
      click(folderRow("#commitDetails", "src"));
      mock.clearMessages();
      click(fileRow("#commitDetails", "src/a.ts"));
      sent = [...mock.sentMessages];
    });

    it("was bound out of sight, which is the whole point of the scenario", () => {
      // Without this the folder could quietly stop being collapsed at bind time
      // and the assertion below would hold for the ordinary reason.
      expect(hiddenAtBindTime).toBe(true);
      expect(fileRow("#commitDetails", "src/a.ts").closest(".hidden")).toBeNull();
    });

    it("still opens the diff", () => {
      expect(sent).toEqual([
        {
          command: "viewDiff",
          repo: DEFAULT_REPO,
          commitHash: "aaa111",
          fromHash: undefined,
          oldFilePath: "src/a.ts",
          newFilePath: "src/a.ts",
          type: "M"
        }
      ]);
    });
  });

  describe("the dialog's rows once the Commit Details View has closed", () => {
    let sent: GG.RequestMessage[] = [];
    let dialogFolderCollapsed = false;

    beforeAll(() => {
      click(document.getElementById("commitDetailsClose")!);
      expect(document.getElementById("commitDetails")).toBeNull();
      mock.clearMessages();

      click(folderRow("#dialog", "src"));
      dialogFolderCollapsed = folderRow("#dialog", "src").parentElement!.classList.contains(
        "closed"
      );
      const target = fileRow("#dialog", "dialog/only.ts");
      click(target);
      click(target.querySelector(".gitFileOpen")!);
      sent = [...mock.sentMessages];
    });

    it("reports no failure, because none happens", () => {
      // The folder handler had no `expandedCommit === null` guard where the file
      // handler did, so this click used to throw `Cannot read properties of null
      // (reading 'fileTree')`, be caught by the global reporter (ADR-0016) and
      // arrive at the host once per redraw the dialog had lived through. The
      // guard is not what removes it: with nothing bound there is nothing to
      // throw.
      expect(sent.filter((m) => m.command === "reportError")).toEqual([]);
    });

    it("sends nothing, with no panel left to send it about", () => {
      // `cdvHash` answers "" for a closed panel, so the open-file button did not
      // throw — it asked the host to open a path at a revision that does not
      // exist. The quietest member of the family and the same defect.
      expect(sent).toEqual([]);
      expect(dialogFolderCollapsed).toBe(false);
    });
  });
});
