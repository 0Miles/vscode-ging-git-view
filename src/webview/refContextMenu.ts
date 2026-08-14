/**
 * Content of the graph's ref context menu: which items a ref gets, in what
 * order, with which label, icon, divider and `visible:` gate. The decisions
 * are made from a typed {@link RefTarget} and returned as plain item data, so
 * "what does a remote HEAD's menu offer" is answerable by enumeration in a
 * test. Presentation stays in main.ts: `showContextMenu` renders, positions
 * and drives the keyboard (ADR-0007), and the caller owns the action
 * behaviour behind {@link RefMenuActions}.
 */

import type { ContextMenuActionsVisibility } from "@/types";

import { ELLIPSIS, splitDisplayRemoteRef } from "./utils/git";

/**
 * What the menu was raised on, classified once at the DOM boundary. `kind`
 * mirrors the ref chip's class (`stash` / `tag` / `head` / `remote`); `name`
 * is the display ref, exactly as the chip's label spells it (CONTEXT.md,
 * "Ref 的兩種形") — so a remote branch is "origin/main", and the symbolic
 * "origin/HEAD" is recognised from the name itself.
 *
 * That guide bans display refs as inputs because the bare name loses the
 * local/remote distinction. Exempt here: the chip's `dataset.name` is already
 * display-form, and the `kind` discriminant carries the identity the
 * `remotes/` prefix would have — a local branch literally named "origin/main"
 * still arrives as `kind: "branch"`.
 */
export type RefTarget =
  | { kind: "stash"; name: string }
  | { kind: "tag"; name: string }
  | { kind: "branch"; name: string; isHead: boolean }
  | { kind: "remoteBranch"; name: string };

/**
 * What each menu item does when activated. The caller binds every callback to
 * the target ref (and to whatever DOM anchor its dialog wants) before asking
 * for the menu; `menuFor` only wires them onto items. Names follow
 * REF_ACTION_CATALOGUE where the action exists there, so the two vocabularies
 * stay one.
 */
export interface RefMenuActions {
  applyStash(): void;
  popStash(): void;
  dropStash(): void;
  renameStash(): void;
  viewTagDetails(): void;
  deleteTag(): void;
  pushTag(): void;
  /** Check out the target branch — local or remote per the target's kind. */
  checkout(): void;
  rename(): void;
  push(): void;
  createArchive(): void;
  delete(): void;
  merge(): void;
  rebase(): void;
  fastForward(): void;
  pull(): void;
  fetchIntoLocal(): void;
  deleteRemote(): void;
  checkRedundancy(): void;
  cleanupBranches(): void;
  createPullRequest(): void;
  viewIssue(): void;
  /** Copy the ref's name; `type` is the wire label `copyNameSpec` chose for
   *  the kind, handed straight to the `copyToClipboard` message. */
  copyName(type: RefCopyType): void;
}

/** The `copyToClipboard` message's label for what was copied, per ref kind. */
export type RefCopyType = "Stash Name" | "Tag Name" | "Branch Name";

/** The view-state facts the content decisions read, besides the target. */
export interface RefMenuContext {
  /** The per-action `contextMenuActionsVisibility` switches, already merged
   *  over the defaults. Threaded onto each item's `visible:` gate unchanged —
   *  the item is still built, `showContextMenu` drops it (#51 will re-source
   *  these from the catalogue's `cmvKey`). */
  cmv: ContextMenuActionsVisibility;
  /** Whether the repo has any remotes — gates push branch/tag and create PR. */
  hasRemotes: boolean;
  /** Whether the target branch is itself a cleanup candidate (ADR-0014). */
  isCleanupCandidate: boolean;
  /** First issue URL matched in the ref's name (`firstIssueUrl`), or null. */
  issueUrl: string | null;
  actions: RefMenuActions;
}

/**
 * Build a ref's context menu as data. A `null` entry is a divider;
 * `showContextMenu` collapses dividers orphaned by `visible: false` items.
 *
 * Invariant, inherited from `showContextMenu`: every `title` is rendered into
 * the menu's innerHTML **unescaped** (that is how the ELLIPSIS entity gets
 * through), so titles must stay trusted l10n strings — never the ref's name
 * or any other repository-controlled text.
 */
export function menuFor(target: RefTarget, ctx: RefMenuContext): ContextMenuElement[] {
  const { cmv, actions } = ctx;
  const menu: ContextMenuElement[] = [];
  switch (target.kind) {
    case "stash":
      // Stash refs aren't branches/tags — offer stash-specific actions.
      menu.push(
        {
          title: l10n.stashApply + ELLIPSIS,
          visible: cmv.stash.apply,
          onClick: actions.applyStash
        },
        { title: l10n.stashPop + ELLIPSIS, visible: cmv.stash.pop, onClick: actions.popStash },
        {
          title: l10n.stashDrop + ELLIPSIS,
          icon: "trash",
          visible: cmv.stash.drop,
          onClick: actions.dropStash
        },
        {
          title: l10n.stashRename + ELLIPSIS,
          icon: "pencil",
          visible: true,
          onClick: actions.renameStash
        }
      );
      break;
    case "tag":
      menu.push(
        {
          title: l10n.viewTagDetails + ELLIPSIS,
          visible: cmv.tag.viewDetails,
          onClick: actions.viewTagDetails
        },
        {
          title: l10n.createArchive + ELLIPSIS,
          visible: cmv.tag.createArchive,
          onClick: actions.createArchive
        },
        {
          title: l10n.deleteTag + ELLIPSIS,
          icon: "trash",
          visible: cmv.tag.delete,
          onClick: actions.deleteTag
        }
      );
      if (ctx.hasRemotes) {
        menu.push({
          title: l10n.pushTag + ELLIPSIS,
          icon: "repoPush",
          visible: cmv.tag.push,
          onClick: actions.pushTag
        });
      }
      break;
    case "branch":
      if (!target.isHead) {
        menu.push({
          title: l10n.checkoutBranch,
          icon: "arrowSwitch",
          visible: cmv.branch.checkout,
          onClick: actions.checkout
        });
      }
      menu.push({
        title: l10n.renameBranch + ELLIPSIS,
        icon: "pencil",
        visible: cmv.branch.rename,
        onClick: actions.rename
      });
      if (ctx.hasRemotes) {
        menu.push({
          title: l10n.pushBranch + ELLIPSIS,
          icon: "repoPush",
          visible: cmv.branch.push,
          onClick: actions.push
        });
      }
      menu.push({
        title: l10n.createArchive + ELLIPSIS,
        visible: cmv.branch.createArchive,
        onClick: actions.createArchive
      });
      if (!target.isHead) {
        menu.push(
          {
            title: l10n.deleteBranch + ELLIPSIS,
            icon: "trash",
            visible: cmv.branch.delete,
            onClick: actions.delete
          },
          {
            title: l10n.merge + ELLIPSIS,
            icon: "gitMerge",
            visible: cmv.branch.merge,
            onClick: actions.merge
          },
          {
            title: l10n.rebaseOnBranch + ELLIPSIS,
            icon: "rebase",
            visible: cmv.branch.rebase,
            onClick: actions.rebase
          },
          {
            title: l10n.fastForwardBranch,
            icon: "moveToEnd",
            visible: true,
            onClick: actions.fastForward
          }
        );
      }
      pushBranchCommonTail(menu, target, ctx, true);
      break;
    case "remoteBranch": {
      // Remote branch refs are "<remote>/<branch>". The symbolic
      // "<remote>/HEAD" is not a branch: it gets neither the on-remote
      // operations nor the common tail's redundancy check.
      const isBranch = splitDisplayRemoteRef(target.name) !== null;
      menu.push(
        {
          title: l10n.checkoutBranch + ELLIPSIS,
          icon: "arrowSwitch",
          visible: cmv.remoteBranch.checkout,
          onClick: actions.checkout
        },
        {
          title: l10n.merge + ELLIPSIS,
          icon: "gitMerge",
          visible: cmv.remoteBranch.merge,
          onClick: actions.merge
        }
      );
      if (isBranch) {
        menu.push(
          {
            title: l10n.pullIntoCurrentBranch + ELLIPSIS,
            icon: "repoPull",
            visible: cmv.remoteBranch.pull,
            onClick: actions.pull
          },
          {
            title: l10n.fetchIntoLocalBranch + ELLIPSIS,
            icon: "download",
            visible: cmv.remoteBranch.fetch,
            onClick: actions.fetchIntoLocal
          },
          {
            title: l10n.deleteRemoteBranch + ELLIPSIS,
            icon: "trash",
            visible: cmv.remoteBranch.delete,
            onClick: actions.deleteRemote
          }
        );
      }
      pushBranchCommonTail(menu, target, ctx, isBranch);
      break;
    }
  }
  if (ctx.issueUrl !== null) {
    menu.push({ title: l10n.viewIssue, icon: "issue", onClick: ctx.actions.viewIssue });
  }
  const copy = copyNameSpec(target, cmv);
  menu.push(null, {
    title: copy.title,
    visible: copy.visible,
    onClick: () => actions.copyName(copy.type)
  });
  return menu;
}

/** The trailing copy item's label, gate and wire label, per kind — the one
 *  place that decides what "copy this ref's name" is called. */
function copyNameSpec(
  target: RefTarget,
  cmv: ContextMenuActionsVisibility
): { title: string; visible: boolean; type: RefCopyType } {
  switch (target.kind) {
    case "stash":
      return { title: l10n.copyStashName, visible: cmv.stash.copyName, type: "Stash Name" };
    case "tag":
      return { title: l10n.copyTagName, visible: cmv.tag.copyName, type: "Tag Name" };
    case "branch":
      return { title: l10n.copyBranchName, visible: cmv.branch.copyName, type: "Branch Name" };
    case "remoteBranch":
      return {
        title: l10n.copyBranchName,
        visible: cmv.remoteBranch.copyName,
        type: "Branch Name"
      };
  }
}

/** The items every branch menu ends with, local or remote. `isBranch` is
 *  false only for the symbolic "<remote>/HEAD" ref; a local target is always
 *  a branch. */
function pushBranchCommonTail(
  menu: ContextMenuElement[],
  target: Extract<RefTarget, { kind: "branch" | "remoteBranch" }>,
  ctx: RefMenuContext,
  isBranch: boolean
) {
  const isRemote = target.kind === "remoteBranch";
  // Offered on every branch — including the checked-out one and the default
  // branch itself — but not on the symbolic "<remote>/HEAD", which is not a
  // branch, matching the remote actions above.
  if (isBranch) {
    menu.push({
      title: l10n.checkRedundancy,
      visible: isRemote ? ctx.cmv.remoteBranch.checkRedundancy : ctx.cmv.branch.checkRedundancy,
      onClick: ctx.actions.checkRedundancy
    });
  }
  // Offered only when this branch is itself a cleanup candidate — the same
  // rule the side-view's menu uses (ADR-0014). The dialog it opens ignores
  // which branch was clicked; the row is the affordance, not the target.
  if (ctx.isCleanupCandidate) {
    menu.push({ title: l10n.cleanupMenuItem, icon: "trash", onClick: ctx.actions.cleanupBranches });
  }
  // Create a pull request from this branch on its remote.
  if (ctx.hasRemotes) {
    menu.push({
      title: l10n.createPullRequest + ELLIPSIS,
      icon: "gitPullRequest",
      onClick: ctx.actions.createPullRequest
    });
  }
}
