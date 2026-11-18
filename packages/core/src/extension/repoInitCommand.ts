/**
 * Initialize Repository (#394): a repository made in a folder the host has
 * already had the user choose, ready for the host to open. The desktop host
 * runs it from its Welcome page and its menu; picking the folder is the
 * host's, through its own dialog, since no port asks for a folder.
 */

import type { SimpleGit } from "simple-git";

import {
  type InitializedRepo,
  initRepository,
  NoWorkTreeFolderError
} from "@ging/core/backend/actions/init";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { L10n, Prompts } from "@ging/core/host/ports";

export type RepoInitCommandDeps = {
  prompts: Pick<Prompts, "showError">;
  l10n: L10n;
  /** `null` binds the client to no repository: there is none yet. */
  gitClientFor: (repo: string | null) => SimpleGit;
};

export type RepoInitCommand = ReturnType<typeof createRepoInitCommand>;

export function createRepoInitCommand({ prompts, l10n, gitClientFor }: RepoInitCommandDeps) {
  return {
    /** A repository in `folder` — made there, or the one that already is —
     *  or `undefined` after saying why there is none. */
    async initRepo(folder: string): Promise<InitializedRepo | undefined> {
      try {
        return await initRepository(gitClientFor(null), folder);
      } catch (e: unknown) {
        // git's own words for this one would be about a command it never ran.
        const why =
          e instanceof NoWorkTreeFolderError
            ? l10n.t("init.noWorkTree", folder)
            : formatGitError(e);
        void prompts.showError(l10n.t("init.unableTo") + ": " + why);
        return undefined;
      }
    }
  };
}
