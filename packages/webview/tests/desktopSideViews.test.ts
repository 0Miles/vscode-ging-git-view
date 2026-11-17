import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildGroupedBranchRoots } from "@ging/shared/backend/utils/branchTree";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@ging/shared/backend/utils/contextMenuVisibility";
import type {
  SideViewStash,
  SideViewStateMessage,
  SideViewStrings
} from "@ging/webview/desktop/sideViews/protocol";

import {
  clickElem,
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  hideMenu,
  makeViewState,
  menuItemLabels,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// The desktop host's Branches and Remotes side views (#399), in the Tab's own
// page beside its graph. The host's half is played here by posting its state
// to the page, as the preload does; what the page asks for is read off the
// wire. A branch action must reach the graph directly — the graph's own
// request appears, never a delegated one through the host (ADR-0033).

const viewState = makeViewState();

const STRINGS = Object.fromEntries(
  [
    "branches",
    "remotes",
    "groupRemote",
    "groupLocal",
    "noBranches",
    "noRemotes",
    "more",
    "showAll",
    "refresh",
    "showRemoteBranches",
    "showInactive",
    "showMerged",
    "collapseAll",
    "cleanup",
    "deleteSelected",
    "pushSelected",
    "fastForwardSelected",
    "copyNameSelected",
    "addRemote",
    "managePullRequestProviders",
    "fetchRemote",
    "editUrl",
    "renameRemote",
    "removeRemote",
    "copyUrl",
    "stashes",
    "noStashes"
  ].map((key) => [key, `<${key}>`])
) as SideViewStrings;

/** Two stashes, as the host lists them. */
const STASHES: SideViewStash[] = [
  { id: "aaa111", selector: "stash@{0}", message: "On main: newer", tooltip: "newer" },
  { id: "bbb222", selector: "stash@{1}", message: "On main: older", tooltip: "older" }
];

const BRANCHES = ["main", "feature/login", "topic", "remotes/origin/main"];

/** A state as the host sends it. `filterSeq` defaults to a host that has
 *  taken every ask the page has made. */
function state(
  filter: string[] = [],
  remotes = true,
  filterSeq = Number.MAX_SAFE_INTEGER,
  more: Partial<SideViewStateMessage> = {}
): SideViewStateMessage {
  const roots = buildGroupedBranchRoots(BRANCHES, "main");
  return {
    command: "sideViewState",
    repo: DEFAULT_REPO,
    filterSeq,
    branches: {
      roots,
      rows: Object.fromEntries(
        BRANCHES.map((ref) => [ref, { description: ref === "main" ? "current" : "", tooltip: ref }])
      ),
      filter,
      toggles: { showRemoteBranches: true, showInactiveBranches: false, showMergedBranches: true }
    },
    remotes: remotes
      ? [
          {
            name: "origin",
            fetchUrl: "https://example.com/a.git",
            pushUrl: "https://example.com/a.git"
          }
        ]
      : [],
    stashes: STASHES,
    cmv: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
    strings: STRINGS,
    ...more
  };
}

const hostSays = (message: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { data: message }));

/** Open the folder keyed `key`, unless it is open. */
function openFolder(key: string) {
  const folder = document.querySelector<HTMLElement>(`#branchesView [data-key="${key}"]`);
  expect(folder, key).not.toBeNull();
  if (folder!.getAttribute("aria-expanded") === "false") clickElem(folder!);
}

/** The row of `ref`, its folder opened first: a remote branch sits in its
 *  remote's folder, which starts closed. */
const row = (ref: string) => {
  if (ref.startsWith("remotes/origin/")) openFolder("remote:folder:origin");
  const elem = document.querySelector<HTMLElement>(`#branchesView [data-ref="${ref}"]`);
  expect(elem, ref).not.toBeNull();
  return elem!;
};

describe("the desktop side views", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  let FILTER_WRITE_DELAY_MS: number;
  /** What the page posted at start, before any test cleared the log. */
  let atStart: string[];
  /** What the page posted that is the side views', not the graph's. */
  const sideViewPosts = () =>
    mock.sentMessages
      .map((m) => m as unknown as { command: string })
      .filter((m) => m.command.startsWith("sideView"));

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    document.documentElement.dataset.gingPage = "graph";
    await import("@ging/webview/desktop/main");
    atStart = mock.sentMessages.map((m) => m.command as string);
    receive({
      command: "loadBranches",
      token: 0,
      branches: BRANCHES,
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    // Read once the page has an API to post through: the module asks for it
    // at import.
    ({ FILTER_WRITE_DELAY_MS } = await import("@ging/webview/desktop/sideViews/sideViews"));
  });

  beforeEach(() => {
    hideMenu();
    hostSays(state());
    mock.clearMessages();
  });

  it("tells the host it listens, and takes the left column of the page", () => {
    expect(atStart).toContain("sideViewReady");
    expect(document.getElementById("sideViews")).not.toBeNull();
    expect(document.body.classList.contains("gingSideViews")).toBe(true);
    expect(document.body.firstElementChild?.id).toBe("sideViews");
  });

  it("draws the tree as VS Code's does: the groups open, the folders closed", () => {
    const labels = Array.from(document.querySelectorAll("#branchesView .sideViewRow")).map(
      (r) => r.querySelector(".sideViewLabel")?.textContent
    );
    // Remote first, then local; the remote's folder and `feature` closed.
    expect(labels).toEqual(["<groupRemote>", "origin", "<groupLocal>", "main", "topic", "feature"]);
    expect(row("main").querySelector(".sideViewDescription")?.textContent).toBe("current");
  });

  it("opens a folder on a click, without touching the filter", async () => {
    openFolder("local:folder:feature");
    expect(row("feature/login")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, FILTER_WRITE_DELAY_MS + 50));
    expect(sideViewPosts()).toEqual([]);
  });

  it("filters the graph by the branch clicked, and adds one on Ctrl-click", async () => {
    clickElem(row("topic"));
    row("remotes/origin/main").dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true })
    );
    expect(row("topic").getAttribute("aria-selected")).toBe("true");

    await vi.waitFor(() =>
      expect(sideViewPosts()).toEqual([
        {
          command: "sideViewSetFilter",
          repo: DEFAULT_REPO,
          branches: ["topic", "remotes/origin/main"],
          seq: expect.any(Number)
        }
      ])
    );
  });

  it("keeps a click's highlight against a state read before the host took it", async () => {
    hostSays(state([]));
    clickElem(row("topic"));
    await vi.waitFor(() => expect(sideViewPosts()).toHaveLength(1));
    const asked = (sideViewPosts()[0] as unknown as { seq: number }).seq;

    // Read before the ask landed: the old, empty filter.
    hostSays(state([], true, asked - 1));
    expect(row("topic").getAttribute("aria-selected")).toBe("true");

    // Read after it: the host's word again, whatever it says.
    hostSays(state(["topic"], true, asked));
    expect(row("topic").getAttribute("aria-selected")).toBe("true");
    hostSays(state([], true, asked));
    expect(row("topic").getAttribute("aria-selected")).toBe("false");
  });

  it("highlights the filter the host says, whoever wrote it", () => {
    hostSays(state(["topic"]));
    expect(row("topic").classList.contains("selected")).toBe(true);
    expect(row("main").classList.contains("selected")).toBe(false);

    hostSays(state([]));
    expect(document.querySelectorAll("#branchesView .sideViewRow.selected")).toHaveLength(0);
  });

  it("runs a branch action in the graph itself, not through the host", () => {
    rightClick(row("topic"));
    clickItem(englishCreateArchive());

    expect(mock.sentOf("createArchive")).toEqual([
      { command: "createArchive", repo: DEFAULT_REPO, ref: "topic" }
    ]);
    expect(sideViewPosts()).toEqual([]);
  });

  it("offers the head-guarded actions nowhere on the checked-out branch", () => {
    rightClick(row("main"));
    const labels = menuItemLabels();
    expect(labels.some((label) => label.startsWith("Checkout"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Delete"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Rename"))).toBe(true);
  });

  it("copies the selection's names in the tree's order, from the batch menu", () => {
    hostSays(state(["topic", "remotes/origin/main"]));
    rightClick(row("topic"));
    expect(menuItemLabels()).toContain("<copyNameSelected>");
    clickItem("<copyNameSelected>");

    expect(mock.sentOf("copyToClipboard")).toEqual([
      { command: "copyToClipboard", type: "Branch Name", data: "origin/main\ntopic" }
    ]);
  });

  it("asks the host to say so when every selected branch is ruled out", () => {
    // Fast-forward never takes the checked-out branch, nor a remote one.
    hostSays(state(["main", "remotes/origin/main"]));
    rightClick(row("main"));
    clickItem("<fastForwardSelected>");

    expect(sideViewPosts()).toEqual([
      {
        command: "sideViewNoTargets",
        skipped: [
          { ref: "remotes/origin/main", reason: "remote" },
          { ref: "main", reason: "checkedOut" }
        ]
      }
    ]);
  });

  it("asks the host to run a remote's command on the remote right-clicked", () => {
    const remote = document.querySelector<HTMLElement>('#remotesView [data-remote="origin"]')!;
    rightClick(remote);
    clickItem("<editUrl>");

    expect(sideViewPosts()).toEqual([
      { command: "sideViewRemote", action: "editUrl", name: "origin" }
    ]);
  });

  it("clears the filter at once for Show All", () => {
    hostSays(state(["topic"]));
    clickElem(document.querySelector('#branchesView .sideViewActions [data-action="showAll"]')!);

    expect(sideViewPosts()).toEqual([
      { command: "sideViewSetFilter", repo: DEFAULT_REPO, branches: [], seq: expect.any(Number) }
    ]);
    expect(document.querySelectorAll("#branchesView .sideViewRow.selected")).toHaveLength(0);
  });

  it("keeps the tree's arrow keys from moving the graph's rows", () => {
    const first = row("topic");
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement?.closest("#sideViews")).not.toBeNull();
    expect(document.activeElement).not.toBe(first);
  });

  // --- The Stash view (#400) ----------------------------------------------

  const stashRow = (id: string) => {
    const elem = document.querySelector<HTMLElement>(
      `#stashView [data-stash="${id}"]:not([data-path])`
    );
    expect(elem, id).not.toBeNull();
    return elem!;
  };
  /** Collapse every stash the last test left open: the page outlives tests. */
  const collapseStashes = () => {
    // One at a time: each click draws the rows anew.
    let open: HTMLElement | null;
    while (
      (open = document.querySelector<HTMLElement>(
        '#stashView .sideViewRow.stash[aria-expanded="true"]'
      )) !== null
    ) {
      clickElem(open);
    }
  };

  it("lists the stashes third in the column, newest first, each with its selector", () => {
    collapseStashes();
    const sections = Array.from(document.querySelectorAll("#sideViews > section")).map((s) => s.id);
    expect(sections).toEqual(["branchesView", "remotesView", "stashView"]);
    expect(document.querySelector("#stashView .sideViewTitleText")?.textContent).toBe("<stashes>");

    const rows = Array.from(document.querySelectorAll<HTMLElement>("#stashView .sideViewRow"));
    expect(
      rows.map((r) => [
        r.querySelector(".sideViewLabel")?.textContent,
        r.querySelector(".sideViewDescription")?.textContent
      ])
    ).toEqual([
      ["On main: newer", "stash@{0}"],
      ["On main: older", "stash@{1}"]
    ]);
    expect(rows[0].title).toBe("newer");
  });

  it("says when the repository has no stashes", () => {
    hostSays(state([], true, Number.MAX_SAFE_INTEGER, { stashes: [] }));
    expect(document.querySelector("#stashView .sideViewEmpty")?.textContent).toBe("<noStashes>");
  });

  it("offers the catalogue's stash actions, under the graph's names, and asks the host to run one", () => {
    rightClick(stashRow("bbb222"));
    expect(menuItemLabels()).toEqual([
      "Apply Stash…",
      "Pop Stash…",
      "Rename Stash…",
      "Drop Stash…",
      "Copy Stash Name to Clipboard"
    ]);
    clickItem("Pop Stash…");

    // The host runs it (ADR-0029), never the graph: no graph request either.
    expect(mock.sentMessages).toEqual([{ command: "sideViewStash", action: "pop", id: "bbb222" }]);
  });

  it("hides the stash actions the settings hide, but never Rename, which has no setting", () => {
    const cmv = structuredClone(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
    cmv.stash = { apply: false, pop: false, drop: false, copyName: false };
    hostSays(state([], true, Number.MAX_SAFE_INTEGER, { cmv }));

    rightClick(stashRow("aaa111"));

    expect(menuItemLabels()).toEqual(["Rename Stash…"]);
  });

  it("expands a stash into the files the host read, asking once, and asks for a file's diff", () => {
    collapseStashes();
    clickElem(stashRow("aaa111"));
    expect(sideViewPosts()).toEqual([{ command: "sideViewStashFiles", id: "aaa111" }]);
    expect(stashRow("aaa111").getAttribute("aria-expanded")).toBe("true");

    hostSays({
      command: "sideViewStashFiles",
      repo: DEFAULT_REPO,
      id: "aaa111",
      files: [
        { path: "src/a.ts", name: "a.ts", dir: "src", badge: "M", tooltip: "src/a.ts" },
        { path: "new.txt", name: "new.txt", dir: "", badge: "U", tooltip: "new.txt" }
      ]
    });
    const files = Array.from(
      document.querySelectorAll<HTMLElement>("#stashView .sideViewRow.stashFile")
    );
    expect(
      files.map((f) => [
        f.querySelector(".sideViewLabel")?.textContent,
        f.querySelector(".sideViewFileBadge")?.textContent
      ])
    ).toEqual([
      ["a.ts", "M"],
      ["new.txt", "U"]
    ]);

    clickElem(files[0]);
    // Collapsed and opened again: the files are the page's to keep.
    clickElem(stashRow("aaa111"));
    clickElem(stashRow("aaa111"));
    expect(sideViewPosts()).toEqual([
      { command: "sideViewStashFiles", id: "aaa111" },
      { command: "sideViewStashDiff", id: "aaa111", path: "src/a.ts" }
    ]);
    // No stash menu on a file.
    rightClick(document.querySelector("#stashView .sideViewRow.stashFile")!);
    expect(menuItemLabels()).toEqual([]);
    collapseStashes();
  });

  it("asks the host to read the stashes again from its heading", () => {
    clickElem(document.querySelector('#stashView .sideViewActions [data-action="refresh"]')!);
    expect(sideViewPosts()).toEqual([{ command: "sideViewRefresh" }]);
  });
});

/** The graph's own label for Create Archive, as its menu spells it. */
function englishCreateArchive(): string {
  return (globalThis as unknown as { l10n: { createArchive: string } }).l10n.createArchive + "…";
}
