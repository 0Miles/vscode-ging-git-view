import type { SimpleGit } from "simple-git";

import { stashSelectorResolvesTo } from "@ging/core/backend/actions/stash";
import { commitDetails } from "@ging/core/backend/queries/commitDetails";
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
