import { beforeAll, describe, expect, it, type Mock, vi } from "vitest";

import {
  DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
  mergeContextMenuActionsVisibility
} from "@/backend/utils/contextMenuVisibility";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import {
  menuFor,
  type RefMenuActions,
  type RefMenuContext,
  type RefTarget
} from "@/webview/refContextMenu";

// The ref menu's content decisions, tested as data: for a typed target and a
// view-state context, menuFor answers "which items, in what order, with which
// icon and visibility gate" without any DOM. The DOM seam (chip classification,
// action behaviour) is covered by refContextMenuDom.test.ts.

const L = getWebviewLocalizedStrings();
// Titles carry the raw ELLIPSIS entity; showContextMenu renders them into
// innerHTML unescaped, which is what turns it into "…".
const E = "&#8230;";

const ACTION_NAMES = [
  "applyStash",
  "popStash",
  "dropStash",
  "renameStash",
  "viewTagDetails",
  "deleteTag",
  "pushTag",
  "checkout",
  "rename",
  "push",
  "createArchive",
  "delete",
  "merge",
  "rebase",
  "fastForward",
  "pull",
  "fetchIntoLocal",
  "deleteRemote",
  "checkRedundancy",
  "cleanupBranches",
  "createPullRequest",
  "viewIssue",
  "copyName"
] as const satisfies readonly (keyof RefMenuActions)[];

type StubbedActions = Record<keyof RefMenuActions, Mock<(...args: unknown[]) => void>>;

function stubActions(): StubbedActions {
  return Object.fromEntries(
    ACTION_NAMES.map((name) => [name, vi.fn<(...args: unknown[]) => void>()])
  ) as StubbedActions;
}

function ctxWith(overrides: Partial<RefMenuContext> = {}): RefMenuContext {
  return {
    cmv: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
    hasRemotes: true,
    isCleanupCandidate: false,
    issueUrl: null,
    actions: stubActions(),
    ...overrides
  };
}

/** The menu as comparable data; `visible: undefined` records "no gate". */
function shape(items: ContextMenuElement[]) {
  return items.map((entry) =>
    entry === null ? "divider" : { title: entry.title, icon: entry.icon, visible: entry.visible }
  );
}

const localBranch = (name: string, isHead = false): RefTarget => ({ kind: "branch", name, isHead });
const remoteBranch = (name: string): RefTarget => ({ kind: "remoteBranch", name });

/** Every switch of one cmv category flipped off. */
const allOff = <T extends Record<string, boolean>>(category: T) =>
  Object.fromEntries(Object.keys(category).map((k) => [k, false])) as Partial<T>;

beforeAll(() => {
  global["l10n"] = L;
});

describe("menuFor: which items each kind of ref gets", () => {
  it("gives a stash the stash actions, then the copy tail", () => {
    expect(shape(menuFor({ kind: "stash", name: "stash@{0}" }, ctxWith()))).toEqual([
      { title: L.stashApply + E, icon: undefined, visible: true },
      { title: L.stashPop + E, icon: undefined, visible: true },
      { title: L.stashDrop + E, icon: "trash", visible: true },
      { title: L.stashRename + E, icon: "pencil", visible: true },
      "divider",
      { title: L.copyStashName, icon: undefined, visible: true }
    ]);
  });

  it("gives a tag the tag actions, pushing only when a remote exists", () => {
    expect(shape(menuFor({ kind: "tag", name: "v1.0" }, ctxWith()))).toEqual([
      { title: L.viewTagDetails + E, icon: undefined, visible: true },
      { title: L.createArchive + E, icon: undefined, visible: true },
      { title: L.deleteTag + E, icon: "trash", visible: true },
      { title: L.pushTag + E, icon: "repoPush", visible: true },
      "divider",
      { title: L.copyTagName, icon: undefined, visible: true }
    ]);

    expect(shape(menuFor({ kind: "tag", name: "v1.0" }, ctxWith({ hasRemotes: false })))).toEqual([
      { title: L.viewTagDetails + E, icon: undefined, visible: true },
      { title: L.createArchive + E, icon: undefined, visible: true },
      { title: L.deleteTag + E, icon: "trash", visible: true },
      "divider",
      { title: L.copyTagName, icon: undefined, visible: true }
    ]);
  });

  it("withholds checkout and the mutating actions from the checked-out branch", () => {
    expect(shape(menuFor(localBranch("main", true), ctxWith()))).toEqual([
      { title: L.renameBranch + E, icon: "pencil", visible: true },
      { title: L.pushBranch + E, icon: "repoPush", visible: true },
      { title: L.createArchive + E, icon: undefined, visible: true },
      { title: L.checkRedundancy, icon: undefined, visible: true },
      { title: L.createPullRequest + E, icon: "gitPullRequest", visible: undefined },
      "divider",
      { title: L.copyBranchName, icon: undefined, visible: true }
    ]);
  });

  it("gives another local branch the full set, checkout leading without an ellipsis", () => {
    expect(shape(menuFor(localBranch("feature"), ctxWith()))).toEqual([
      { title: L.checkoutBranch, icon: "arrowSwitch", visible: true },
      { title: L.renameBranch + E, icon: "pencil", visible: true },
      { title: L.pushBranch + E, icon: "repoPush", visible: true },
      { title: L.createArchive + E, icon: undefined, visible: true },
      { title: L.deleteBranch + E, icon: "trash", visible: true },
      { title: L.merge + E, icon: "gitMerge", visible: true },
      { title: L.rebaseOnBranch + E, icon: "rebase", visible: true },
      // Keyless in the catalogue (`cmvKey: null`): no gate, like create PR.
      { title: L.fastForwardBranch, icon: "moveToEnd", visible: undefined },
      { title: L.checkRedundancy, icon: undefined, visible: true },
      { title: L.createPullRequest + E, icon: "gitPullRequest", visible: undefined },
      "divider",
      { title: L.copyBranchName, icon: undefined, visible: true }
    ]);
  });

  it("drops push and create-pull-request when the repo has no remotes", () => {
    const titles = menuFor(localBranch("feature"), ctxWith({ hasRemotes: false })).map(
      (entry) => entry?.title ?? "divider"
    );
    expect(titles).not.toContain(L.pushBranch + E);
    expect(titles).not.toContain(L.createPullRequest + E);
  });

  it("gives a remote branch the remote actions, checkout asking via an ellipsis", () => {
    expect(shape(menuFor(remoteBranch("origin/feature"), ctxWith()))).toEqual([
      { title: L.checkoutBranch + E, icon: "arrowSwitch", visible: true },
      { title: L.merge + E, icon: "gitMerge", visible: true },
      { title: L.pullIntoCurrentBranch + E, icon: "repoPull", visible: true },
      { title: L.fetchIntoLocalBranch + E, icon: "download", visible: true },
      { title: L.deleteRemoteBranch + E, icon: "trash", visible: true },
      { title: L.checkRedundancy, icon: undefined, visible: true },
      { title: L.createPullRequest + E, icon: "gitPullRequest", visible: undefined },
      "divider",
      { title: L.copyBranchName, icon: undefined, visible: true }
    ]);
  });

  it('treats the symbolic "<remote>/HEAD" as no branch: no on-remote operations', () => {
    expect(shape(menuFor(remoteBranch("origin/HEAD"), ctxWith()))).toEqual([
      { title: L.checkoutBranch + E, icon: "arrowSwitch", visible: true },
      { title: L.merge + E, icon: "gitMerge", visible: true },
      { title: L.createPullRequest + E, icon: "gitPullRequest", visible: undefined },
      "divider",
      { title: L.copyBranchName, icon: undefined, visible: true }
    ]);
  });

  it("offers the cleanup row, ungated, only on a cleanup candidate", () => {
    const items = shape(menuFor(localBranch("feature"), ctxWith({ isCleanupCandidate: true })));
    const at = items.indexOf(
      items.find((entry) => typeof entry === "object" && entry.title === L.cleanupMenuItem)!
    );
    expect(items[at]).toEqual({ title: L.cleanupMenuItem, icon: "trash", visible: undefined });
    // Between redundancy and create-pull-request, as the side-view orders it.
    expect(items[at - 1]).toMatchObject({ title: L.checkRedundancy });
    expect(items[at + 1]).toMatchObject({ title: L.createPullRequest + E });
  });

  it("adds View Issue right before the copy tail when the name matches issue linking", () => {
    for (const target of [localBranch("fix-#12"), { kind: "tag", name: "v#12" } as RefTarget]) {
      const items = shape(menuFor(target, ctxWith({ issueUrl: "https://example.com/issues/12" })));
      expect(items.slice(-3)).toEqual([
        { title: L.viewIssue, icon: "issue", visible: undefined },
        "divider",
        expect.objectContaining({ visible: true })
      ]);
    }
  });
});

describe("menuFor: visibility gates", () => {
  it("threads each contextMenuActionsVisibility switch onto its item unchanged", () => {
    const cmv = mergeContextMenuActionsVisibility({
      stash: { drop: false },
      branch: { rename: false },
      remoteBranch: { checkRedundancy: false, copyName: false }
    });

    const stashItems = shape(menuFor({ kind: "stash", name: "stash@{0}" }, ctxWith({ cmv })));
    expect(stashItems).toContainEqual({ title: L.stashDrop + E, icon: "trash", visible: false });

    const branchItems = shape(menuFor(localBranch("feature"), ctxWith({ cmv })));
    expect(branchItems).toContainEqual({
      title: L.renameBranch + E,
      icon: "pencil",
      visible: false
    });

    // The shared tail is gated per side: the same items on a remote branch
    // read the remoteBranch switches.
    const remoteItems = shape(menuFor(remoteBranch("origin/feature"), ctxWith({ cmv })));
    expect(remoteItems).toContainEqual({
      title: L.checkRedundancy,
      icon: undefined,
      visible: false
    });
    expect(remoteItems).toContainEqual({
      title: L.copyBranchName,
      icon: undefined,
      visible: false
    });
    const localItems = shape(menuFor(localBranch("feature"), ctxWith({ cmv })));
    expect(localItems).toContainEqual({ title: L.checkRedundancy, icon: undefined, visible: true });
  });

  it("gates every branch item off the catalogue's cmvKey: with every switch off, only the keyless and non-catalogue rows stay", () => {
    // Every branch/remoteBranch setting flipped off. What survives is exactly
    // what the catalogue declares keyless (`cmvKey: null` — fast-forward,
    // create PR) plus the rows outside the catalogue (cleanup, view issue).
    // No branch item is hard-wired `visible: true`; a keyless one has no gate.
    const cmv = mergeContextMenuActionsVisibility({
      branch: allOff(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.branch),
      remoteBranch: allOff(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.remoteBranch)
    });
    const ctx = ctxWith({ cmv, isCleanupCandidate: true, issueUrl: "https://example.com/i/1" });
    const shown = (target: RefTarget) =>
      shape(menuFor(target, ctx))
        .filter((entry) => typeof entry === "object" && entry.visible !== false)
        .map((entry) => (entry as { title: string }).title);

    expect(shown(localBranch("feature"))).toEqual([
      L.fastForwardBranch,
      L.cleanupMenuItem,
      L.createPullRequest + E,
      L.viewIssue
    ]);
    expect(shown(remoteBranch("origin/feature"))).toEqual([
      L.cleanupMenuItem,
      L.createPullRequest + E,
      L.viewIssue
    ]);
    // Every catalogue-keyed item is genuinely gated: none reads a hard-wired
    // value, so nothing else survived.
    for (const target of [localBranch("feature"), remoteBranch("origin/feature")]) {
      const gated = shape(menuFor(target, ctx)).filter(
        (entry) => typeof entry === "object" && entry.visible === true
      );
      expect(gated).toEqual([]);
    }
  });
});

describe("menuFor: action wiring", () => {
  function clickAll(target: RefTarget, ctx: RefMenuContext) {
    for (const item of menuFor(target, ctx)) item?.onClick();
  }

  it("wires every stash item to its stash action", () => {
    const ctx = ctxWith();
    clickAll({ kind: "stash", name: "stash@{0}" }, ctx);
    const a = ctx.actions as ReturnType<typeof stubActions>;
    for (const name of [
      "applyStash",
      "popStash",
      "dropStash",
      "renameStash",
      "copyName"
    ] as const) {
      expect(a[name], name).toHaveBeenCalledTimes(1);
    }
    expect(a.copyName).toHaveBeenCalledWith("Stash Name");
    expect(a.checkout).not.toHaveBeenCalled();
  });

  it("wires the shared items (checkout, merge, copy) per the target's kind", () => {
    const ctx = ctxWith({ isCleanupCandidate: true, issueUrl: "https://example.com/issues/12" });
    clickAll(remoteBranch("origin/feature"), ctx);
    const a = ctx.actions as ReturnType<typeof stubActions>;
    for (const name of [
      "checkout",
      "merge",
      "pull",
      "fetchIntoLocal",
      "deleteRemote",
      "checkRedundancy",
      "cleanupBranches",
      "createPullRequest",
      "viewIssue",
      "copyName"
    ] as const) {
      expect(a[name], name).toHaveBeenCalledTimes(1);
    }
    expect(a.copyName).toHaveBeenCalledWith("Branch Name");
    expect(a.delete).not.toHaveBeenCalled();
    expect(a.rename).not.toHaveBeenCalled();
  });

  it("wires the local-branch items, fast-forward and rebase included", () => {
    const ctx = ctxWith();
    clickAll(localBranch("feature"), ctx);
    const a = ctx.actions as ReturnType<typeof stubActions>;
    for (const name of [
      "checkout",
      "rename",
      "push",
      "createArchive",
      "delete",
      "merge",
      "rebase",
      "fastForward",
      "checkRedundancy",
      "createPullRequest",
      "copyName"
    ] as const) {
      expect(a[name], name).toHaveBeenCalledTimes(1);
    }
    expect(a.pull).not.toHaveBeenCalled();
    expect(a.deleteRemote).not.toHaveBeenCalled();
  });
});
