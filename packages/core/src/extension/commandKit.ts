/**
 * Steps the core's command services share: asking yes or no, finding the
 * current repository, listing its remotes, running a change to it, and any
 * other step that can fail — each failure told to the user the same way, under
 * the caller's error key.
 */

import type { SimpleGit } from "simple-git";

import { type ConfiguredRemote, listRemotes } from "@ging/core/backend/queries/listRemotes";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { L10n, Prompts, RepoSource, RunRepoMutation } from "@ging/core/host/ports";

/** A modal yes-or-no question whose one way to say yes is `confirmLabel`;
 *  resolves to whether it was said. */
export async function confirm(
  prompts: Pick<Prompts, "choose">,
  message: string,
  confirmLabel: string
): Promise<boolean> {
  const answer = await prompts.choose(message, {
    actions: [{ label: confirmLabel, value: true }]
  });
  return answer ?? false;
}

export type CommandKitDeps = {
  prompts: Pick<Prompts, "showInformation" | "showError">;
  l10n: L10n;
  gitClientFor: (repo: string) => SimpleGit;
  /** The current repository (`CONTEXT.md`); `null` when there is none. */
  currentRepo: () => string | null;
  repoSource: Pick<RepoSource, "getRepos">;
  runRepoMutation: RunRepoMutation;
};

export type CommandKit = ReturnType<typeof createCommandKit>;

export function createCommandKit(deps: CommandKitDeps) {
  const { prompts, l10n } = deps;
  const toast = (errorKey: string, e: unknown) =>
    void prompts.showError(l10n.t(errorKey) + ": " + formatGitError(e));

  return {
    /** The current repository, or `null` after saying there is none. A path
     *  that is no longer a known repository counts as none. */
    currentRepoOrSay(): string | null {
      const repo = deps.currentRepo();
      if (repo === null || deps.repoSource.getRepos()[repo] === undefined) {
        prompts.showInformation(l10n.t("repoName.noRepos"));
        return null;
      }
      return repo;
    },

    /** What `work` resolves to, or `undefined` after a toast saying why not. */
    async tryOrToast<T>(errorKey: string, work: () => PromiseLike<T>): Promise<T | undefined> {
      try {
        return await work();
      } catch (e: unknown) {
        toast(errorKey, e);
        return undefined;
      }
    },

    /** `repo`'s remotes, or `undefined` after a toast saying why not. */
    async listRemotesOrToast(
      errorKey: string,
      repo: string
    ): Promise<ConfiguredRemote[] | undefined> {
      try {
        return await listRemotes(deps.gitClientFor(repo));
      } catch (e: unknown) {
        toast(errorKey, e);
        return undefined;
      }
    },

    /** `change` run against `repo` inside the hook — its client built there
     *  too, since building one throws for a repo deleted since it was last
     *  seen. A failure is a toast once the hook has finished. */
    async mutateOrToast(
      errorKey: string,
      repo: string,
      change: (git: SimpleGit) => Promise<void>
    ): Promise<void> {
      try {
        await deps.runRepoMutation(repo, () => change(deps.gitClientFor(repo)));
      } catch (e: unknown) {
        toast(errorKey, e);
      }
    }
  };
}
