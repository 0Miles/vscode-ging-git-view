/* What every webview instance of the desktop host shares: one of each per
 * process (#388). What each instance owns instead is in graphInstance.ts. */

import { AvatarManager } from "@ging/core/avatarManager";
import { AskpassManager } from "@ging/core/extension/askpass/askpassManager";
import { type BranchCleanup, createBranchCleanup } from "@ging/core/extension/branchCleanupService";
import {
  type BranchFacts,
  createBranchFacts,
  createGitSnapshotReader
} from "@ging/core/extension/branchFacts";
import {
  type BranchFilterStore,
  createBranchFilterStore
} from "@ging/core/extension/branchFilterStore";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import { resolveShowRemoteBranches } from "@ging/core/extension/repoSettings";
import { ExtensionState } from "@ging/core/extensionState";
import type { Clipboard, HostLogger, L10n, Opener } from "@ging/core/host/ports";
import { createDesktopConfig, type DesktopConfig } from "@ging/desktop/ports/config";
import { createDesktopL10n } from "@ging/desktop/ports/l10n";
import { createInterimOpener } from "@ging/desktop/ports/opener";
import { createDesktopRepoSource, type DesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { openDesktopStorage } from "@ging/desktop/ports/storage";
import { openDesktopSettings } from "@ging/desktop/settings/schema";

/** There is no `git.path` of VS Code's to follow: the git on the PATH. Known
 *  before the shared host is, so a launch's path can be checked while the app
 *  gets ready. */
export const desktopGitPath = () => "git";
const gitPath = desktopGitPath;

export type SharedHostOptions = {
  /** Electron's `userData`: the settings, the state and the avatars. */
  userDataPath: string;
  /** Electron's `app.getLocale()`. */
  locale: string;
  /** The folder the askpass and sequence editor helpers are shipped in. */
  helperDir: string;
  logger: HostLogger;
  clipboard: Clipboard;
};

export type SharedHost = {
  config: DesktopConfig;
  l10n: L10n;
  logger: HostLogger;
  clipboard: Clipboard;
  opener: Opener;
  /** The known repositories are the app's, not a window's (GLOSSARY.md: on
   *  the desktop host, the recently opened list); each instance boots on its
   *  own current repository among them. */
  repoSource: DesktopRepoSource;
  /** One for now, so the current repository is the app's; #393 keeps one per
   *  tab. */
  extensionState: ExtensionState;
  /** One cache; each instance registers its bridge and gets every avatar. */
  avatarManager: AvatarManager;
  /** Filters are kept per repository, and a repository is open in at most
   *  one tab (GLOSSARY.md's Tab), so instances never share an entry. */
  branchFilterStore: BranchFilterStore;
  /**
   * One cache of every repository's branch facts. Shared on purpose: a
   * mutation in any instance invalidates all of it, so another instance's
   * next read pays for one more git read than it needed. Per instance, a
   * repository open in one place and changed from another — a later tab, a
   * fetch — would keep serving the facts from before.
   */
  branchFacts: BranchFacts;
  /** Holds nothing of its own: builds each payload from `branchFacts`, for
   *  the repository it is asked about. */
  branchCleanup: BranchCleanup;
  /** One server; each instance takes a route, so a prompt git raises goes
   *  back to the instance whose git raised it. */
  askpass: Pick<AskpassManager, "route">;
  helperDir: string;
  gitPath: () => string;
  dispose(): void;
};

export function createSharedHost({
  userDataPath,
  locale,
  helperDir,
  logger,
  clipboard
}: SharedHostOptions): SharedHost {
  const config = createDesktopConfig(
    openDesktopSettings(userDataPath, { onError: logger.logError })
  );
  const extensionState = new ExtensionState(
    openDesktopStorage(userDataPath, { onError: logger.logError })
  );
  const repoSource = createDesktopRepoSource(extensionState, { gitPath });

  const avatarManager = new AvatarManager(
    { gitPath, gitLabToken: config.gitLabToken },
    extensionState
  );
  const branchFilterStore = createBranchFilterStore();
  // Reads only, so no askpass or sequence editor: nothing here asks or rebases,
  // and nothing here needs an instance's token. Clients are made per call.
  const readers = createRepoGitClients({ gitPath });
  const resolveShowRemote = (repo: string): boolean =>
    resolveShowRemoteBranches(repoSource.getRepos()[repo], config.showRemoteBranches());
  const branchFacts = createBranchFacts({
    readSnapshot: createGitSnapshotReader({ gitClientFor: readers.gitClientFor, gitPath }),
    filterStore: branchFilterStore,
    resolveShowRemote,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow,
    resolveInactiveThresholdDays: config.inactiveBranchThresholdDays,
    resolveShowSpecificBranches: config.showSpecificBranches,
    resolveShowCurrentBranchByDefault: config.showCurrentBranchByDefault,
    nowMs: () => Date.now()
  });
  const branchCleanup = createBranchCleanup({
    branchFacts,
    gitClientFor: readers.gitClientFor,
    resolveShowRemote,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow,
    dateType: config.dateType
  });
  // Every git an instance runs carries its route's token; a prompt without
  // one has no instance to go back to.
  const askpass = new AskpassManager(
    {
      input: async ({ prompt }) => {
        logger.logError(
          `A git credential prompt reached no window, answered as dismissed: ${prompt}`
        );
        return undefined;
      }
    },
    helperDir
  );

  return {
    config,
    l10n: createDesktopL10n(locale),
    logger,
    clipboard,
    opener: createInterimOpener(logger),
    repoSource,
    extensionState,
    avatarManager,
    branchFilterStore,
    branchFacts,
    branchCleanup,
    askpass,
    helperDir,
    gitPath,
    dispose: () => {
      askpass.dispose();
      branchFilterStore.dispose();
    }
  };
}
