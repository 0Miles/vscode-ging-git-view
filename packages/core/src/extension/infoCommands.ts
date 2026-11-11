/**
 * The commands that tell the user about their setup or set who they commit
 * as: Statistics on the current repository, Set Git User Details on it or
 * globally, and Version Info, which needs none. None changes anything a view
 * shows, so none needs the host's `runRepoMutation`. Statistics answers its
 * figures and leaves drawing them to the host.
 */

import { getUserDetails, setUserDetails } from "@ging/core/backend/actions/userDetails";
import { loadStatistics, type Statistics } from "@ging/core/backend/queries/loadStatistics";
import { type CommandKitDeps, createCommandKit } from "@ging/core/extension/commandKit";
import type { Clipboard, Prompts } from "@ging/core/host/ports";

export type InfoCommandsDeps = CommandKitDeps & {
  prompts: Pick<Prompts, "input" | "pick" | "showInformation" | "showError">;
  clipboard: Clipboard;
  /** What Version Info lists before the OS and git, each as `name: version`:
   *  GING's own version first, then the host's. */
  hostVersions: readonly { name: string; version: string }[];
};

export type InfoCommands = ReturnType<typeof createInfoCommands>;

const USER_DETAILS_FAILED = "userDetails.unableToSet";
const STATISTICS_FAILED = "stats.unableTo";

export function createInfoCommands(deps: InfoCommandsDeps) {
  const { prompts, l10n } = deps;
  const kit = createCommandKit(deps);

  /** `git --version`'s line, or `git: unknown` when git cannot be run. The
   *  question is git's, not a repository's, so the client is bound to none and
   *  runs where the host process does: a current repository deleted since it
   *  was last seen does not make git unknown. */
  const gitVersion = async (): Promise<string> => {
    try {
      return (await deps.gitClientFor(null).raw(["--version"])).trim();
    } catch {
      return "git: unknown";
    }
  };

  return {
    /** A name and an email, each starting from the one in effect, and whether
     *  to set them for the current repository or every one. With no current
     *  repository, every one is the only answer: a first-run setup has no
     *  repository yet, and the global identity is what it needs. A field left
     *  blank is unset. */
    async setGitUserDetails(): Promise<void> {
      const repo = kit.currentRepo();
      const current = await kit.tryOrToast(USER_DETAILS_FAILED, () =>
        getUserDetails(deps.gitClientFor(repo))
      );
      if (current === undefined) return;
      const name = await prompts.input({
        prompt: l10n.t("userDetails.namePrompt"),
        value: current.name
      });
      if (name === undefined) return;
      const email = await prompts.input({
        prompt: l10n.t("userDetails.emailPrompt"),
        value: current.email
      });
      if (email === undefined) return;
      const useGlobal = await prompts.pick(
        [
          ...(repo !== null ? [{ label: l10n.t("userDetails.scopeLocal"), value: false }] : []),
          { label: l10n.t("userDetails.scopeGlobal"), value: true }
        ],
        { placeholder: l10n.t("userDetails.scopePrompt") }
      );
      if (useGlobal === undefined) return;
      const input = { name: name.trim(), email: email.trim(), useGlobal };
      const set = await kit.tryOrToast(USER_DETAILS_FAILED, async () => {
        await setUserDetails(deps.gitClientFor(repo), input);
        return true;
      });
      if (set === true) prompts.showInformation(l10n.t("userDetails.updated"));
    },

    /** The host's versions, the OS and git's, in a modal that offers to copy
     *  them as shown. */
    async versionInfo(): Promise<void> {
      const info = [
        ...deps.hostVersions.map(({ name, version }) => `${name}: ${version}`),
        `OS: ${process.platform} ${process.arch}`,
        await gitVersion()
      ].join("\n");
      const copy = await prompts.showInformation(info, {
        modal: true,
        actions: [{ label: l10n.t("versionInfo.copy"), value: true }]
      });
      if (copy === true) await deps.clipboard.writeText(info);
    },

    /** The current repository's commit statistics, or `undefined` after saying
     *  why there are none to show. */
    async statistics(): Promise<Statistics | undefined> {
      const repo = kit.currentRepoOrSay();
      if (repo === null) return undefined;
      return kit.tryOrToast(STATISTICS_FAILED, () => loadStatistics(deps.gitClientFor(repo)));
    }
  };
}
