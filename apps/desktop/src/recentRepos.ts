/* The recently opened list (#394): on the desktop host, the known repositories
 * are what the user opened, initialized or named on a command line
 * (GLOSSARY.md), so the list is that set — the `RepoSource`'s, nothing kept
 * beside it — in the order it was last opened in. Only the order is this
 * module's, kept in `HostStorage`'s workspace tier beside the set itself, and
 * what was last found of each folder on disk. */

import path from "node:path";

import { isUsableRepoPathAsync } from "@ging/core/backend/utils/repoPath";
import type { StateStore } from "@ging/core/host/ports";
import type { DesktopRepoSource } from "@ging/desktop/ports/repoSource";
import type { RecentRepoEntry } from "@ging/webview/desktop/window/protocol";

/** Its key in the workspace tier, beside core's known repositories. */
const KEY = "desktopRecentRepos";

/**
 * How many the list shows, and how many it keeps an order for: about what
 * the Welcome page fits in a window of the app's first size without
 * scrolling, and a bound on the folders looked at on disk each time it shows.
 * A repository past it stays known — its custom name and the graph's state
 * for it are there for when it is opened again, which puts it first — it is
 * only not listed.
 */
export const RECENT_REPOS_SHOWN = 20;

export type RecentRepos = {
  /** `repo`, as the known set spells it, was opened: first in the list now. */
  opened(repo: string): void;
  /** The known repositories, the one opened last first; those never opened
   *  since the list began keeping an order go last, in path order; no more
   *  than `RECENT_REPOS_SHOWN`. A repository whose folder was not there when
   *  last looked at (`check`) is listed, and marked. */
  list(): RecentRepoEntry[];
  /** Look at each listed folder on disk again, without holding the caller:
   *  a folder that does not answer (a network share gone away) is left as it
   *  was found last until it does. Told through `onChange` when any is found
   *  otherwise than before. */
  check(): void;
  /** Take `repo` off the list: out of the known set, and of the order. */
  forget(repo: string): void;
  dispose(): void;
};

type RecentReposDeps = {
  store: StateStore;
  repoSource: Pick<DesktopRepoSource, "getRepos" | "dropRepo" | "onDidChangeRepos">;
  /** Whether a folder is there to open: `resolveCurrentRepo`'s test, the one
   *  a Current repository is held to (GLOSSARY.md's Known repository). */
  isUsable?: (folder: string) => Promise<boolean>;
  /** What `check` found differs from what `list` said. */
  onChange?: () => void;
};

export function createRecentRepos({
  store,
  repoSource,
  isUsable = isUsableRepoPathAsync,
  onChange = () => {}
}: RecentReposDeps): RecentRepos {
  /** The order kept, each entry once; anything else there (a later
   *  version's, say) is no order at all. */
  const kept = (): string[] => {
    const value = store.get<unknown>(KEY, []);
    return Array.isArray(value)
      ? [...new Set(value.filter((p): p is string => typeof p === "string"))]
      : [];
  };
  const keep = (order: string[]) => void store.update(KEY, order.slice(0, RECENT_REPOS_SHOWN));
  /** Folders found not there when last looked at. */
  const missing = new Set<string>();
  /** Folders being looked at now: one look at a time each. */
  const looking = new Set<string>();

  const listed = (): string[] => {
    const known = repoSource.getRepos();
    const ordered = kept().filter((p) => Object.hasOwn(known, p));
    const rest = Object.keys(known).filter((p) => !ordered.includes(p));
    return [...ordered, ...rest].slice(0, RECENT_REPOS_SHOWN);
  };

  // A repository that leaves the set leaves the order, whatever dropped it.
  const changed = repoSource.onDidChangeRepos((repos) => {
    const order = kept();
    if (order.some((p) => !Object.hasOwn(repos, p))) {
      keep(order.filter((p) => Object.hasOwn(repos, p)));
    }
    for (const p of missing) if (!Object.hasOwn(repos, p)) missing.delete(p);
  });

  return {
    opened: (repo) => {
      const known = repoSource.getRepos();
      keep([repo, ...kept().filter((p) => p !== repo && Object.hasOwn(known, p))]);
    },
    list: () => {
      const known = repoSource.getRepos();
      return listed().map((p) => ({
        path: p,
        name: known[p].customName || path.basename(p),
        missing: missing.has(p)
      }));
    },
    check: () => {
      for (const folder of listed()) {
        if (looking.has(folder)) continue;
        looking.add(folder);
        void isUsable(folder).then((usable) => {
          looking.delete(folder);
          if (usable === !missing.has(folder)) return;
          if (usable) missing.delete(folder);
          else missing.add(folder);
          onChange();
        });
      }
    },
    forget: (repo) => {
      repoSource.dropRepo(repo);
      keep(kept().filter((p) => p !== repo));
    },
    dispose: () => changed.dispose()
  };
}
