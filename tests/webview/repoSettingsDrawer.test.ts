import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The Repository Settings drawer (#183): a toolbar shortcut to the repo's own
// overrides, applied as each control changes. It writes the repo state and
// nothing else — the host resolves the load scope from that state — so what is
// under test is which fields a change writes, and which reload follows it.
//
// One webview for the whole suite, the scenarios in order, as a session runs.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState({
  // One override already in place, so "untouched" can be told apart from
  // "written back as the global value".
  repos: { [DEFAULT_REPO]: { columnWidths: null, showMergedBranches: true } }
});

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
    refs: []
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
  moreCommitsAvailable: true,
  hard: true
};

let mock: ReturnType<typeof createVscodeMock>;

function click(elem: Element | null, what: string) {
  expect(elem, what).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function gear() {
  return document.getElementById("repoSettingsBtn")!;
}

function drawer() {
  return document.getElementById("repoSettingsDrawer")!;
}

function drawerOpen() {
  return drawer().classList.contains("active");
}

function openDrawer() {
  if (!drawerOpen()) click(gear(), "gear");
  expect(drawerOpen()).toBe(true);
}

/** The drawer's checkbox whose label begins with `label`. Looked up afresh
 *  every time: the drawer redraws itself after each change. */
function checkbox(label: string) {
  const input = Array.from(drawer().querySelectorAll<HTMLLabelElement>("label"))
    .find((l) => (l.textContent ?? "").trim().startsWith(label))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input, label).toBeDefined();
  return input!;
}

function orderSelect() {
  return drawer().querySelector<HTMLSelectElement>("select")!;
}

function chooseOrder(value: string) {
  orderSelect().value = value;
  orderSelect().dispatchEvent(new Event("change", { bubbles: true }));
}

function dialogText() {
  const elem = document.getElementById("dialog")!;
  return elem.classList.contains("active") ? (elem.textContent ?? "") : "";
}

function savedRepoStates() {
  return mock.sentOf("saveRepoState").map((m) => m.state);
}

function savedMaxCommits() {
  return mock.getState()!.maxCommits;
}

function refreshing() {
  return document.getElementById("refreshBtn")!.classList.contains("refreshing");
}

describe("the Repository Settings drawer", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  describe("when the gear is clicked", () => {
    beforeAll(() => {
      click(gear(), "gear");
    });

    it("slides the drawer out, and says so on the gear", () => {
      expect(drawerOpen()).toBe(true);
      expect(gear().getAttribute("aria-expanded")).toBe("true");
    });

    it("shows each setting's value in force: the override where there is one", () => {
      expect(checkbox(L.repoSettingsShowMergedBranches).checked).toBe(true);
    });

    it("and the global setting where there is none", () => {
      expect(checkbox(L.repoSettingsShowRemoteBranches).checked).toBe(true);
      expect(checkbox(L.repoSettingsShowStashes).checked).toBe(true);
      expect(checkbox(L.repoSettingsFirstParentOnly).checked).toBe(false);
      expect(checkbox(L.repoSettingsShowInactiveBranches).checked).toBe(false);
      expect(orderSelect().value).toBe("default");
    });

    it("shows the name as text with a pencil, not as a field", () => {
      expect(drawer().querySelector(".repoSettingsName")!.textContent).toBe("my-repo");
      expect(drawer().querySelector('input[type="text"]')).toBeNull();
      expect(document.getElementById("repoSettingsRename")!.getAttribute("title")).toBe(
        L.repoSettingsRename
      );
    });

    it("has no Apply or Cancel: nothing waits to be confirmed", () => {
      expect(drawer().querySelector("#dialogAction, #dialogDismiss")).toBeNull();
      expect(dialogText()).toBe("");
    });

    it("warns beside Show remote branches that turning it off is not undone", () => {
      expect(
        checkbox(L.repoSettingsShowRemoteBranches)
          .closest("label")!
          .querySelector("[title]")!
          .getAttribute("title")
      ).toBe(L.repoSettingsRemotePruneInfo);
    });

    it("stays open for a click inside it", () => {
      click(drawer().querySelector(".repoSettingsHeader"), "header");
      expect(drawerOpen()).toBe(true);
    });

    it("closes on a click anywhere else", () => {
      click(document.getElementById("commitTable"), "table");
      expect(drawerOpen()).toBe(false);
      expect(gear().getAttribute("aria-expanded")).toBe("false");
    });

    it("closes on Escape, handing focus back to the gear", () => {
      openDrawer();
      const focused = document.activeElement as HTMLElement;
      expect(drawer().contains(focused)).toBe(true);
      focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(drawerOpen()).toBe(false);
      expect(document.activeElement).toBe(gear());
    });

    it("toggles closed on a second click of the gear", () => {
      openDrawer();
      click(gear(), "gear");
      expect(drawerOpen()).toBe(false);
    });
  });

  describe("ticking a setting that steers the load", () => {
    let saveIndex: number;
    let loadIndex: number;
    beforeAll(() => {
      click(document.getElementById("loadMoreCommitsBtn"), "Load More");
      receive(commitsResponse);
      openDrawer();
      mock.clearMessages();
      checkbox(L.repoSettingsFirstParentOnly).click();
      saveIndex = mock.sentMessages.findIndex((m) => m.command === "saveRepoState");
      loadIndex = mock.sentMessages.findIndex((m) => m.command === "loadCommits");
    });

    it("writes that one override at once", () => {
      expect(savedRepoStates()).toHaveLength(1);
      expect(savedRepoStates()[0].onlyFollowFirstParent).toBe(true);
    });

    it("leaves every field it did not change as it was", () => {
      // Unset stays unset — it goes on following the global setting — and an
      // existing override is not rewritten.
      const state = savedRepoStates()[0];
      expect(state.showStashes).toBeUndefined();
      expect(state.showRemoteBranches).toBeUndefined();
      expect(state.showMergedBranches).toBe(true);
    });

    it("writes before it reloads, since the host reads the scope off the state", () => {
      expect(saveIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeGreaterThan(saveIndex);
    });

    it("shrinks the loaded commit window, as the commit-ordering menu does", () => {
      expect(savedMaxCommits()).toBe(viewState.initialLoadCommits);
    });

    it("reloads only the commits, under the busy indicator", () => {
      expect(mock.sentOf("loadBranches")).toHaveLength(0);
      expect(refreshing()).toBe(true);
    });

    it("stays open, showing the change", () => {
      expect(drawerOpen()).toBe(true);
      expect(checkbox(L.repoSettingsFirstParentOnly).checked).toBe(true);
    });

    it("puts the indicator out when the load lands", () => {
      receive(commitsResponse);
      expect(refreshing()).toBe(false);
    });
  });

  describe("two changes in a row, the second while the first is still loading", () => {
    let loadsSent: number;
    beforeAll(() => {
      mock.clearMessages();
      checkbox(L.repoSettingsShowStashes).click();
      checkbox(L.repoSettingsShowRemoteHeads).click();
      loadsSent = mock.sentOf("loadCommits").length;
    });

    it("applies both — the second abandons the first's load rather than being refused", () => {
      expect(savedRepoStates()).toHaveLength(2);
      expect(savedRepoStates()[1]).toMatchObject({ showStashes: false, showRemoteHeads: false });
      expect(loadsSent).toBe(2);
      expect(dialogText()).toBe("");
    });

    it("leaves one claim on the indicator, released when the surviving load lands", () => {
      expect(refreshing()).toBe(true);
      receive(commitsResponse);
      expect(refreshing()).toBe(false);
    });
  });

  describe("turning remote branches off", () => {
    beforeAll(() => {
      mock.clearMessages();
      checkbox(L.repoSettingsShowRemoteBranches).click();
    });

    it("writes the override the Branches side-view reads", () => {
      expect(savedRepoStates()).toMatchObject([{ showRemoteBranches: false }]);
    });

    it("reloads the branches as well as the commits", () => {
      expect(mock.sentOf("loadBranches")).toHaveLength(1);
      receive(branchesResponse);
      receive(commitsResponse);
    });

    it("keeps showing it off", () => {
      expect(checkbox(L.repoSettingsShowRemoteBranches).checked).toBe(false);
    });
  });

  describe("choosing a commit order", () => {
    beforeAll(() => {
      mock.clearMessages();
      chooseOrder("topo");
    });

    it("writes the same override the column-header menu does", () => {
      expect(savedRepoStates()).toMatchObject([{ commitOrdering: "topo" }]);
    });

    it("and reloads with it", () => {
      expect(mock.sentOf("loadCommits")).toMatchObject([{ commitOrder: "topo" }]);
      receive(commitsResponse);
    });

    it("writes null, not the string, for the global setting", () => {
      mock.clearMessages();
      chooseOrder("default");
      expect(savedRepoStates()[0].commitOrdering).toBeNull();
      receive(commitsResponse);
    });
  });

  describe("changing a setting only the Branches side-view shows", () => {
    beforeAll(() => {
      mock.clearMessages();
      checkbox(L.repoSettingsShowInactiveBranches).click();
    });

    it("writes it", () => {
      expect(savedRepoStates()).toMatchObject([{ showInactiveBranches: true }]);
    });

    it("leaves the graph alone", () => {
      expect(mock.sentOf("loadCommits")).toHaveLength(0);
      expect(mock.sentOf("loadBranches")).toHaveLength(0);
    });
  });

  describe("a change arriving from outside while the drawer is open", () => {
    it("is drawn: the side-view's toggle reaches the graph as a loadRepos push", () => {
      const state = mock.sentOf("saveRepoState").at(-1)!.state;
      receive({
        command: "loadRepos",
        repos: { [DEFAULT_REPO]: { ...state, showMergedBranches: false } },
        lastActiveRepo: DEFAULT_REPO
      });
      expect(drawerOpen()).toBe(true);
      expect(checkbox(L.repoSettingsShowMergedBranches).checked).toBe(false);
    });
  });

  describe("the pencil", () => {
    beforeAll(() => {
      openDrawer();
      click(document.getElementById("repoSettingsRename"), "pencil");
    });

    it("steps the drawer aside and asks for the name in a dialog", () => {
      expect(drawerOpen()).toBe(false);
      expect(dialogText()).toContain(L.repoSettingsRenamePrompt);
      const input = document.querySelector<HTMLInputElement>('#dialog input[type="text"]')!;
      expect(input.value).toBe("");
      expect(input.placeholder).toBe("my-repo");
    });

    it("puts the cursor in the field: the pencil was pressed to type", () => {
      expect(document.activeElement).toBe(document.querySelector('#dialog input[type="text"]'));
    });

    it("writes the trimmed name and retitles the toolbar", () => {
      mock.clearMessages();
      document.querySelector<HTMLInputElement>('#dialog input[type="text"]')!.value = "  Renamed  ";
      click(document.getElementById("dialogAction"), "Rename");
      expect(savedRepoStates()).toMatchObject([{ customName: "Renamed" }]);
      expect(document.getElementById("repoTitleName")!.textContent).toBe("Renamed");
      expect(mock.sentOf("loadCommits")).toHaveLength(0);
    });

    it("clears the name back to the folder's when left blank", () => {
      openDrawer();
      expect(drawer().querySelector(".repoSettingsName")!.textContent).toBe("Renamed");
      click(document.getElementById("repoSettingsRename"), "pencil");
      mock.clearMessages();
      document.querySelector<HTMLInputElement>('#dialog input[type="text"]')!.value = " ";
      click(document.getElementById("dialogAction"), "Rename");
      expect(savedRepoStates()[0].customName).toBeNull();
      expect(document.getElementById("repoTitleName")!.textContent).toBe("my-repo");
    });
  });
});
