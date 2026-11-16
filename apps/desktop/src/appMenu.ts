/* The desktop host's application menu, as data: what Electron builds with
 * `Menu.buildFromTemplate`, kept apart from Electron so vitest can read it —
 * labels, ids, accelerators and when each entry is enabled (ADR-0032). It is
 * the desktop host's entry to core's command services (#396; there is no
 * command palette), whose questions come up in the host prompt overlay
 * (#390): on the focused Tab's page, or on the Welcome page when there is no
 * Tab. */

import type { MenuItemConstructorOptions } from "electron";

import type { L10n } from "@ging/core/host/ports";

/** The menu's own entries, by a stable id: the E2E finds an entry by it
 *  (`Menu.getApplicationMenu().getMenuItemById`). Every entry of GING's own
 *  has one; Electron's role menus and the separators have none. */
export const MENU_IDS = {
  fileMenu: "ging.fileMenu",
  /** #394's three: offered once their handlers are (`AppMenuCommands`). */
  openFolder: "ging.openFolder",
  openRecent: "ging.openRecent",
  initRepository: "ging.initRepository",
  settings: "ging.settings",
  repositoryMenu: "ging.repositoryMenu",
  fetch: "ging.fetch",
  fetchRemote: "ging.fetchRemote",
  manageRemotes: "ging.manageRemotes",
  toggleRemoteVisibility: "ging.toggleRemoteVisibility",
  managePullRequestProviders: "ging.managePullRequestProviders",
  viewReflog: "ging.viewReflog",
  showStatistics: "ging.showStatistics",
  setGitUserDetails: "ging.setGitUserDetails",
  openTerminal: "ging.openTerminal",
  helpMenu: "ging.helpMenu",
  versionInfo: "ging.versionInfo"
} as const;

/** The id of Open Recent's entry for `repo`: stable for as long as the
 *  repository is on the list, wherever on it it is. */
export function openRecentId(repo: string): string {
  return `${MENU_IDS.openRecent}:${repo}`;
}

/**
 * What the entries do. None is handed the window the click came from — a
 * click from `MenuItem.click()` hands none — so each finds its target when it
 * runs: the focused Tab's graph, or the Welcome page where it may ask without
 * one (main.ts).
 */
export type AppMenuCommands = {
  /** Open the settings window, or bring it forward (#397). */
  openSettings(): void;
  // The focused Tab's graph: core's command services on its repository.
  fetch(): void;
  fetchRemote(): void;
  manageRemotes(): void;
  toggleRemoteVisibility(): void;
  viewReflog(): void;
  showStatistics(): void;
  /** The system's terminal, in the repository (`Opener.openTerminal`). */
  openTerminal(): void;
  // The app's: asked on the focused Tab's page, or the Welcome page.
  setGitUserDetails(): void;
  managePullRequestProviders(): void;
  /** Answered in a system dialog, so on any page or none. */
  versionInfo(): void;
  // #394's: each entry is in the menu once its handler is given here.
  openFolder?(): void;
  /** Open `repo`, one of `AppMenuState.recentRepos`. */
  openRecent?(repo: string): void;
  initRepository?(): void;
};

/** What the window shows in front, as far as the menu depends on it: the
 *  focused Tab's graph; a Tab with a notice in place of one, which has no
 *  instance to run a command and no listener to ask on; or, with no Tab, the
 *  Welcome page. */
export type MenuFocus = "graph" | "notice" | "welcome";

/** What the entries depend on. The main process builds the menu anew
 *  whenever it changes. */
export type AppMenuState = {
  focus: MenuFocus;
  /** Open Recent's entries, most recent first (#394). */
  recentRepos?: readonly string[];
};

/** `focus` for a focused Tab that shows a graph or not, or for no Tab. */
export function menuFocus(focused: { graph: boolean } | null): MenuFocus {
  if (focused === null) return "welcome";
  return focused.graph ? "graph" : "notice";
}

/**
 * The menu for `platform` in `state`: Electron's own Edit, View and Window
 * menus — the ones a window without a menu of its own would have had — and
 * GING's beside them. Which entry is enabled is said here, never changed on a
 * built menu:
 *
 * - The Repository menu's graph entries only while a graph is in front: they
 *   run on its repository.
 * - Set Git User Details and Manage Pull Request Providers ask, and need a
 *   page that listens: a graph's or the Welcome page's, not a notice's.
 * - Settings…, Version Information and #394's entries always.
 */
export function appMenuTemplate(
  l10n: L10n,
  commands: AppMenuCommands,
  platform: NodeJS.Platform,
  { focus, recentRepos = [] }: AppMenuState
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const hasGraph = focus === "graph";
  const canAsk = focus !== "notice";
  const item = (
    id: string,
    labelKey: string,
    click: () => void,
    extra: MenuItemConstructorOptions = {}
  ): MenuItemConstructorOptions => ({
    id,
    label: l10n.t(labelKey),
    click: () => click(),
    ...extra
  });
  const onGraph = (id: string, labelKey: string, click: () => void) =>
    item(id, labelKey, click, { enabled: hasGraph });

  const { openFolder, openRecent, initRepository } = commands;
  const opening: MenuItemConstructorOptions[] = [
    ...(openFolder
      ? [
          item(MENU_IDS.openFolder, "desktop.menu.openFolder", openFolder, {
            accelerator: "CmdOrCtrl+O"
          })
        ]
      : []),
    ...(openRecent
      ? [
          {
            id: MENU_IDS.openRecent,
            label: l10n.t("desktop.menu.openRecent"),
            enabled: recentRepos.length > 0,
            submenu: recentRepos.map((repo) => ({
              id: openRecentId(repo),
              label: repo,
              click: () => openRecent(repo)
            }))
          }
        ]
      : []),
    ...(initRepository
      ? [item(MENU_IDS.initRepository, "desktop.menu.initRepository", initRepository)]
      : [])
  ];

  return [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    // Electron's `fileMenu` role, spelled out to carry GING's entries (#397):
    // Close Window on macOS, Quit elsewhere, as the role has it.
    {
      id: MENU_IDS.fileMenu,
      label: l10n.t("desktop.menu.file"),
      submenu: [
        ...opening,
        ...(opening.length > 0 ? [{ type: "separator" } as const] : []),
        item(MENU_IDS.settings, "desktop.menu.settings", commands.openSettings, {
          accelerator: "CmdOrCtrl+,"
        }),
        { type: "separator" },
        { role: mac ? "close" : "quit" }
      ]
    },
    { role: "editMenu" },
    {
      id: MENU_IDS.repositoryMenu,
      label: l10n.t("desktop.menu.repository"),
      submenu: [
        onGraph(MENU_IDS.fetch, "desktop.menu.fetch", commands.fetch),
        onGraph(MENU_IDS.fetchRemote, "desktop.menu.fetchRemote", commands.fetchRemote),
        { type: "separator" },
        onGraph(MENU_IDS.manageRemotes, "desktop.menu.manageRemotes", commands.manageRemotes),
        onGraph(
          MENU_IDS.toggleRemoteVisibility,
          "desktop.menu.toggleRemoteVisibility",
          commands.toggleRemoteVisibility
        ),
        item(
          MENU_IDS.managePullRequestProviders,
          "desktop.menu.managePullRequestProviders",
          commands.managePullRequestProviders,
          { enabled: canAsk }
        ),
        { type: "separator" },
        onGraph(MENU_IDS.viewReflog, "desktop.menu.viewReflog", commands.viewReflog),
        onGraph(MENU_IDS.showStatistics, "desktop.menu.showStatistics", commands.showStatistics),
        { type: "separator" },
        item(
          MENU_IDS.setGitUserDetails,
          "desktop.menu.setGitUserDetails",
          commands.setGitUserDetails,
          { enabled: canAsk }
        ),
        onGraph(MENU_IDS.openTerminal, "desktop.menu.openTerminal", commands.openTerminal)
      ]
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      id: MENU_IDS.helpMenu,
      label: l10n.t("desktop.menu.help"),
      submenu: [item(MENU_IDS.versionInfo, "desktop.menu.versionInfo", commands.versionInfo)]
    }
  ];
}
