import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The Repository Settings dialog (#183): a toolbar shortcut to the repo's own
// overrides. It writes the repo state and nothing else — the host resolves the
// load scope from that state — so what is under test is which fields a press
// of Apply writes, and which reload it follows them with.
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

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function openSettings() {
  click("repoSettingsBtn");
  expect(document.getElementById("dialogAction")?.textContent).toBe(L.repoSettingsApply);
}

/** The dialog's checkbox whose label begins with `label`. */
function checkbox(label: string) {
  const input = Array.from(document.querySelectorAll<HTMLLabelElement>("#dialog label"))
    .find((l) => (l.textContent ?? "").trim().startsWith(label))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input, label).toBeDefined();
  return input!;
}

function nameInput() {
  return document.querySelector<HTMLInputElement>('#dialog input[type="text"]')!;
}

function orderSelect() {
  return document.querySelector<HTMLSelectElement>("#dialog select")!;
}

function dialogText() {
  const elem = document.getElementById("dialog")!;
  return elem.classList.contains("active") ? (elem.textContent ?? "") : "";
}

function dismissAnyDialog() {
  document
    .getElementById("dialogDismiss")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function savedRepoStates() {
  return mock.sentOf("saveRepoState").map((m) => m.state);
}

function savedMaxCommits() {
  return mock.getState()!.maxCommits;
}

/** Widen the loaded commit window by one page and land that load, so a
 *  shrink back to the opening count is visible. */
function widenWindow() {
  click("loadMoreCommitsBtn");
  receive(commitsResponse);
}

describe("the Repository Settings dialog", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
  });

  describe("when opened", () => {
    beforeAll(() => {
      openSettings();
    });

    it("names the repository it is about", () => {
      expect(dialogText()).toContain(L.repoSettingsTitle.replace("{0}", "my-repo"));
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

    it("offers the folder name as the name a blank field falls back to", () => {
      expect(nameInput().value).toBe("");
      expect(nameInput().placeholder).toBe("my-repo");
    });

    it("warns beside Show remote branches that turning it off is not undone", () => {
      expect(
        checkbox(L.repoSettingsShowRemoteBranches)
          .closest("label")!
          .querySelector("[title]")!
          .getAttribute("title")
      ).toBe(L.repoSettingsRemotePruneInfo);
    });

    it("writes nothing and reloads nothing when applied unchanged", () => {
      mock.clearMessages();
      click("dialogAction");
      expect(mock.sentMessages).toHaveLength(0);
    });
  });

  describe("changing a setting that steers the load", () => {
    let saveIndex: number;
    let loadIndex: number;
    beforeAll(() => {
      widenWindow();
      openSettings();
      checkbox(L.repoSettingsFirstParentOnly).click();
      mock.clearMessages();
      click("dialogAction");
      saveIndex = mock.sentMessages.findIndex((m) => m.command === "saveRepoState");
      loadIndex = mock.sentMessages.findIndex((m) => m.command === "loadCommits");
    });

    it("writes that one override", () => {
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

    it("reloads only the commits: the branch list has not moved", () => {
      expect(mock.sentOf("loadBranches")).toHaveLength(0);
      receive(commitsResponse);
    });
  });

  describe("with a commit load in flight", () => {
    let refusal: string;
    let loadWasInFlight: boolean;
    beforeAll(() => {
      mock.clearMessages();
      click("loadMoreCommitsBtn");
      loadWasInFlight = mock.sentOf("loadCommits").length === 1;
      mock.clearMessages();
      openSettings();
      checkbox(L.repoSettingsShowStashes).click();
      click("dialogAction");
      refusal = dialogText();
      dismissAnyDialog();
    });

    it("had a load in flight for Apply to collide with", () => {
      expect(loadWasInFlight).toBe(true);
    });

    it("refuses out loud rather than applying half of it", () => {
      expect(refusal).toContain(L.dialogRepoSettingsBusy);
      expect(mock.sentOf("saveRepoState")).toHaveLength(0);
      expect(mock.sentOf("loadCommits")).toHaveLength(0);
    });

    it("still applies a change that needs no reload", () => {
      openSettings();
      nameInput().value = "  Renamed  ";
      click("dialogAction");
      expect(dialogText()).not.toContain(L.dialogRepoSettingsBusy);
      expect(savedRepoStates()).toMatchObject([{ customName: "Renamed" }]);
      expect(document.getElementById("repoTitleName")!.textContent).toBe("Renamed");
      receive(commitsResponse);
    });
  });

  describe("turning remote branches off", () => {
    beforeAll(() => {
      openSettings();
      checkbox(L.repoSettingsShowRemoteBranches).click();
      mock.clearMessages();
      click("dialogAction");
    });

    it("writes the override the Branches side-view reads", () => {
      expect(savedRepoStates()).toMatchObject([{ showRemoteBranches: false }]);
    });

    it("reloads the branches as well as the commits", () => {
      expect(mock.sentOf("loadBranches")).toHaveLength(1);
      receive(branchesResponse);
      receive(commitsResponse);
    });

    it("opens next time showing it off", () => {
      openSettings();
      expect(checkbox(L.repoSettingsShowRemoteBranches).checked).toBe(false);
      dismissAnyDialog();
    });
  });

  describe("choosing a commit order", () => {
    beforeAll(() => {
      openSettings();
      orderSelect().value = "topo";
      mock.clearMessages();
      click("dialogAction");
    });

    it("writes the same override the column-header menu does", () => {
      expect(savedRepoStates()).toMatchObject([{ commitOrdering: "topo" }]);
    });

    it("and reloads with it", () => {
      expect(mock.sentOf("loadCommits")).toMatchObject([{ commitOrder: "topo" }]);
      receive(commitsResponse);
    });
  });

  describe("changing a setting only the Branches side-view shows", () => {
    beforeAll(() => {
      openSettings();
      checkbox(L.repoSettingsShowInactiveBranches).click();
      mock.clearMessages();
      click("dialogAction");
    });

    it("writes it", () => {
      expect(savedRepoStates()).toMatchObject([{ showInactiveBranches: true }]);
    });

    it("leaves the graph alone", () => {
      expect(mock.sentOf("loadCommits")).toHaveLength(0);
      expect(mock.sentOf("loadBranches")).toHaveLength(0);
    });
  });
});
