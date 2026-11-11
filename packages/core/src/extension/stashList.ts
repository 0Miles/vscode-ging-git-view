import type { SimpleGit } from "simple-git";

import {
  applyStash,
  dropStash,
  popStash,
  renameStash,
  StashApplyError,
  StashMovedError,
  stashSelectorResolvesTo
} from "@ging/core/backend/actions/stash";
import { commitDetails } from "@ging/core/backend/queries/commitDetails";
import { listStashes } from "@ging/core/backend/queries/listStashes";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import { confirm } from "@ging/core/extension/commandKit";
import type { CommitDiffRequest } from "@ging/core/extension/commitDiff";
import type { Clipboard, L10n, Prompts } from "@ging/core/host/ports";
import type { GitFileChangeType, ScmStashEntry } from "@ging/shared/backend/types";

/** One stash as the Stash side-view lists it. */
export type StashListItem = {
  /** Unique within the list, and the same across re-reads while the stash
   *  lasts: its SHA, since its selector moves whenever a stash above it is
   *  pushed or dropped. */
  id: string;
  hash: string;
  /** Where it sits now, e.g. `stash@{0}`. */
  selector: string;
  /** Its subject, as the graph labels it. */
  message: string;
  /** Unix seconds; null when git gave none. */
  date: number | null;
};

/**
 * The Stash side-view's items, newest first as git lists them. An item is the
 * stash's SHA. `git stash store` can put one commit in the stash twice, and a
 * tree view refuses two items with one id, so a repeat is told apart by how
 * many of it came before.
 */
export function stashListItems(stashes: ScmStashEntry[]): StashListItem[] {
  const seen = new Map<string, number>();
  return stashes.map(({ hash, ref, message, date }) => {
    const repeat = seen.get(hash) ?? 0;
    seen.set(hash, repeat + 1);
    return {
      id: repeat === 0 ? hash : `${hash}#${repeat}`,
      hash,
      selector: ref,
      message,
      date
    };
  });
}

/** The Stash side-view's items as `git stash list` has them now; none when git
 *  can't list them. */
export async function loadStashList(git: SimpleGit): Promise<StashListItem[]> {
  return stashListItems(await listStashes(git));
}

/** Whether two reads list the same stashes at the same places, so the view has
 *  nothing to redraw. */
export function sameStashList(a: StashListItem[], b: StashListItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.id === b[i].id && item.selector === b[i].selector)
  );
}

/** What an action on a listed stash needs from the host. */
export type ListedStashHost = {
  git: SimpleGit;
  clipboard: Pick<Clipboard, "writeText">;
  prompts: Pick<Prompts, "choose" | "input" | "showWarning" | "showError">;
  l10n: Pick<L10n, "t">;
  /** Re-read the list. */
  refresh: () => void;
};

/** #333: a stash whose position changed is refused, not redirected — the user
 *  is warned and shown the list as it is now. */
function refuseMoved(host: ListedStashHost): "refused" {
  host.prompts.showWarning(host.l10n.t("stashView.stashMoved"));
  host.refresh();
  return "refused";
}

/**
 * Run a stash action the user agreed to, then re-read the list whatever came
 * of it — even a failed rename may have dropped the old entry. A moved stash
 * is refused by the action itself (`StashMovedError`, #334); an apply or pop
 * that did not go through says why (`StashApplyError`, #337).
 */
async function runAgreed<Failed extends string>(
  host: ListedStashHost,
  action: () => Promise<void>,
  /** Tells the user why the action failed; resolves to what that came to. */
  report: (error: unknown) => Failed
): Promise<"done" | "refused" | Failed> {
  try {
    await action();
  } catch (error) {
    if (error instanceof StashMovedError) return refuseMoved(host);
    const outcome = report(error);
    host.refresh();
    return outcome;
  }
  host.refresh();
  return "done";
}

/** Reports a failure as git's, under `failureKey`. */
const reportGitFailure =
  (host: ListedStashHost, failureKey: string) =>
  (error: unknown): "failed" => {
    void host.prompts.showError(host.l10n.t(failureKey) + ": " + formatGitError(error));
    return "failed";
  };

/** Reports an apply or pop that did not go through (`StashApplyFailure`), in
 *  the words the graph uses for it too (`handleStashResponse`). */
const reportApplyFailure =
  (host: ListedStashHost, failureKey: string) =>
  (error: unknown): "refused" | "conflicted" | "failed" => {
    const { t } = host.l10n;
    const failure = error instanceof StashApplyError ? error.failure : null;
    switch (failure?.kind) {
      case "unmergedBefore":
        host.prompts.showWarning(t("stashApply.unmergedBefore"));
        return "refused";
      case "conflicted":
        host.prompts.showWarning(
          failure.keptAs === null
            ? t("stashApply.conflictedUnlisted")
            : t("stashApply.conflicted", failure.keptAs)
        );
        return "conflicted";
      case "unchanged":
        void host.prompts.showError(
          t(failureKey) + ": " + t("stashApply.unchanged") + " " + formatGitError(error)
        );
        return "failed";
      case undefined:
        return reportGitFailure(host, failureKey)(error);
    }
  };

/** Copy Name on a listed stash: the selector it shows, if it still names the
 *  stash listed there (`stashSelectorResolvesTo`). */
export async function copyStashName(
  host: ListedStashHost,
  shown: Pick<StashListItem, "hash" | "selector">
): Promise<"copied" | "refused"> {
  if (!(await stashSelectorResolvesTo(host.git, shown.selector, shown.hash))) {
    return refuseMoved(host);
  }
  await host.clipboard.writeText(shown.selector);
  return "copied";
}

/**
 * Drop on a listed stash, after a question naming its selector. That selector
 * is what the answer agrees to, so it is sent as shown with the listed SHA and
 * never looked up again: a stash that moved since is refused, not redirected.
 */
export async function dropListedStash(
  host: ListedStashHost,
  shown: Pick<StashListItem, "hash" | "selector">
): Promise<"dropped" | "cancelled" | "refused" | "failed"> {
  const agreed = await confirm(
    host.prompts,
    host.l10n.t("dialog.stash.dropConfirm", shown.selector),
    host.l10n.t("action.stashDrop")
  );
  if (!agreed) return "cancelled";
  const outcome = await runAgreed(
    host,
    () => dropStash(host.git, { selector: shown.selector, expectedHash: shown.hash }),
    reportGitFailure(host, "error.unableToDropStash")
  );
  return outcome === "done" ? "dropped" : outcome;
}

/** What apply and pop each ask with and run; the keys spelled out, so each
 *  can be found and checked. */
const APPLY_OR_POP = {
  apply: {
    run: applyStash,
    question: "dialog.stash.applyConfirm",
    plain: "dialog.stash.apply",
    reinstateIndex: "dialog.stash.applyReinstateIndex",
    failure: "error.unableToApplyStash"
  },
  pop: {
    run: popStash,
    question: "dialog.stash.popConfirm",
    plain: "dialog.stash.pop",
    reinstateIndex: "dialog.stash.popReinstateIndex",
    failure: "error.unableToPopStash"
  }
} as const;

/**
 * The two ways to say yes to an apply or pop, in the order the modal shows
 * them, each answering the `reinstateIndex` it stands for. The plain one comes
 * first: it is what the graph's form sends with its box unticked (ADR-0029).
 */
export function applyOrPopActions(
  l10n: Pick<L10n, "t">,
  mode: "apply" | "pop"
): { label: string; value: boolean }[] {
  const keys = APPLY_OR_POP[mode];
  return [
    { label: l10n.t(keys.plain), value: false },
    { label: l10n.t(keys.reinstateIndex), value: true }
  ];
}

/** Apply or pop on a listed stash, bound like `dropListedStash`. The
 *  side-view neither reads nor writes the graph's remembered choice
 *  (`dialogMemory`). */
export async function applyOrPopListedStash(
  host: ListedStashHost,
  shown: Pick<StashListItem, "hash" | "selector">,
  mode: "apply" | "pop"
): Promise<"done" | "cancelled" | "refused" | "conflicted" | "failed"> {
  const { t } = host.l10n;
  const { run, question, failure } = APPLY_OR_POP[mode];
  const reinstateIndex = await host.prompts.choose(t(question, shown.selector), {
    detail: t("dialog.stash.reinstateIndexDetail"),
    actions: applyOrPopActions(host.l10n, mode)
  });
  if (reinstateIndex === undefined) return "cancelled";
  return runAgreed(
    host,
    () => run(host.git, { selector: shown.selector, expectedHash: shown.hash, reinstateIndex }),
    reportApplyFailure(host, failure)
  );
}

/** Rename on a listed stash, bound like `dropListedStash`. An empty or
 *  unchanged answer cancels: the unchanged one would only move it to the top. */
export async function renameListedStash(
  host: ListedStashHost,
  shown: Pick<StashListItem, "hash" | "selector" | "message">
): Promise<"renamed" | "cancelled" | "refused" | "failed"> {
  const message = (
    await host.prompts.input({
      prompt: host.l10n.t("dialog.stash.renameTitle", shown.selector),
      value: shown.message
    })
  )?.trim();
  if (message === undefined || message === "" || message === shown.message) return "cancelled";
  const outcome = await runAgreed(
    host,
    () => renameStash(host.git, { selector: shown.selector, expectedHash: shown.hash, message }),
    reportGitFailure(host, "error.unableToRenameStash")
  );
  return outcome === "done" ? "renamed" : outcome;
}

/** One file of an expanded stash. */
export type StashFile = {
  /** The file's name, without its folder. */
  name: string;
  /** Its folder, repository-relative with `/`; empty at the top. */
  dir: string;
  /** How the stash changed it: git's letter, or `U` for a file that was
   *  untracked when stashed. */
  badge: GitFileChangeType | "U";
  /** The diff to open for it. */
  diff: CommitDiffRequest;
};

/**
 * The files a stash changed, read from the stash commit the way the graph's
 * commit details read it: its tracked files against its first parent (the
 * commit it was made on) and its untracked ones from its third parent. Diffing
 * each is `commitDiffView`'s to say — the stash's base against the stash for a
 * tracked file, nothing against the third parent for an untracked one. What
 * only the index (`stash^2`) changed is not among them. Null when the stash
 * can't be read.
 */
export async function loadStashFiles(
  git: SimpleGit,
  repo: string,
  hash: string
): Promise<StashFile[] | null> {
  const { commitDetails: details } = await commitDetails(git, {
    commitHash: hash,
    useMailmap: false,
    isStash: true
  });
  if (details === null) return null;
  return details.fileChanges.map(({ oldFilePath, newFilePath, type, origin }) => {
    const slash = newFilePath.lastIndexOf("/");
    return {
      name: newFilePath.slice(slash + 1),
      dir: slash === -1 ? "" : newFilePath.slice(0, slash),
      badge: origin === "untracked" ? "U" : type,
      diff: { repo, commitHash: hash, oldFilePath, newFilePath, type, origin }
    };
  });
}
