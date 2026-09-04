import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The one place #144's two scopes must *differ*, and the only scenario that can
// tell them apart.
//
// The ticket asked for a single boundary — `#commitTable` — for all three of the
// leaking class families. That is right for the graph's `tr.commit` rows and
// wrong for the Commit Details View's `.commitBodyLink`s, because the two
// surfaces are not nested. Inline, the panel is a `<tr>` inside the table and
// either boundary contains it, so the inline suite passes under both readings.
// Docked, `renderCommitDetailsPanel` appends the panel to `<body>` instead: a
// `.commitBodyLink` binding scoped to the table would find nothing to bind, and
// Copy Link would quietly stop working for every user with the panel docked —
// with no test anywhere to say so.
//
// So the panel's links are scoped to `#commitDetails` and the graph's rows to
// `#commitTable`, and this suite is what stands between the next reader and
// unifying them. Its control is the dialog's own link, which must still do
// nothing: the fix must not be read as "the panel's scope is simply wider".
//
// One webview per file (#80): the panel's location is read at boot.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState({ commitDetailsViewLocation: "Docked to Bottom" });

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
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

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

const tipDetails: GitCommitDetails = {
  hash: "aaa111",
  parents: [],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Tip commit",
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 }
  ]
};

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

function bodyLink(root: string, email: string) {
  const elem = document.querySelector<HTMLElement>(
    `${root} .commitBodyLink[href="mailto:${encodeURIComponent(email)}"]`
  );
  expect(elem, `${root} ${email}`).not.toBeNull();
  return elem!;
}

function menuItemLabels() {
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
}

function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  click(item!);
}

function hideMenu() {
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("the docked Commit Details View's body links, with a dialog standing", () => {
  let panelIsOutsideTable = false;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
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
    receive(commitsResponse);

    click(document.querySelector('#commitTable tr.commit[data-hash="aaa111"]')!);
    receive({ command: "commitDetails", commitDetails: tipDetails });

    rightClick(document.querySelector('#commitTable .gitRef.head[data-name="feature"]')!);
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

    // One redraw, so the bindings run again with both surfaces standing — the
    // condition under which the unscoped version reached across.
    receive(commitsResponse);
    panelIsOutsideTable =
      document.getElementById("commitDetails") !== null &&
      document.getElementById("commitDetails")!.closest("#commitTable") === null;
  });

  it("has the panel outside the table, which is the whole point of the scenario", () => {
    // Without this the assertions below would hold for the ordinary reason, and
    // a scope unified onto `#commitTable` would sail through.
    expect(panelIsOutsideTable).toBe(true);
  });

  it("still raises Copy Link on the panel's own link", () => {
    hideMenu();
    rightClick(bodyLink("#commitDetails", "alice@example.com"));
    expect(menuItemLabels()).toEqual([L.copyLink]);
  });

  it("still raises nothing on the dialog's", () => {
    hideMenu();
    rightClick(bodyLink("#dialog", "dana@example.com"));
    expect(menuItemLabels()).toEqual([]);
    expect(document.getElementById("contextMenu")!.classList.contains("active")).toBe(false);
  });
});
