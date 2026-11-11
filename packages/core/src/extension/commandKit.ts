/**
 * Steps the core's command services share: asking yes or no, finding the
 * current repository, listing its remotes, and running git against it — each
 * failure told to the user the same way, under the caller's error key. A
 * service that changes a repo builds the mutating kit, which adds running the
 * change inside the host's `runRepoMutation`.
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
  /** A client bound to `repo`; `null` binds it to none, and git runs where
   *  the host process is — for git's own questions, and the global config. */
  gitClientFor: (repo: string | null) => SimpleGit;
  /** The current repository (`CONTEXT.md`); `null` when there is none. */
  currentRepo: () => string | null;
  repoSource: Pick<RepoSource, "getRepos">;
};

/** What only the mutating kit needs. */
export type MutationDeps = {
  runRepoMutation: RunRepoMutation;
};

export type CommandKit = ReturnType<typeof createCommandKit>;

export function createCommandKit(deps: CommandKitDeps) {
  const { prompts, l10n } = deps;

  /** What `work` resolves to, or `undefined` after a toast saying why not. */
  const tryOrToast = async <T>(
    errorKey: string,
    work: () => Promise<T>
  ): Promise<T | undefined> => {
    try {
      return await work();
    } catch (e: unknown) {
      void prompts.showError(l10n.t(errorKey) + ": " + formatGitError(e));
      return undefined;
    }
  };

  /** What `work` resolves to, run against `repo` outside the hook — for a
   *  read, or a change nothing on screen shows — or `undefined` after a toast
   *  saying why not. Its client is built inside, since building one throws for
   *  a repo deleted since it was last seen. */
  const runOrToast = <T>(
    errorKey: string,
    repo: string | null,
    work: (git: SimpleGit) => Promise<T>
  ): Promise<T | undefined> => tryOrToast(errorKey, async () => work(deps.gitClientFor(repo)));

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

    tryOrToast,
    runOrToast,

    /** `repo`'s remotes, or `undefined` after a toast saying why not. */
    listRemotesOrToast: (errorKey: string, repo: string): Promise<ConfiguredRemote[] | undefined> =>
      runOrToast(errorKey, repo, listRemotes)
  };
}

/** The kit, for a service that changes a repo. */
export function createMutatingCommandKit(deps: CommandKitDeps & MutationDeps) {
  const kit = createCommandKit(deps);
  return {
    ...kit,

    /** `change` run against `repo` inside the hook — its client built there
     *  too, as `runOrToast`'s is. A failure is a toast once the hook has
     *  finished. */
    async mutateOrToast(
      errorKey: string,
      repo: string,
      change: (git: SimpleGit) => Promise<void>
    ): Promise<void> {
      await kit.tryOrToast(errorKey, () =>
        deps.runRepoMutation(repo, () => change(deps.gitClientFor(repo)))
      );
    }
  };
}
