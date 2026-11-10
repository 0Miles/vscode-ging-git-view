import type { SimpleGit } from "simple-git";

import {
  dropStash,
  renameStash,
  StashMovedError,
  stashSelectorResolvesTo
} from "@ging/core/backend/actions/stash";
import { commitDetails } from "@ging/core/backend/queries/commitDetails";
import { formatGitError } from "@ging/core/backend/utils/gitError";
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

/** Whether two reads list the same stashes at the same places, so the view has
 *  nothing to redraw. */
export function sameStashList(a: StashListItem[], b: StashListItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.id === b[i].id && item.selector === b[i].selector)
  );
}

/**
 * Copy Name on a listed stash: the selector it shows, held to the same identity
 * rule as every stash action (`stashSelectorResolvesTo`). #333: a stash whose
 * position changed is refused, not redirected — it copies nothing, and the
 * user is warned and shown the list as it is now.
 */
export async function copyStashName(
  deps: {
    git: SimpleGit;
    clipboard: Pick<Clipboard, "writeText">;
    prompts: Pick<Prompts, "showWarning">;
    l10n: Pick<L10n, "t">;
    /** Re-read the list. */
    refresh: () => void;
  },
  shown: { hash: string; selector: string }
): Promise<"copied" | "refused"> {
  if (!(await stashSelectorResolvesTo(deps.git, shown.selector, shown.hash))) {
    deps.prompts.showWarning(deps.l10n.t("stashView.stashMoved"));
    deps.refresh();
    return "refused";
  }
  await deps.clipboard.writeText(shown.selector);
  return "copied";
}

/** What drop and rename on a listed stash need from the host: the `Asks`
 *  they put to the user, and the two ways of reporting back. */
type ListedStashDeps<Asks extends keyof Prompts> = {
  git: SimpleGit;
  prompts: Pick<Prompts, Asks | "showWarning" | "showError">;
  l10n: Pick<L10n, "t">;
  /** Re-read the list. */
  refresh: () => void;
};

/** Everything any action on a listed stash needs from the host. */
export type ListedStashHost = ListedStashDeps<"confirm" | "input"> & {
  clipboard: Pick<Clipboard, "writeText">;
};

/**
 * Run a stash action the user agreed to, then re-read the list whatever came
 * of it — even a failed rename may have dropped the old entry. A stash that
 * moved is refused by the action itself (`StashMovedError`, #334) and told
 * apart from git failing: the user is warned, as `copyStashName` warns.
 */
async function runAgreed(
  deps: ListedStashDeps<never>,
  failureKey: string,
  action: () => Promise<void>
): Promise<"done" | "refused" | "failed"> {
  try {
    await action();
    return "done";
  } catch (error) {
    if (error instanceof StashMovedError) {
      deps.prompts.showWarning(deps.l10n.t("stashView.stashMovedNothingDone"));
      return "refused";
    }
    void deps.prompts.showError(deps.l10n.t(failureKey) + ": " + formatGitError(error));
    return "failed";
  } finally {
    deps.refresh();
  }
}

/**
 * Drop on a listed stash. The question names the selector the item shows, and
 * that selector is what the answer agrees to: it is sent as shown, with the
 * SHA the item was listed under, never looked up again. A stash that has moved
 * since — before the menu opened or while the question was up — is refused
 * by `dropStash`, not redirected (#333). Dismissing runs no git.
 */
export async function dropListedStash(
  deps: ListedStashDeps<"confirm">,
  shown: Pick<StashListItem, "hash" | "selector">
): Promise<"dropped" | "cancelled" | "refused" | "failed"> {
  const drop = deps.l10n.t("action.stashDrop");
  const answer = await deps.prompts.confirm(
    deps.l10n.t("dialog.stash.dropConfirm", shown.selector),
    drop
  );
  if (answer !== drop) return "cancelled";
  const outcome = await runAgreed(deps, "error.unableToDropStash", () =>
    dropStash(deps.git, { selector: shown.selector, expectedHash: shown.hash })
  );
  return outcome === "done" ? "dropped" : outcome;
}

/**
 * Rename on a listed stash: a new message for it, starting from the one it
 * has, bound to the item the way `dropListedStash` is. An empty answer
 * cancels, as the graph's rename does; so does an unchanged one, which would
 * only move the stash to the top (`renameStash`) under the same name. No
 * git runs for either.
 */
export async function renameListedStash(
  deps: ListedStashDeps<"input">,
  shown: Pick<StashListItem, "hash" | "selector" | "message">
): Promise<"renamed" | "cancelled" | "refused" | "failed"> {
  const message = (
    await deps.prompts.input({
      prompt: deps.l10n.t("dialog.stash.renameTitle", shown.selector),
      placeholder: "",
      password: false,
      value: shown.message
    })
  )?.trim();
  if (message === undefined || message === "" || message === shown.message) return "cancelled";
  const outcome = await runAgreed(deps, "error.unableToRenameStash", () =>
    renameStash(deps.git, { selector: shown.selector, expectedHash: shown.hash, message })
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
