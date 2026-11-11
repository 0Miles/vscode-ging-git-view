/**
 * Managing a repo's remotes: the read that lists them, and the commands that
 * add, edit, rename or remove one, or choose whose branches the graph shows.
 * Every change runs inside the host's `runRepoMutation`; an answer dismissed,
 * left blank or left unchanged changes nothing.
 */

import {
  addRemote,
  removeRemote,
  renameRemote,
  setRemoteUrl
} from "@ging/core/backend/actions/remote";
import { type ConfiguredRemote, listRemotes } from "@ging/core/backend/queries/listRemotes";
import { type CommandKitDeps, confirm, createCommandKit } from "@ging/core/extension/commandKit";
import type { Prompts, RepoSource } from "@ging/core/host/ports";

/** The remote a command acts on, as it was listed. */
export type RemoteTarget = {
  repo: string;
  name: string;
  fetchUrl: string;
};

export type RemoteCommandsDeps = CommandKitDeps & {
  prompts: Pick<
    Prompts,
    "pick" | "pickMany" | "choose" | "input" | "showInformation" | "showError"
  >;
  repoSource: Pick<RepoSource, "getRepos" | "updateRepoState">;
  /** Ask an open graph to reload. */
  refreshGraph: () => void;
};

export type RemoteCommands = ReturnType<typeof createRemoteCommands>;

const MANAGE_FAILED = "error.unableToManageRemote";

export function createRemoteCommands(deps: RemoteCommandsDeps) {
  const { prompts, l10n } = deps;
  const kit = createCommandKit(deps);

  /** The answer to `prompt`, trimmed, starting from `current` when there is
   *  one; `undefined` when it was dismissed, left blank or left as `current`. */
  const ask = async (prompt: string, current?: string): Promise<string | undefined> => {
    const answer = (await prompts.input({ prompt, value: current }))?.trim();
    if (answer === undefined || answer === "" || answer === current) return undefined;
    return answer;
  };

  /** Add a remote to `repo`; nothing when there is no repo to add it to. */
  const add = async (repo: string | null): Promise<void> => {
    if (repo === null) return;
    const name = await ask(l10n.t("remotes.namePrompt"));
    if (name === undefined) return;
    const url = await ask(l10n.t("remotes.urlPrompt"));
    if (url === undefined) return;
    await kit.mutateOrToast(MANAGE_FAILED, repo, (git) => addRemote(git, { name, url }));
  };

  /** Asks starting from the URL the remote was listed with. */
  const editUrl = async ({ repo, name, fetchUrl }: RemoteTarget): Promise<void> => {
    const url = await ask(l10n.t("remotes.urlPrompt"), fetchUrl);
    if (url === undefined) return;
    await kit.mutateOrToast(MANAGE_FAILED, repo, (git) => setRemoteUrl(git, { name, url }));
  };

  const rename = async ({ repo, name }: RemoteTarget): Promise<void> => {
    const newName = await ask(l10n.t("remotes.renamePrompt"), name);
    if (newName === undefined) return;
    await kit.mutateOrToast(MANAGE_FAILED, repo, (git) =>
      renameRemote(git, { oldName: name, newName })
    );
  };

  const remove = async ({ repo, name }: RemoteTarget): Promise<void> => {
    const message = l10n.t("remotes.removeConfirm", name);
    if (!(await confirm(prompts, message, l10n.t("remotes.removeConfirmYes")))) return;
    await kit.mutateOrToast(MANAGE_FAILED, repo, (git) => removeRemote(git, { name }));
  };

  /** One of `remotes`, or `null` for the row that adds one. The row is told
   *  apart by its value: a remote can be named anything, the row's label too. */
  const pickRemote = (remotes: ConfiguredRemote[]) =>
    prompts.pick<ConfiguredRemote | null>(
      [
        ...remotes.map((remote) => ({ label: remote.name, value: remote })),
        { label: l10n.t("remotes.add"), value: null }
      ],
      { placeholder: l10n.t("remotes.pickPrompt") }
    );

  /** What to do with the remote named `name`. */
  const pickAction = (name: string) =>
    prompts.pick(
      [
        { label: l10n.t("remotes.editUrl"), value: editUrl },
        { label: l10n.t("remotes.rename"), value: rename },
        { label: l10n.t("remotes.remove"), value: remove }
      ],
      { placeholder: l10n.t("remotes.actionPrompt", name) }
    );

  return {
    /** `repo`'s remotes with their URLs. Rejects when git cannot read them. */
    list: async (repo: string) => listRemotes(deps.gitClientFor(repo)),
    add,
    editUrl,
    rename,
    remove,

    /** On the current repository: pick a remote or "add one", then, for a
     *  remote, what to do with it. */
    async manageRemotes(): Promise<void> {
      const repo = kit.currentRepoOrSay();
      if (repo === null) return;
      const remotes = await kit.listRemotesOrToast(MANAGE_FAILED, repo);
      if (remotes === undefined) return;
      const remote = await pickRemote(remotes);
      if (remote === null) return add(repo);
      if (remote === undefined) return;
      const action = await pickAction(remote.name);
      await action?.({ repo, name: remote.name, fetchUrl: remote.fetchUrl });
    },

    /** Check the remotes of the current repository whose branches the graph
     *  shows. */
    async toggleRemoteVisibility(): Promise<void> {
      const repo = kit.currentRepoOrSay();
      if (repo === null) return;
      const remotes = await kit.listRemotesOrToast(MANAGE_FAILED, repo);
      if (remotes === undefined) return;
      if (remotes.length === 0) {
        prompts.showInformation(l10n.t("fetch.noRemotes"));
        return;
      }
      const hidden = deps.repoSource.getRepos()[repo]?.hiddenRemotes ?? [];
      const visible = await prompts.pickMany(
        remotes.map(({ name }) => ({ label: name, picked: !hidden.includes(name), value: name })),
        { placeholder: l10n.t("remoteVisibility.prompt") }
      );
      if (visible === undefined) return;
      const hiddenRemotes = remotes
        .map(({ name }) => name)
        .filter((name) => !visible.includes(name));
      deps.repoSource.updateRepoState(repo, { hiddenRemotes });
      // The graph reloads on the broadcast state: a changed `hiddenRemotes` is
      // a navigation (ADR-0024), which a plain refresh is not. The refresh is
      // for a repo the graph is not showing; on the shown one it is dropped.
      deps.refreshGraph();
    }
  };
}
