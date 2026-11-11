/**
 * Steps the core's command services share: asking yes or no, finding the
 * current repository, listing its remotes, and running git against it — each
 * failure told to the user the same way, under the caller's error key.
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
  /** A client bound to `repo`. `""` binds it to none, so git runs where the
   *  host process does: for git's own questions, and the global config. */
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

  /** What `work` resolves to, run against `repo` outside the hook — for a
   *  read, or a change nothing on screen shows — or `undefined` after a toast
   *  saying why not. Its client is built inside, as `mutateOrToast`'s is. */
  const runOrToast = async <T>(
    errorKey: string,
    repo: string,
    work: (git: SimpleGit) => Promise<T>
  ): Promise<T | undefined> => {
    try {
      return await work(deps.gitClientFor(repo));
    } catch (e: unknown) {
      toast(errorKey, e);
      return undefined;
    }
  };

  /** The current repository, or `null` when there is none. A path that is no
   *  longer a known repository counts as none. */
  const currentRepo = (): string | null => {
    const repo = deps.currentRepo();
    return repo !== null && deps.repoSource.getRepos()[repo] !== undefined ? repo : null;
  };

  return {
    currentRepo,

    /** `currentRepo`, or `null` after saying there is none. */
    currentRepoOrSay(): string | null {
      const repo = currentRepo();
      if (repo === null) prompts.showInformation(l10n.t("repoName.noRepos"));
      return repo;
    },

    runOrToast,

    /** `repo`'s remotes, or `undefined` after a toast saying why not. */
    listRemotesOrToast: (errorKey: string, repo: string): Promise<ConfiguredRemote[] | undefined> =>
      runOrToast(errorKey, repo, listRemotes),

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
