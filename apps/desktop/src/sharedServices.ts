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
import type { Clipboard, HostLogger, L10n } from "@ging/core/host/ports";
import { TabStates } from "@ging/core/tabStates";
import { createDesktopConfig, type DesktopConfig } from "@ging/desktop/ports/config";
import { createDesktopL10n } from "@ging/desktop/ports/l10n";
import type { OsShell } from "@ging/desktop/ports/opener";
import { createDesktopRepoSource, type DesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { type DesktopStorage, openDesktopStorage } from "@ging/desktop/ports/storage";
import { openDesktopSettings } from "@ging/desktop/settings/schema";
import type { Settings } from "@ging/desktop/settings/settingsFile";
import { createSideViewLayoutStore, type SideViewLayoutStore } from "@ging/desktop/sideViewLayout";

/** There is no `git.path` of VS Code's to follow: the git on the PATH. Known
 *  before the shared services are, so a launch's path can be checked while the app
 *  gets ready. */
export const desktopGitPath = () => "git";

type SharedServicesOptions = {
  /** Electron's `userData`: the settings, the state and the avatars. */
  userDataPath: string;
  /** Electron's `app.getLocale()`. */
  locale: string;
  /** The folder the askpass and sequence editor helpers are shipped in. */
  helperDir: string;
  logger: HostLogger;
  clipboard: Clipboard;
  os: OsShell;
  /** What Version Information lists before the OS and git (#396). */
  hostVersions: readonly { name: string; version: string }[];
};

export type SharedServices = {
  config: DesktopConfig;
  /** What `config` reads, by key, for the settings page to show (#397). */
  settings: Settings;
  /** What `extensionState` keeps; the desktop host's own state (the theme it
   *  was left in, #397) goes in its global tier beside core's. */
  storage: DesktopStorage;
  /** How the side views' column sits in every Tab (#459), kept in `storage`. */
  sideViewLayout: SideViewLayoutStore;
  l10n: L10n;
  /** The app's language (`app.getLocale()`): what `l10n` reads, and what
   *  times are written in, as a blame's (#409). */
  locale: string;
  logger: HostLogger;
  clipboard: Clipboard;
  /** What the system opens files, links and terminals with. Each instance
   *  opens through an `Opener` of its own over it, which says what it has to
   *  say in that instance's window (#391). */
  os: OsShell;
  /** The known repositories are the app's, not a Tab's (GLOSSARY.md: on
   *  the desktop host, the recently opened list); each instance boots on its
   *  own current repository among them. */
  repoSource: DesktopRepoSource;
  /** The app's: the known repositories, the dialog memory, the avatars. Its
   *  own Current repository is unused here — each Tab has one (`tabStates`). */
  extensionState: ExtensionState;
  /** The Tabs as they persist, each with an `ExtensionState` of its own whose
   *  Current repository is the Tab's (#393). */
  tabStates: TabStates;
  /** One cache; each instance registers its bridge and gets every avatar. */
  avatarManager: AvatarManager;
  /** Filters are kept per repository, and a repository is open in at most
   *  one Tab (GLOSSARY.md), so instances never share an entry. */
  branchFilterStore: BranchFilterStore;
  /**
   * One cache of every repository's branch facts. Shared on purpose: a
   * mutation in any instance invalidates all of it, so another instance's
   * next read pays for one more git read than it needed. Per instance, a
   * repository open in one place and changed from another — a later Tab, a
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
  /** GING's version and the host's, as Version Information lists them. */
  hostVersions: readonly { name: string; version: string }[];
  dispose(): void;
};

export function createSharedServices({
  userDataPath,
  locale,
  helperDir,
  logger,
  clipboard,
  os,
  hostVersions
}: SharedServicesOptions): SharedServices {
  const settings = openDesktopSettings(userDataPath, { onError: logger.logError });
  const config = createDesktopConfig(settings);
  const storage = openDesktopStorage(userDataPath, { onError: logger.logError });
  const extensionState = new ExtensionState(storage);
  const repoSource = createDesktopRepoSource(extensionState, { gitPath: desktopGitPath });

  const avatarManager = new AvatarManager(
    { gitPath: desktopGitPath, gitLabToken: config.gitLabToken },
    extensionState
  );
  const branchFilterStore = createBranchFilterStore();
  // Reads only, so no askpass or sequence editor: nothing here asks or rebases,
  // and nothing here needs an instance's token. Clients are made per call.
  const readers = createRepoGitClients({ gitPath: desktopGitPath });
  const resolveShowRemote = (repo: string): boolean =>
    resolveShowRemoteBranches(repoSource.getRepos()[repo], config.showRemoteBranches());
  const branchFacts = createBranchFacts({
    readSnapshot: createGitSnapshotReader({
      gitClientFor: readers.gitClientFor,
      gitPath: desktopGitPath
    }),
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
      },
      choose: async (message) => {
        logger.logError(`An ssh prompt reached no window, answered as dismissed: ${message}`);
        return undefined;
      }
    },
    helperDir
  );

  return {
    config,
    settings,
    storage,
    sideViewLayout: createSideViewLayoutStore(storage.global),
    l10n: createDesktopL10n(locale),
    locale,
    logger,
    clipboard,
    os,
    repoSource,
    extensionState,
    tabStates: new TabStates(storage),
    avatarManager,
    branchFilterStore,
    branchFacts,
    branchCleanup,
    askpass,
    helperDir,
    gitPath: desktopGitPath,
    hostVersions,
    dispose: () => {
      askpass.dispose();
      branchFilterStore.dispose();
    }
  };
}
