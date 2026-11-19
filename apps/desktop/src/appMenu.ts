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
  /** macOS only: the app menu, Settings… and Hide in it. */
  appMenu: "ging.appMenu",
  hide: "ging.hide",
  fileMenu: "ging.fileMenu",
  /** #394's three: offered once their handlers are (`AppMenuCommands`). */
  openFolder: "ging.openFolder",
  openRecent: "ging.openRecent",
  /** #395's: offered once its handler is. */
  cloneRepository: "ging.cloneRepository",
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
  /** #408's: a file picked, its history shown. */
  fileHistory: "ging.fileHistory",
  /** #409's: a file picked, the working tree's copy shown blamed. */
  blameFile: "ging.blameFile",
  setGitUserDetails: "ging.setGitUserDetails",
  openTerminal: "ging.openTerminal",
  viewMenu: "ging.viewMenu",
  /** #459's: shows or hides every Tab's side views' column. */
  sideViews: "ging.sideViews",
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
  /** A file of the repository picked, its history shown (#408). */
  fileHistory(): void;
  /** A file of the repository picked, shown blamed (#409). */
  blameFile(): void;
  /** The system's terminal, in the repository (`Opener.openTerminal`). */
  openTerminal(): void;
  // The app's: asked on the focused Tab's page, or the Welcome page.
  setGitUserDetails(): void;
  managePullRequestProviders(): void;
  /** Answered in a system dialog, so on any page or none. */
  versionInfo(): void;
  /** Show or hide the side views' column in every Tab (#459): the app's. */
  toggleSideViews(): void;
  /** macOS: hide the app (Electron's `hide` role, without its Cmd+H). */
  hideApp(): void;
  // #394's: each entry is in the menu once its handler is given here.
  openFolder?(): void;
  /** Open `repo`, one of `AppMenuState.recentRepos`. */
  openRecent?(repo: string): void;
  initRepository?(): void;
  /** #395's: in the menu once its handler is given here. */
  cloneRepository?(): void;
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
  /** A clone is being asked for or running (#395): there is one at a time. */
  cloning?: boolean;
  /** The side views' column is shown (#459); it is unless said otherwise. */
  sideViewsShown?: boolean;
};

/** `focus` for a focused Tab that shows a graph or not, or for no Tab. */
export function menuFocus(focused: { graph: boolean } | null): MenuFocus {
  if (focused === null) return "welcome";
  return focused.graph ? "graph" : "notice";
}

/** The graph's own keyboard shortcuts, as each defaults (`shortcuts.*`):
 *  `CmdOrCtrl` with one of these letters, Shift or not. No accelerator of the
 *  menu's may take one — an accelerator is the menu's before the page sees
 *  the key — and appMenu.test.ts holds the menu to it. */
export const GRAPH_SHORTCUT_KEYS = ["F", "R", "H", "S"] as const;

/**
 * The menu for `platform` in `state`: GING's menus, and beside them Electron's
 * Edit and Window menus — the ones a window without a menu of its own would
 * have had. The macOS app menu and the View menu are Electron's roles spelled
 * out, each without what took a graph shortcut: Hide's Cmd+H (scrollToHead's
 * Cmd+H), Reload and Force Reload (refresh's CmdOrCtrl+R), and on macOS
 * Toggle Full Screen's Control+Command+F (Find's). Which entry is
 * enabled is said here, never changed on a built menu:
 *
 * - The Repository menu's graph entries only while a graph is in front: they
 *   run on its repository.
 * - Set Git User Details and Manage Pull Request Providers ask, and need a
 *   page that listens: a graph's or the Welcome page's, not a notice's.
 * - Settings… and Version Information always.
 * - Clone Repository… whatever is in front, but not while a clone is under
 *   way: one at a time. Its progress and credential prompts are drawn on the
 *   Welcome page (#395), which is brought forward over a Tab for it (#461).
 *   #394's entries, which open a Tab, likewise not while a clone is under
 *   way; otherwise always.
 *
 * Settings… is in the app menu on macOS, as the platform has it, and in the
 * File menu elsewhere.
 */
export function appMenuTemplate(
  l10n: L10n,
  commands: AppMenuCommands,
  platform: NodeJS.Platform,
  { focus, recentRepos = [], cloning = false, sideViewsShown = true }: AppMenuState
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const hasGraph = focus === "graph";
  const canAsk = focus !== "notice";
  /** `text` as a label: outside macOS, `&` marks the next letter as the
   *  entry's mnemonic and is not shown, so a `&` meant as one is doubled. */
  const label = (text: string) => (mac ? text : text.replaceAll("&", "&&"));
  const item = (
    id: string,
    labelKey: string,
    click: () => void,
    extra: MenuItemConstructorOptions = {}
  ): MenuItemConstructorOptions => ({
    id,
    label: label(l10n.t(labelKey)),
    click: () => click(),
    ...extra
  });
  const onGraph = (id: string, labelKey: string, click: () => void) =>
    item(id, labelKey, click, { enabled: hasGraph });
  const separator = { type: "separator" } as const;
  const settings = item(MENU_IDS.settings, "desktop.menu.settings", commands.openSettings, {
    accelerator: "CmdOrCtrl+,"
  });

  const { openFolder, openRecent, initRepository, cloneRepository } = commands;
  const opening: MenuItemConstructorOptions[] = [
    ...(openFolder
      ? [
          item(MENU_IDS.openFolder, "desktop.menu.openFolder", openFolder, {
            accelerator: "CmdOrCtrl+O",
            enabled: !cloning
          })
        ]
      : []),
    ...(openRecent
      ? [
          {
            id: MENU_IDS.openRecent,
            label: label(l10n.t("desktop.menu.openRecent")),
            enabled: recentRepos.length > 0 && !cloning,
            submenu: recentRepos.map((repo) => ({
              id: openRecentId(repo),
              label: label(repo),
              click: () => openRecent(repo)
            }))
          }
        ]
      : []),
    ...(cloneRepository
      ? [
          item(MENU_IDS.cloneRepository, "desktop.menu.cloneRepository", cloneRepository, {
            enabled: !cloning
          })
        ]
      : []),
    ...(initRepository
      ? [
          item(MENU_IDS.initRepository, "desktop.menu.initRepository", initRepository, {
            enabled: !cloning
          })
        ]
      : [])
  ];
  // A separator between each group there is.
  const fileGroups: MenuItemConstructorOptions[][] = [
    opening,
    mac ? [] : [settings],
    // Electron's `fileMenu` role: Close Window on macOS, Quit elsewhere.
    [{ role: mac ? ("close" as const) : ("quit" as const) }]
  ].filter((group) => group.length > 0);

  return [
    // Electron's `appMenu` role, with Settings… and a Hide that leaves Cmd+H
    // to the graph.
    ...(mac
      ? [
          {
            id: MENU_IDS.appMenu,
            label: "GING",
            submenu: [
              { role: "about" },
              separator,
              settings,
              separator,
              { role: "services" },
              separator,
              item(MENU_IDS.hide, "desktop.menu.hide", commands.hideApp),
              { role: "hideOthers" },
              { role: "unhide" },
              separator,
              { role: "quit" }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      id: MENU_IDS.fileMenu,
      label: label(l10n.t("desktop.menu.file")),
      submenu: fileGroups.flatMap((group, i) =>
        i === 0 ? group : [separator as MenuItemConstructorOptions].concat(group)
      )
    },
    { role: "editMenu" },
    {
      id: MENU_IDS.repositoryMenu,
      label: label(l10n.t("desktop.menu.repository")),
      submenu: [
        onGraph(MENU_IDS.fetch, "desktop.menu.fetch", commands.fetch),
        onGraph(MENU_IDS.fetchRemote, "desktop.menu.fetchRemote", commands.fetchRemote),
        separator,
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
        separator,
        onGraph(MENU_IDS.viewReflog, "desktop.menu.viewReflog", commands.viewReflog),
        onGraph(MENU_IDS.showStatistics, "desktop.menu.showStatistics", commands.showStatistics),
        onGraph(MENU_IDS.fileHistory, "desktop.menu.fileHistory", commands.fileHistory),
        onGraph(MENU_IDS.blameFile, "desktop.menu.blameFile", commands.blameFile),
        separator,
        item(
          MENU_IDS.setGitUserDetails,
          "desktop.menu.setGitUserDetails",
          commands.setGitUserDetails,
          { enabled: canAsk }
        ),
        onGraph(MENU_IDS.openTerminal, "desktop.menu.openTerminal", commands.openTerminal)
      ]
    },
    // Electron's `viewMenu` role without Reload and Force Reload: the graph's
    // own refresh is CmdOrCtrl+R, and reloading a page is not refreshing it.
    {
      id: MENU_IDS.viewMenu,
      label: label(l10n.t("desktop.menu.view")),
      submenu: [
        // The side views' column in every Tab (#459): the app's, as the
        // layout it remembers is. Always offered — with no Tab, the Tab
        // opened next follows it. No accelerator: a key of its own would be
        // one fewer for the graph.
        item(MENU_IDS.sideViews, "desktop.menu.sideViews", commands.toggleSideViews, {
          type: "checkbox",
          checked: sideViewsShown
        }),
        separator,
        { role: "toggleDevTools" },
        separator,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        // Not on macOS, whose Control+Command+F is the graph's Find too (the
        // graph reads Control as well as Command): macOS puts its own Enter
        // Full Screen in the menus.
        ...(mac ? [] : [separator, { role: "togglefullscreen" } as const])
      ]
    },
    { role: "windowMenu" },
    {
      id: MENU_IDS.helpMenu,
      label: label(l10n.t("desktop.menu.help")),
      // The Help menu macOS knows as one, with its search field.
      ...(mac && { role: "help" as const }),
      submenu: [item(MENU_IDS.versionInfo, "desktop.menu.versionInfo", commands.versionInfo)]
    }
  ];
}
