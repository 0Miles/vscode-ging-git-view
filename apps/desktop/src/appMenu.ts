/* The desktop host's application menu, as data: what Electron builds with
 * `Menu.buildFromTemplate`, kept apart from Electron so vitest can read it —
 * labels, ids and when each entry is enabled (ADR-0032). Its own entries reach
 * core's command services, whose questions come up in the host prompt overlay
 * (#390). Today one: fetching a remote of the graph's choosing. #396 grows it
 * into the app's whole menu. */

import type { MenuItemConstructorOptions } from "electron";

import type { L10n } from "@ging/core/host/ports";

/** The menu's own entries, by a stable id: the E2E finds an entry by it
 *  (`Menu.getApplicationMenu().getMenuItemById`). */
export const MENU_IDS = {
  fetchRemote: "ging.fetchRemote"
} as const;

/** What the entries do, for the graph shown in the window. */
export type AppMenuCommands = {
  fetchRemote(): void;
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
 * the graph's entries enabled only while there is a graph.
 */
export function appMenuTemplate(
  l10n: L10n,
  commands: AppMenuCommands,
  platform: NodeJS.Platform,
  { hasGraph }: AppMenuState
): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
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
