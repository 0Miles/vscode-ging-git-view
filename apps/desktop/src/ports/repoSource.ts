/* The desktop `RepoSource` (`@ging/core/host/ports`): the known repositories
 * (`GLOSSARY.md`; on the desktop host, the recently opened list) kept through
 * core's ExtensionState, as the VS Code host's RepoManager keeps them, and
 * broadcast to whatever shows them. */

import * as fs from "node:fs";

import {
  applyExternalConfig,
  EXTERNAL_CONFIG_RELATIVE_PATH,
  parseExternalConfig
} from "@ging/core/backend/utils/externalConfig";
import { isGitRepository } from "@ging/core/backend/utils/git";
import { evalPromises } from "@ging/core/backend/utils/promise";
import { pickBootRepo, REPO_EXISTENCE_CHECKS_AT_ONCE } from "@ging/core/backend/utils/repoPath";
import type { ExtensionState } from "@ging/core/extensionState";
import type { RepoSource } from "@ging/core/host/ports";
import type { GitRepoSet, GitRepoState } from "@ging/shared/types";

export type DesktopRepoSource = RepoSource & {
  /** Know `repo` from now on — the user opened it — and broadcast the set. A
   *  repository already known keeps its state. A new one starts from the
   *  team's shared settings committed in it, if any. */
  addRepo(repo: string): void;
  /** Hear every broadcast of the set; what shows it registers here. */
  onDidChangeRepos(listener: (repos: GitRepoSet) => void): { dispose(): void };
};

function sorted(repos: GitRepoSet): GitRepoSet {
  return Object.fromEntries(
    Object.keys(repos)
      .toSorted()
      .map((repo) => [repo, repos[repo]])
  );
}

/** The team's shared settings committed in `repo`, or null for none. */
function readSharedSettings(repo: string) {
  try {
    return parseExternalConfig(fs.readFileSync(`${repo}/${EXTERNAL_CONFIG_RELATIVE_PATH}`, "utf8"));
  } catch {
    return null;
  }
}

export function createDesktopRepoSource(
  extensionState: Pick<ExtensionState, "getRepos" | "saveRepos" | "getLastActiveRepo">,
  { gitPath }: { gitPath: () => string }
): DesktopRepoSource {
  let repos = extensionState.getRepos();
  const listeners = new Set<(repos: GitRepoSet) => void>();

  const getRepos = () => sorted(repos);
  const write = (next: GitRepoSet) => {
    repos = next;
    extensionState.saveRepos(repos);
  };
  const broadcast = () => {
    const set = getRepos();
    for (const listener of listeners) listener(set);
  };
  const without = (gone: readonly string[]) =>
    Object.fromEntries(Object.entries(repos).filter(([repo]) => !gone.includes(repo)));

  return {
    getRepos,
    getBootRepo: () => pickBootRepo(extensionState.getLastActiveRepo(), Object.keys(getRepos())),
    checkReposExist: async () => {
      const known = Object.keys(repos);
      const isRepo = await evalPromises(known, REPO_EXISTENCE_CHECKS_AT_ONCE, (repo) =>
        isGitRepository(repo, gitPath())
      );
      const gone = known.filter((_, i) => !isRepo[i]);
      if (gone.length === 0) return false;
      write(without(gone));
      broadcast();
      return true;
    },
    dropRepo: (repo) => {
      write(without([repo]));
      broadcast();
    },
    setRepoState: (repo, state) => write({ ...repos, [repo]: state }),
    updateRepoState: (repo, patch) => {
      const current = repos[repo];
      if (current === undefined) return;
      write({ ...repos, [repo]: { ...current, ...patch } });
      broadcast();
    },
    addRepo: (repo) => {
      if (Object.hasOwn(repos, repo)) return;
      const shared = readSharedSettings(repo);
      const fresh: GitRepoState = { columnWidths: null };
      write({ ...repos, [repo]: shared === null ? fresh : applyExternalConfig(shared, fresh) });
      broadcast();
    },
    onDidChangeRepos: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  };
}
