/**
 * The commands that manage a repo's remotes, from the Remotes side view's menus
 * and from the command palette (`manageRemotes`, `toggleRemoteVisibility`),
 * plus the read that view lists them with. The host registers the commands and
 * resolves a side-view item to a `RemoteTarget`; everything between the
 * command and git is here.
 *
 * The side view and `manageRemotes` share their steps: the same questions in
 * the same order, and an answer that is dismissed, blank or unchanged changes
 * nothing. Every change runs inside the host's `runRepoMutation`, which
 * refreshes whatever shows the repo's remotes and remote-tracking branches.
 */

import type { SimpleGit } from "simple-git";

import { listRemoteNames } from "@ging/core/backend/actions/fetch";
import {
  addRemote,
  getRemoteUrl,
  removeRemote,
  renameRemote,
  setRemoteUrl
} from "@ging/core/backend/actions/remote";
import { listRemotes } from "@ging/core/backend/queries/listRemotes";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { RunRepoMutation } from "@ging/core/extension/fetchService";
import type { L10n, Prompts, RepoSource } from "@ging/core/host/ports";

/** The remote a side-view menu command acts on, as the view listed it. */
export type RemoteTarget = {
  repo: string;
  name: string;
  fetchUrl: string;
};

export type RemoteCommandsDeps = {
  prompts: Pick<Prompts, "pick" | "confirm" | "input" | "showInformation" | "showError">;
  l10n: L10n;
  gitClientFor: (repo: string) => SimpleGit;
  /** The current repository (`CONTEXT.md`) — what the palette commands act
   *  on. `null` when there is none. */
  currentRepo: () => string | null;
  repoSource: Pick<RepoSource, "getRepos" | "setRepoState">;
  /** Send the set of known repos, with their state, to everything showing it. */
  broadcastRepos: () => void;
  /** Ask an open graph to reload. */
  refreshGraph: () => void;
  runRepoMutation: RunRepoMutation;
};

export type RemoteCommands = ReturnType<typeof createRemoteCommands>;

export function createRemoteCommands(deps: RemoteCommandsDeps) {
  const { prompts, l10n } = deps;

  /** `repo`'s remotes changed as `change` says, inside the hook; a failure is
   *  a toast once the hook has finished. */
  const mutate = async (repo: string, change: (git: SimpleGit) => Promise<void>) => {
    try {
      // The client is built inside the hook: building one throws for a repo
      // deleted since it was last seen, and that is a failure like any other.
      await deps.runRepoMutation(repo, () => change(deps.gitClientFor(repo)));
    } catch (e: unknown) {
      void prompts.showError(l10n.t("error.unableToManageRemote") + ": " + formatGitError(e));
    }
  };

  /** The answer to `prompt`, trimmed, starting from `current` when there is
   *  one; `undefined` when it was dismissed, left blank or left as `current`. */
  const ask = async (prompt: string, current?: string): Promise<string | undefined> => {
    const answer = (await prompts.input({ prompt, value: current }))?.trim();
    if (answer === undefined || answer === "" || answer === current) return undefined;
    return answer;
  };

  const add = async (repo: string) => {
    const name = await ask(l10n.t("remotes.namePrompt"));
    if (name === undefined) return;
    const url = await ask(l10n.t("remotes.urlPrompt"));
    if (url === undefined) return;
    await mutate(repo, (git) => addRemote(git, { name, url }));
  };

  const editUrl = async (repo: string, name: string, currentUrl: string) => {
    const url = await ask(l10n.t("remotes.urlPrompt"), currentUrl);
    if (url === undefined) return;
    await mutate(repo, (git) => setRemoteUrl(git, { name, url }));
  };

  const rename = async (repo: string, oldName: string) => {
    const newName = await ask(l10n.t("remotes.renamePrompt"), oldName);
    if (newName === undefined) return;
    await mutate(repo, (git) => renameRemote(git, { oldName, newName }));
  };

  const remove = async (repo: string, name: string) => {
    const agreed = await prompts.confirm(l10n.t("remotes.removeConfirm", name), {
      confirmLabel: l10n.t("remotes.removeConfirmYes")
    });
    if (!agreed) return;
    await mutate(repo, (git) => removeRemote(git, { name }));
  };

  /** The current repository, or `null` after saying there is none. */
  const currentRepoOrSay = (): string | null => {
    const repo = deps.currentRepo();
    if (repo === null || deps.repoSource.getRepos()[repo] === undefined) {
      prompts.showInformation(l10n.t("repoName.noRepos"));
      return null;
    }
    return repo;
  };

  return {
    /** The Remotes side view's read: `repo`'s remotes with their URLs.
     *  Rejects when git cannot read it. */
    list: (repo: string) => listRemotes(deps.gitClientFor(repo)),

    /** The side view's Add, on the repo it shows; nothing when it shows none. */
    async add(repo: string | null): Promise<void> {
      if (repo !== null) await add(repo);
    },
    /** The side view's Edit URL: asks starting from the URL it listed. */
    editUrl: (target: RemoteTarget): Promise<void> =>
      editUrl(target.repo, target.name, target.fetchUrl),
    rename: (target: RemoteTarget): Promise<void> => rename(target.repo, target.name),
    remove: (target: RemoteTarget): Promise<void> => remove(target.repo, target.name),

    /** The palette's Manage Remotes, on the current repository: pick a remote
     *  or "add one", then, for a remote, pick what to do with it. */
    async manageRemotes(): Promise<void> {
      const repo = currentRepoOrSay();
      if (repo === null) return;
      const git = deps.gitClientFor(repo);
      let remotes: string[];
      try {
        remotes = await listRemoteNames(git);
      } catch (e: unknown) {
        void prompts.showError(l10n.t("error.unableToManageRemote") + ": " + formatGitError(e));
        return;
      }
      // `null` is the add row: a remote can be named anything, its label too.
      const choice = await prompts.pick<string | null>(
        [
          ...remotes.map((name) => ({ label: name, value: name })),
          { label: l10n.t("remotes.add"), value: null }
        ],
        { placeholder: l10n.t("remotes.pickPrompt") }
      );
      if (choice === undefined) return;
      if (choice === null) return add(repo);
      const action = await prompts.pick(
        [
          { label: l10n.t("remotes.editUrl"), value: "editUrl" as const },
          { label: l10n.t("remotes.rename"), value: "rename" as const },
          { label: l10n.t("remotes.remove"), value: "remove" as const }
        ],
        { placeholder: l10n.t("remotes.actionPrompt", choice) }
      );
      if (action === "editUrl") return editUrl(repo, choice, await getRemoteUrl(git, choice));
      if (action === "rename") return rename(repo, choice);
      if (action === "remove") return remove(repo, choice);
    },

    /** The palette's Show/Hide Remotes: check the remotes of the current
     *  repository whose branches the graph shows. */
    async toggleRemoteVisibility(): Promise<void> {
      const repo = currentRepoOrSay();
      if (repo === null) return;
      const remotes = await listRemoteNames(deps.gitClientFor(repo));
      if (remotes.length === 0) {
        prompts.showInformation(l10n.t("fetch.noRemotes"));
        return;
      }
      const hidden = deps.repoSource.getRepos()[repo]?.hiddenRemotes ?? [];
      const visible = await prompts.pick(
        remotes.map((name) => ({ label: name, picked: !hidden.includes(name), value: name })),
        { canPickMany: true, placeholder: l10n.t("remoteVisibility.prompt") }
      );
      if (visible === undefined) return;
      // Read again rather than spread the state read before the pick, a wait
      // with no upper bound. Anything the graph persisted meanwhile (a column
      // drag, a details-panel resize, the commit ordering) is in the source's
      // copy and not in that one, so spreading it would write those back to
      // their old values *and* broadcast the result as the current state. The
      // repo can also have left the set while the pick was open, and there is
      // nothing to update then.
      const current = deps.repoSource.getRepos()[repo];
      if (current === undefined) return;
      const hiddenRemotes = remotes.filter((name) => !visible.includes(name));
      deps.repoSource.setRepoState(repo, { ...current, hiddenRemotes });
      // The reload rides on the state, not on the refresh below.
      // `hiddenRemotes` becomes `--exclude=<remote>/*`, which makes this a
      // navigation, and the graph recognises it by comparing the set it
      // receives here against the one it has been loading under (ADR-0024).
      // The refresh is kept because a repo the graph is not currently showing
      // still wants one, and on the shown repo it now lands on the
      // navigation's own load and is dropped — which is the whole reason it
      // could not be trusted to do this job: a plain refresh is droppable, and
      // a load already out swallowed it.
      deps.broadcastRepos();
      deps.refreshGraph();
    }
  };
}
