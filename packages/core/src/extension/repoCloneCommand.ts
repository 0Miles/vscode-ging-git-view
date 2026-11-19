/**
 * Clone Repository (#395): a repository cloned from a URL into a folder the
 * host has already had the user choose, ready for the host to open. The
 * desktop host runs it from its Welcome page and its menu; asking for the URL
 * and picking the folder are the host's, as for Initialize Repository
 * (`repoInitCommand.ts`), and so is showing the progress it reports.
 */

import * as path from "node:path";

import {
  CloneCancelledError,
  type ClonedRepo,
  CloneFailedError,
  CloneFolderError,
  cloneFolderName,
  type CloneProgress,
  cloneRepository,
  type CloneUrlProblem,
  cloneUrlProblem,
  CloneUrlError,
  removeCredentialsFromRemote,
  urlHasCredentials,
  urlWithoutCredentials
} from "@ging/core/backend/actions/clone";
import type { GitCommandHandler } from "@ging/core/backend/gitSpawn";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { L10n, Prompts } from "@ging/core/host/ports";

export type RepoCloneCommandDeps = {
  prompts: Pick<Prompts, "showError" | "showWarning">;
  l10n: L10n;
  gitPath: () => string;
  onCommand?: GitCommandHandler;
};

/** One clone's own: how it is cancelled, who hears its progress, and the
 *  environment of its git (the askpass route of whoever answers for it). */
export type CloneRun = {
  signal?: AbortSignal;
  onProgress?: (progress: CloneProgress) => void;
  gitEnv?: NodeJS.ProcessEnv;
};

export type RepoCloneCommand = ReturnType<typeof createRepoCloneCommand>;

/** What each `CloneUrlProblem` says, in the app's words. */
const URL_PROBLEMS: Record<CloneUrlProblem, string> = {
  empty: "clone.url.empty",
  option: "clone.url.option",
  transport: "clone.url.transport",
  control: "clone.url.control",
  scheme: "clone.url.scheme",
  relative: "clone.url.relative",
  noName: "clone.url.noName"
};

export function createRepoCloneCommand({
  prompts,
  l10n,
  gitPath,
  onCommand
}: RepoCloneCommandDeps) {
  /** Why `url` is not one to clone, in the app's words. */
  const problemWith = (url: string): string | undefined => {
    const problem = cloneUrlProblem(url);
    return problem === null ? undefined : l10n.t(URL_PROBLEMS[problem]);
  };
  /** Say that what the clone made in `folder` is still there. */
  const sayLeftBehind = (folder: string) => prompts.showWarning(l10n.t("clone.leftBehind", folder));

  return {
    /** Why `url` is not one to clone, in the app's words, or `undefined`
     *  when it is one: a `Prompts.input`'s `validate`. Spaces around it are
     *  not counted; `cloneRepo` is to be handed it trimmed. */
    urlProblem: (url: string): string | undefined => problemWith(url.trim()),

    /** `url` as it may be shown or logged: no user name or password in it. */
    shownUrl: (url: string): string => urlWithoutCredentials(url),

    /** `url` has a password or token in it that git would save, as it is,
     *  in the clone's `.git/config` (`urlHasCredentials`, #471). */
    hasCredentials: (url: string): boolean => urlHasCredentials(url),

    /** Take the user name and password of `url`, the one `repo` was cloned
     *  from, out of its `origin`'s URL; answers whether git did. Says
     *  nothing either way: the host does. */
    removeCredentials: (repo: string, url: string): Promise<boolean> =>
      removeCredentialsFromRemote({ gitPath: gitPath(), repo, url, onCommand }),

    /** Where `url` is cloned under `parent`: a folder named as git would
     *  name it (`cloneFolderName`). Only for a URL `urlProblem` takes. */
    folderFor: (parent: string, url: string): string =>
      path.join(parent, cloneFolderName(url) ?? ""),

    /** `url` cloned into `folder`, or `undefined` once it has said why not,
     *  or with nothing said when the clone was cancelled. */
    async cloneRepo(
      url: string,
      folder: string,
      run: CloneRun = {}
    ): Promise<ClonedRepo | undefined> {
      try {
        return await cloneRepository({ gitPath: gitPath(), url, folder, onCommand, ...run });
      } catch (e: unknown) {
        if (e instanceof CloneCancelledError) {
          if (e.leftBehind) sayLeftBehind(folder);
          return undefined;
        }
        void prompts.showError(l10n.t("clone.unableTo") + ": " + reason(e, folder));
        if (e instanceof CloneFailedError && e.leftBehind) sayLeftBehind(folder);
        return undefined;
      }
    }
  };

  /** Why the clone into `folder` failed: in the app's words when the app
   *  turned it away, in git's otherwise. */
  function reason(e: unknown, folder: string): string {
    if (e instanceof CloneUrlError) return l10n.t(URL_PROBLEMS[e.problem]);
    if (e instanceof CloneFolderError) {
      return l10n.t(e.why === "notEmpty" ? "clone.folderNotEmpty" : "clone.noParent", folder);
    }
    return formatGitError(e);
  }
}
