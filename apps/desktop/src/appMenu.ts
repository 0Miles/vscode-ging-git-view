/* The desktop host's application menu, as data: what Electron builds with
 * `Menu.buildFromTemplate`, kept apart from Electron so vitest can read it
 * (ADR-0032). Its own entries reach core's command services, whose questions
 * come up in the host prompt overlay (#390). Today one: fetching a remote of
 * the graph's choosing. #396 grows it into the app's whole menu. */

import type { MenuItemConstructorOptions } from "electron";

import type { L10n } from "@ging/core/host/ports";

/** The menu's own entries, by a stable id: the E2E finds an entry by it
 *  (`Menu.getApplicationMenu().getMenuItemById`), and so does the main process
 *  to enable it. */
export const MENU_IDS = {
  fetchRemote: "ging.fetchRemote"
} as const;

/** What the entries do, for the graph shown in the window. */
export type AppMenuCommands = {
  fetchRemote(): void;
};

/**
 * The menu for `platform`: Electron's own menus — the ones a window without a
 * menu of its own would have had — and GING's beside them.
 */
export function appMenuTemplate(
  l10n: L10n,
  commands: AppMenuCommands,
  platform: NodeJS.Platform
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
          click: () => commands.fetchRemote()
        }
      ]
    },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
}
