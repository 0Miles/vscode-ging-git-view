/* The core command services the application menu runs that need no graph
 * (#396): Set Git User Details, Version Information and Manage Pull Request
 * Providers — and Statistics, which reads the current repository when there
 * is one. Each asker has its own: a Tab's graph instance, asking on its page,
 * and the Welcome page, asking there with no current repository. */

import type { Statistics } from "@ging/core/backend/queries/loadStatistics";
import type { CommandKitDeps } from "@ging/core/extension/commandKit";
import { createInfoCommands } from "@ging/core/extension/infoCommands";
import { createPullRequestProviderCommands } from "@ging/core/extension/pullRequestProviderCommands";
import type { Prompts } from "@ging/core/host/ports";

import type { SharedServices } from "./sharedServices";

export type AppCommands = {
  /** On the current repository, or — with none — for every repository. */
  setGitUserDetails(): Promise<void>;
  /** In a system dialog, offering to copy it. */
  versionInfo(): Promise<void>;
  /** The provider list, or provider `host`'s entry in it. */
  managePullRequestProviders(host?: string | null): Promise<void>;
  /** The current repository's figures, or `undefined` after saying why there
   *  are none. Drawing them is the host's. */
  statistics(): Promise<Statistics | undefined>;
};

type AppCommandsOptions = {
  /** Where the questions are asked. */
  prompts: Prompts;
  /** The asker's current repository; `null` on the Welcome page. */
  currentRepo: () => string | null;
  /** Its git clients: the instance's own carry its askpass route. */
  gitClientFor: CommandKitDeps["gitClientFor"];
  /** Show setting `key` in the app's settings (#397). */
  revealSetting: (key: string) => void;
};

export function createAppCommands(
  shared: Pick<SharedServices, "config" | "l10n" | "clipboard" | "repoSource" | "hostVersions">,
  { prompts, currentRepo, gitClientFor, revealSetting }: AppCommandsOptions
): AppCommands {
  const { config, l10n } = shared;
  const info = createInfoCommands({
    prompts,
    l10n,
    clipboard: shared.clipboard,
    gitClientFor,
    currentRepo,
    repoSource: shared.repoSource,
    hostVersions: shared.hostVersions
  });
  // The settings are the app's: no workspace holds any.
  const pullRequestProviders = createPullRequestProviderCommands({
    prompts,
    l10n,
    config,
    revealSetting
  });
  return {
    setGitUserDetails: () => info.setGitUserDetails(),
    versionInfo: () => info.versionInfo(),
    managePullRequestProviders: (host) => pullRequestProviders.manage(host),
    statistics: () => info.statistics()
  };
}
