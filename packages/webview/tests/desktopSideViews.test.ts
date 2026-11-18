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
  contextMenuEntries,
  createVscodeMock,
  DEFAULT_REPO,
  hear,
  hideMenu,
  makeViewState,
  menuItemLabels,
  receive,
  rightClick,
  setupHtml
} from "./setup";
import { startDesktop } from "./startDesktop";

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
    "noStashes",
    "search",
    "viewReflog",
    "resize"
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

/** A button on the Branches view's heading. */
const branchesAction = (action: string) =>
  document.querySelector<HTMLElement>(`#branchesView .sideViewActions [data-action="${action}"]`);

/** The column's edge, its handle (#459). */
const resizer = () => document.getElementById("sideViewResizer")!;
const columnWidth = () => document.documentElement.style.getPropertyValue("--ging-side-view-width");

/** How tall the Branches tree shows, as the virtualization tests lay it out,
 *  and a row's height. */
const HEIGHT = 440;
const ROW = 22;
const body = () => document.querySelector<HTMLElement>("#branchesView .sideViewBody")!;
/** The Branches tree's rows in the page. */
const drawn = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#branchesView .sideViewBody .sideViewRow"));
/** Scroll the Branches tree, as the user's wheel would. */
const scrollTo = (top: number) => {
  body().scrollTop = top;
  body().dispatchEvent(new Event("scroll"));
};
/** Press `k` where the keyboard is. */
const pressKey = (k: string, init: KeyboardEventInit = {}) =>
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })
  );
const folder = () => document.querySelector<HTMLElement>('#branchesView [data-key="folder:zz"]')!;

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
    await startDesktop();
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
    hear(state());
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
    hear(state([]));
    clickElem(row("topic"));
    await vi.waitFor(() => expect(sideViewPosts()).toHaveLength(1));
    const asked = (sideViewPosts()[0] as unknown as { seq: number }).seq;

    // Read before the ask landed: the old, empty filter.
    hear(state([], true, asked - 1));
    expect(row("topic").getAttribute("aria-selected")).toBe("true");

    // Read after it: the host's word again, whatever it says.
    hear(state(["topic"], true, asked));
    expect(row("topic").getAttribute("aria-selected")).toBe("true");
    hear(state([], true, asked));
    expect(row("topic").getAttribute("aria-selected")).toBe("false");
  });

  it("highlights the filter the host says, whoever wrote it", () => {
    hear(state(["topic"]));
    expect(row("topic").classList.contains("selected")).toBe(true);
    expect(row("main").classList.contains("selected")).toBe(false);

    hear(state([]));
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
    hear(state(["topic", "remotes/origin/main"]));
    rightClick(row("topic"));
    expect(menuItemLabels()).toContain("<copyNameSelected>");
    clickItem("<copyNameSelected>");

    expect(mock.sentOf("copyToClipboard")).toEqual([
      { command: "copyToClipboard", type: "Branch Name", data: "origin/main\ntopic" }
    ]);
  });

  it("asks the host to say so when every selected branch is ruled out", () => {
    // Fast-forward never takes the checked-out branch, nor a remote one.
    hear(state(["main", "remotes/origin/main"]));
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
    hear(state(["topic"]));
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
    hear(state([], true, Number.MAX_SAFE_INTEGER, { stashes: [] }));
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
    hear(state([], true, Number.MAX_SAFE_INTEGER, { cmv }));

    rightClick(stashRow("aaa111"));

    expect(menuItemLabels()).toEqual(["Rename Stash…"]);
  });

  it("expands a stash into the files the host read, asking once, and asks for a file's diff", () => {
    collapseStashes();
    clickElem(stashRow("aaa111"));
    expect(sideViewPosts()).toEqual([{ command: "sideViewStashFiles", id: "aaa111" }]);
    expect(stashRow("aaa111").getAttribute("aria-expanded")).toBe("true");

    hear({
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

  // --- Search Branch and View Reflog (#459) ---------------------------------

  it("offers Search Branch first on the Branches heading, named, and asks the host for it", () => {
    const actions = Array.from(
      document.querySelectorAll<HTMLElement>("#branchesView .sideViewActions button")
    ).map((b) => b.dataset.action);
    expect(actions).toEqual(["search", "showAll", "refresh", "more"]);
    const search = branchesAction("search")!;
    expect(search.title).toBe("<search>");
    expect(search.getAttribute("aria-label")).toBe("<search>");
    // The Remotes view has none.
    expect(document.querySelector('#remotesView [data-action="search"]')).toBeNull();

    clickElem(search);

    expect(sideViewPosts()).toEqual([{ command: "sideViewSearch" }]);
  });

  it("writes a click's filter still waiting before it asks for Search Branch", () => {
    clickElem(row("topic"));
    clickElem(branchesAction("search")!);

    expect(sideViewPosts()).toEqual([
      {
        command: "sideViewSetFilter",
        repo: DEFAULT_REPO,
        branches: ["topic"],
        seq: expect.any(Number)
      },
      { command: "sideViewSearch" }
    ]);
  });

  it("offers View Reflog in the Branches view's More Actions, before Clean Up and with it, and asks the host to run it", () => {
    clickElem(branchesAction("more")!);
    expect(contextMenuEntries()).toEqual([
      "<showRemoteBranches>",
      "<showInactive>",
      "<showMerged>",
      "",
      "<collapseAll>",
      "<viewReflog>",
      "<cleanup>"
    ]);
    clickItem("<viewReflog>");
    expect(sideViewPosts()).toEqual([{ command: "sideViewViewReflog" }]);

    // The Remotes view's is as it was.
    hideMenu();
    clickElem(document.querySelector('#remotesView .sideViewActions [data-action="more"]')!);
    expect(contextMenuEntries()).toEqual(["<addRemote>", "", "<managePullRequestProviders>"]);
  });

  // --- The column's layout (#459) ------------------------------------------

  const layoutIs = (width: number, shown: boolean) =>
    hear({ command: "sideViewLayout", layout: { width, shown } });
  const press = (key: string) =>
    resizer().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("puts a handle on the column's edge that the keyboard moves 10 pixels a step, within bounds", () => {
    layoutIs(260, true);
    const handle = resizer();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("<resize>");
    expect(columnWidth()).toBe("260px");

    press("ArrowRight");
    press("ArrowRight");
    press("ArrowLeft");
    expect(columnWidth()).toBe("270px");
    expect(handle.getAttribute("aria-valuenow")).toBe("270");
    // Each step left where it is, for the host to keep.
    expect(sideViewPosts()).toEqual([
      { command: "sideViewResize", width: 270 },
      { command: "sideViewResize", width: 280 },
      { command: "sideViewResize", width: 270 }
    ]);

    layoutIs(165, true);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(columnWidth()).toBe("160px");
    layoutIs(595, true);
    press("ArrowRight");
    expect(columnWidth()).toBe("600px");
    layoutIs(260, true);
  });

  it("gives up the whole column when the host hides it, and comes back as wide as it was, the filter highlighted", () => {
    layoutIs(300, true);
    layoutIs(300, false);
    const column = document.getElementById("sideViews")!;
    expect(column.hidden).toBe(true);
    expect(resizer().hidden).toBe(true);
    expect(document.body.classList.contains("gingSideViews")).toBe(false);
    expect(columnWidth()).toBe("0px");

    // The filter moves while it is hidden.
    hear(state(["topic"]));
    layoutIs(300, true);
    expect(column.hidden).toBe(false);
    expect(resizer().hidden).toBe(false);
    expect(document.body.classList.contains("gingSideViews")).toBe(true);
    expect(columnWidth()).toBe("300px");
    expect(row("topic").getAttribute("aria-selected")).toBe("true");
    layoutIs(260, true);
  });

  // --- The Branches tree, drawn a window at a time (#459) -------------------

  describe("with thousands of branches", () => {
    /** 2000 local branches: 1998 at the top, and two in a folder last. */
    const MANY = [
      ...Array.from({ length: 1998 }, (_, n) => `b${String(n).padStart(4, "0")}`),
      "zz/one",
      "zz/two"
    ];
    const many = (filter: string[] = []): SideViewStateMessage => ({
      ...state(filter, false),
      branches: {
        roots: buildGroupedBranchRoots(MANY, "b0000"),
        rows: {},
        filter,
        toggles: {
          showRemoteBranches: true,
          showInactiveBranches: true,
          showMergedBranches: true
        }
      }
    });
    beforeEach(() => {
      // jsdom lays nothing out: the tree shows 20 rows.
      Object.defineProperty(body(), "clientHeight", { configurable: true, get: () => HEIGHT });
      body().scrollTop = 0;
      hear(many());
      // Every row shown: the folder, last, opened where it is drawn.
      scrollTo(MANY.length * ROW);
      openFolder("folder:zz");
      scrollTo(0);
      mock.clearMessages();
    });

    it("puts only the rows in view, and 20 at most past each edge, in the page", () => {
      const rows = MANY.length + 1;
      expect(drawn().length).toBeGreaterThan(0);
      expect(drawn().length).toBeLessThanOrEqual(HEIGHT / ROW + 40);
      expect(drawn()[0].dataset.ref).toBe("b0000");
      // As tall as every row would be.
      expect(body().querySelector<HTMLElement>(".sideViewRows")!.style.height).toBe(
        `${rows * ROW}px`
      );

      scrollTo(1000 * ROW + 7);
      expect(drawn().length).toBeLessThanOrEqual(HEIGHT / ROW + 40);
      expect(drawn().map((r) => r.dataset.ref)).toContain("b1000");
      expect(drawn().map((r) => r.dataset.ref)).not.toContain("b0000");

      // Scrolled to the bottom: the last branch is there.
      scrollTo(rows * ROW - HEIGHT);
      expect(drawn().at(-1)!.dataset.ref).toBe("zz/two");
      expect(drawn().length).toBeLessThanOrEqual(HEIGHT / ROW + 40);
    });

    it("moves the keyboard to rows that were not in the page, scrolling them into view", () => {
      clickElem(drawn()[0]);
      drawn()[0].focus();
      expect(document.activeElement).toBe(row("b0000"));

      pressKey("End");
      expect(document.activeElement).toBe(row("zz/two"));
      expect(body().scrollTop).toBe((MANY.length + 1) * ROW - HEIGHT);

      pressKey("ArrowUp");
      expect(document.activeElement).toBe(row("zz/one"));

      pressKey("Home");
      expect(document.activeElement).toBe(row("b0000"));
      expect(body().scrollTop).toBe(0);

      // Down past the bottom of what shows.
      for (let n = 0; n < 25; n++) pressKey("ArrowDown");
      expect(document.activeElement).toBe(row("b0025"));
      expect(body().scrollTop).toBe(26 * ROW - HEIGHT);
      // The keys stay the tree's, not the graph's.
      expect(document.activeElement?.closest("#sideViews")).not.toBeNull();
    });

    it("keeps the keyboard's row when it scrolls out of the page, and moves on from it", () => {
      row("b0003").focus();
      clickElem(row("b0003"));
      mock.clearMessages();

      scrollTo(1500 * ROW);
      expect(drawn().map((r) => r.dataset.ref)).not.toContain("b0003");
      // The tree holds the keyboard, and the tab stop, for the row.
      expect(document.activeElement).toBe(body());
      expect(body().tabIndex).toBe(0);

      pressKey("ArrowDown");
      expect(document.activeElement).toBe(row("b0004"));
      expect(body().scrollTop).toBe(4 * ROW);
    });

    it("multi-selects, expands, collapses and opens a menu on rows scrolled to", async () => {
      scrollTo(1990 * ROW);
      clickElem(row("b1990"));
      row("b1995").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      await vi.waitFor(() =>
        expect(sideViewPosts()).toEqual([
          {
            command: "sideViewSetFilter",
            repo: DEFAULT_REPO,
            branches: ["b1990", "b1995"],
            seq: expect.any(Number)
          }
        ])
      );
      expect(row("b1990").getAttribute("aria-selected")).toBe("true");
      expect(row("b1995").getAttribute("aria-selected")).toBe("true");

      clickElem(folder());
      expect(folder().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('#branchesView [data-ref="zz/one"]')).toBeNull();
      clickElem(folder());
      expect(folder().getAttribute("aria-expanded")).toBe("true");
      expect(row("zz/one")).toBeDefined();

      hear(many(["b1990", "b1995"]));
      rightClick(row("b1995"));
      expect(menuItemLabels()).toContain("<copyNameSelected>");
      clickItem("<copyNameSelected>");
      expect(mock.sentOf("copyToClipboard")).toEqual([
        { command: "copyToClipboard", type: "Branch Name", data: "b1990\nb1995" }
      ]);
    });

    it("keeps the scroll and the keyboard's row when a new state comes in", () => {
      scrollTo(700 * ROW);
      row("b0705").focus();
      clickElem(row("b0705"));

      hear(many(["b0705"]));

      expect(body().scrollTop).toBe(700 * ROW);
      expect(document.activeElement).toBe(row("b0705"));
      expect(drawn().map((r) => r.dataset.ref)).toContain("b0710");
    });
  });
});

/** The graph's own label for Create Archive, as its menu spells it. */
function englishCreateArchive(): string {
  return (globalThis as unknown as { l10n: { createArchive: string } }).l10n.createArchive + "…";
}
