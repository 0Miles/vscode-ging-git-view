/* The desktop host's application menu, as data: what Electron builds with
 * `Menu.buildFromTemplate`, kept apart from Electron so vitest can read it —
 * labels, ids and when each entry is enabled (ADR-0032). Its own entries reach
 * core's command services, whose questions come up in the host prompt overlay
 * (#390). Today two: the settings (#397), and fetching a remote of the
 * graph's choosing. #396 grows it into the app's whole menu. */

import type { MenuItemConstructorOptions } from "electron";

import type { L10n } from "@ging/core/host/ports";

/** The menu's own entries, by a stable id: the E2E finds an entry by it
 *  (`Menu.getApplicationMenu().getMenuItemById`). */
export const MENU_IDS = {
  openFolder: "ging.openFolder",
  initRepo: "ging.initRepo",
  settings: "ging.settings",
  fetchRemote: "ging.fetchRemote"
} as const;

/** What the entries do: for the graph shown in the window, or the app's. */
export type AppMenuCommands = {
  /** Ask for a folder and open its repository in a Tab (#394). */
  openFolder(): void;
  /** Ask for a folder, make a repository there and open it (#394). */
  initRepo(): void;
  fetchRemote(): void;
  /** Open the settings window, or bring it forward (#397). */
  openSettings(): void;
};

/** What the window shows, as far as the menu's entries depend on it. The
 *  main process builds the menu anew whenever this changes. */
export type AppMenuState = {
  /** A graph, with the webview instance behind it that runs the commands. */
  hasGraph: boolean;
};

/**
 * The menu for `platform` in `state`: Electron's own menus — the ones a
 * window without a menu of its own would have had — and GING's beside them,
 * the graph's entries enabled only while there is a graph. Open Folder…,
 * Initialize Repository… and Settings… are the app's, there with or without
 * one: with a Tab open, the menu is the way to another repository, since the
 * Tab covers the Welcome page that offers them too (#394).
 */
export function appMenuTemplate(
  l10n: L10n,
  commands: AppMenuCommands,
  platform: NodeJS.Platform,
  { hasGraph }: AppMenuState
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  return [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    // Electron's `fileMenu` role, spelled out to carry Settings… (#397):
    // Close Window on macOS, Quit elsewhere, as the role has it.
    {
      label: l10n.t("desktop.menu.file"),
      submenu: [
        {
          id: MENU_IDS.openFolder,
          label: l10n.t("desktop.openFolder"),
          accelerator: "CmdOrCtrl+O",
          click: () => commands.openFolder()
        },
        {
          id: MENU_IDS.initRepo,
          label: l10n.t("desktop.initRepo"),
          click: () => commands.initRepo()
        },
        { type: "separator" },
        {
          id: MENU_IDS.settings,
          label: l10n.t("desktop.menu.settings"),
          accelerator: "CmdOrCtrl+,",
          click: () => commands.openSettings()
        },
        { type: "separator" },
        { role: mac ? "close" : "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: l10n.t("desktop.menu.repository"),
      submenu: [
        {
          id: MENU_IDS.fetchRemote,
          label: l10n.t("desktop.menu.fetchRemote"),
          enabled: hasGraph,
          click: () => commands.fetchRemote()
        }
      ]
    },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
}
