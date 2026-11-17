import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@ging/shared/backend/utils/contextMenuVisibility";
import {
  CATALOGUE_REF_ACTIONS,
  type CatalogueRefAction,
  REF_ACTION_CATALOGUE
} from "@ging/shared/backend/utils/refActionCatalogue";
import type { BatchAction, ContextMenuActionsVisibility } from "@ging/shared/types";
import {
  batchActionApplies,
  batchBranchMenu,
  type BranchMenuContext,
  singleActionApplies,
  singleBranchMenu
} from "@ging/webview/desktop/sideViews/branchMenu";

import { englishStrings } from "./setup";

// The desktop Branches view's menus (#399) are derived from the shared action
// catalogue (ADR-0010) rather than declared per row, as VS Code's package.json
// when-clauses are. These pin the derivation: each fact of the catalogue the
// menu reads, and that it reads them for every action.

const cmv = DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY;
const withRemotes: BranchMenuContext = { cmv, hasRemotes: true };

const local = { isRemote: false, isHead: false, isCleanupCandidate: false };
const head = { isRemote: false, isHead: true, isCleanupCandidate: false };
const remote = { isRemote: true, isHead: false, isCleanupCandidate: false };

/** The actions a row's menu offers, by running each item and seeing which
 *  action it asked for. */
function offered(row: typeof local, ctx: BranchMenuContext = withRemotes): CatalogueRefAction[] {
  const ran: CatalogueRefAction[] = [];
  for (const item of singleBranchMenu(row, ctx, { run: (a) => ran.push(a), cleanup: () => {} })) {
    item?.onClick();
  }
  return ran;
}

function batchOffered(ctx: BranchMenuContext = withRemotes): BatchAction[] {
  const ran: BatchAction[] = [];
  const labels = { delete: "d", push: "p", fastForward: "f", copyName: "c" };
  for (const item of batchBranchMenu(ctx, labels, (a) => ran.push(a))) item?.onClick();
  return ran;
}

function hiding(
  category: "branch" | "remoteBranch",
  key: string
): Pick<ContextMenuActionsVisibility, "branch" | "remoteBranch"> {
  return { ...cmv, [category]: { ...cmv[category], [key]: false } };
}

beforeAll(() => {
  (globalThis as unknown as { l10n: unknown }).l10n = englishStrings();
});

describe("the desktop Branches view's menu", () => {
  it("offers every catalogue action on some row", () => {
    const anywhere = new Set([...offered(local), ...offered(head), ...offered(remote)]);
    expect([...anywhere].toSorted()).toEqual([...CATALOGUE_REF_ACTIONS].toSorted());
  });

  it("offers an action only on the kind of branch the catalogue says it takes", () => {
    for (const action of offered(local)) {
      expect(REF_ACTION_CATALOGUE[action].refKinds, action).not.toBe("remote");
    }
    for (const action of offered(remote)) {
      expect(REF_ACTION_CATALOGUE[action].refKinds, action).not.toBe("local");
    }
  });

  it("leaves the head-guarded actions off the checked-out branch, and runs none of them there", () => {
    const guarded = CATALOGUE_REF_ACTIONS.filter((a) => REF_ACTION_CATALOGUE[a].headGuard);
    expect(guarded.length).toBeGreaterThan(0);
    expect(offered(head).filter((a) => guarded.includes(a))).toEqual([]);
    for (const action of guarded) {
      // The guard the side view runs an action through, silently.
      expect(singleActionApplies(action, head, withRemotes), action).toBe(false);
      expect(singleActionApplies(action, local, withRemotes), action).toBe(true);
    }
  });

  it("spells a remote branch's delete as deleteRemote, as VS Code's menu does", () => {
    expect(offered(remote)).toContain("deleteRemote");
    expect(offered(remote)).not.toContain("delete");
    expect(offered(local)).toContain("delete");
  });

  it("offers what needs a remote only when the repository has one", () => {
    const needing = CATALOGUE_REF_ACTIONS.filter((a) => REF_ACTION_CATALOGUE[a].needsRemotes);
    const without = { cmv, hasRemotes: false };
    expect(offered(local, without).filter((a) => needing.includes(a))).toEqual([]);
    expect(
      offered(local)
        .filter((a) => needing.includes(a))
        .toSorted()
    ).toEqual([...needing].toSorted());
  });

  it("hides what a visibility setting hides, on that kind of branch only", () => {
    expect(offered(local, { cmv: hiding("branch", "rename"), hasRemotes: true })).not.toContain(
      "rename"
    );
    const noRemoteCheckout = { cmv: hiding("remoteBranch", "checkout"), hasRemotes: true };
    expect(offered(remote, noRemoteCheckout)).not.toContain("checkout");
    expect(offered(local, noRemoteCheckout)).toContain("checkout");
  });

  it("offers the cleanup dialog on a row that is itself a candidate", () => {
    let cleaned = 0;
    const menu = singleBranchMenu({ ...local, isCleanupCandidate: true }, withRemotes, {
      run: () => {},
      cleanup: () => cleaned++
    });
    menu.find((item) => item?.title === englishStrings().cleanupMenuItem)?.onClick();
    expect(cleaned).toBe(1);
    expect(
      singleBranchMenu(local, withRemotes, { run: () => {}, cleanup: () => {} }).some(
        (item) => item?.title === englishStrings().cleanupMenuItem
      )
    ).toBe(false);
  });

  it("separates the groups with one divider each, never two in a row or at an end", () => {
    const menu = singleBranchMenu(local, withRemotes, { run: () => {}, cleanup: () => {} });
    expect(menu[0]).not.toBeNull();
    expect(menu.at(-1)).not.toBeNull();
    expect(menu.some((item, i) => item === null && menu[i + 1] === null)).toBe(false);
  });
});

describe("the desktop Branches view's menu on a multi-selection", () => {
  it("offers the batch actions alone", () => {
    expect(batchOffered().toSorted()).toEqual(
      CATALOGUE_REF_ACTIONS.filter((a) => REF_ACTION_CATALOGUE[a].batch).toSorted()
    );
  });

  it("drops push without a remote, and delete only once both of its settings hide it", () => {
    expect(batchOffered({ cmv, hasRemotes: false })).not.toContain("push");
    expect(
      batchActionApplies("delete", { cmv: hiding("branch", "delete"), hasRemotes: true })
    ).toBe(true);
    const neither = {
      ...cmv,
      branch: { ...cmv.branch, delete: false },
      remoteBranch: { ...cmv.remoteBranch, delete: false }
    };
    expect(batchActionApplies("delete", { cmv: neither, hasRemotes: true })).toBe(false);
    // No setting at all: always shown.
    expect(batchActionApplies("fastForward", { cmv: neither, hasRemotes: false })).toBe(true);
  });
});
