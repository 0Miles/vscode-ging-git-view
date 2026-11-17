/* The recently opened list (#394): on the desktop host, the known repositories
 * are what the user opened, initialized or named on a command line
 * (GLOSSARY.md), so the list is that set — the `RepoSource`'s, nothing kept
 * beside it — in the order it was last opened in. Only the order is this
 * module's, kept in `HostStorage`'s workspace tier beside the set itself. */

import path from "node:path";

import { isUsableRepoPath, resolveCurrentRepo } from "@ging/core/backend/utils/repoPath";
import type { StateStore } from "@ging/core/host/ports";
import type { DesktopRepoSource } from "@ging/desktop/ports/repoSource";
import type { RecentRepoEntry } from "@ging/webview/desktop/window/protocol";

/** Its key in the workspace tier, beside core's known repositories. */
const KEY = "desktopRecentRepos";

export type RecentRepos = {
  /** `repo`, as the known set spells it, was opened: first in the list now. */
  opened(repo: string): void;
  /** The known repositories, the one opened last first; those never opened
   *  since the list began keeping an order go last, in path order. A
   *  repository whose folder is not there is listed, and marked. */
  list(): RecentRepoEntry[];
  /** Take `repo` off the list: out of the known set, and of the order. */
  forget(repo: string): void;
};

type RecentReposDeps = {
  store: StateStore;
  repoSource: Pick<DesktopRepoSource, "getRepos" | "dropRepo">;
  /** Whether a folder is there to open: `resolveCurrentRepo`'s test, the one
   *  a Current repository is held to (GLOSSARY.md's Known repository). */
  isUsable?: (folder: string) => boolean;
};

export function createRecentRepos({
  store,
  repoSource,
  isUsable = isUsableRepoPath
}: RecentReposDeps): RecentRepos {
  /** The order kept, each entry once; anything else there (a later
   *  version's, say) is no order at all. */
  const kept = (): string[] => {
    const value = store.get<unknown>(KEY, []);
    return Array.isArray(value)
      ? [...new Set(value.filter((p): p is string => typeof p === "string"))]
      : [];
  };
  const keep = (order: string[]) => void store.update(KEY, order);

  return {
    opened: (repo) => {
      const known = repoSource.getRepos();
      keep([repo, ...kept().filter((p) => p !== repo && Object.hasOwn(known, p))]);
    },
    list: () => {
      const known = repoSource.getRepos();
      const ordered = kept().filter((p) => Object.hasOwn(known, p));
      const rest = Object.keys(known).filter((p) => !ordered.includes(p));
      return [...ordered, ...rest].map((p) => ({
        path: p,
        name: known[p].customName || path.basename(p),
        missing: resolveCurrentRepo(p, isUsable) === null
      }));
    },
    forget: (repo) => {
      repoSource.dropRepo(repo);
      keep(kept().filter((p) => p !== repo));
    }
  };
}
