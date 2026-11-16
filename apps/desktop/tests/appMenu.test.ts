import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { appMenuTemplate, MENU_IDS } from "@ging/desktop/appMenu";

// The application menu as data (ADR-0032): what Electron builds it from, read
// without Electron. Its entries are found by a stable id, the E2E's way in.

const l10n = { t: (key: string) => `<${key}>` };

/** Every item of `template`, submenus included. */
function itemsOf(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? itemsOf(item.submenu) : [])
  ]);
}

describe("the application menu", () => {
  it("runs the graph's fetchRemote from its entry, labelled in the app's language", () => {
    const fetchRemote = vi.fn();
    const entry = itemsOf(appMenuTemplate(l10n, { fetchRemote }, "win32")).find(
      (item) => item.id === MENU_IDS.fetchRemote
    );

    expect(entry?.label).toBe("<desktop.menu.fetchRemote>");
    const click = entry?.click as (() => void) | undefined;
    click?.();
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps Electron's own menus, the app menu only where the platform has one", () => {
    const roles = (platform: NodeJS.Platform) =>
      appMenuTemplate(l10n, { fetchRemote: () => {} }, platform)
        .map((item) => item.role)
        .filter((role) => role !== undefined);

    expect(roles("win32")).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
    expect(roles("darwin")).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  });

  it("gives every entry of its own an id no other entry has", () => {
    const ids = itemsOf(appMenuTemplate(l10n, { fetchRemote: () => {} }, "linux"))
      .map((item) => item.id)
      .filter((id) => id !== undefined);

    expect(ids).toEqual(Object.values(MENU_IDS));
  });
});
