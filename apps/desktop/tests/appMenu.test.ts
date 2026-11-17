import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { appMenuTemplate, MENU_IDS } from "@ging/desktop/appMenu";

// The application menu as data (ADR-0032): what Electron builds it from, read
// without Electron. Its entries are found by a stable id, the E2E's way in,
// and when each is enabled is the template's to say: a direct `click()` does
// not check it, so this is where it is held.

const l10n = { t: (key: string) => `<${key}>` };
const noCommands = {
  openFolder: () => {},
  initRepo: () => {},
  fetchRemote: () => {},
  openSettings: () => {}
};

/** Every item of `template`, submenus included. */
function itemsOf(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? itemsOf(item.submenu) : [])
  ]);
}

function entry(template: MenuItemConstructorOptions[], id: string) {
  return itemsOf(template).find((item) => item.id === id);
}

describe("the application menu", () => {
  it("runs the graph's fetchRemote from its entry, labelled in the app's language", () => {
    const fetchRemote = vi.fn();
    const item = entry(
      appMenuTemplate(l10n, { ...noCommands, fetchRemote }, "win32", { hasGraph: true }),
      MENU_IDS.fetchRemote
    );

    expect(item?.label).toBe("<desktop.menu.fetchRemote>");
    const click = item?.click as (() => void) | undefined;
    click?.();
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("offers fetchRemote only while a graph is shown", () => {
    const enabled = (hasGraph: boolean) =>
      entry(appMenuTemplate(l10n, noCommands, "linux", { hasGraph }), MENU_IDS.fetchRemote)
        ?.enabled;

    expect(enabled(true)).toBe(true);
    expect(enabled(false)).toBe(false);
  });

  it("opens the settings from Settings… on CmdOrCtrl+, with or without a graph", () => {
    for (const hasGraph of [true, false]) {
      const openSettings = vi.fn();
      const item = entry(
        appMenuTemplate(l10n, { ...noCommands, openSettings }, "linux", { hasGraph }),
        MENU_IDS.settings
      );

      expect(item?.label).toBe("<desktop.menu.settings>");
      expect(item?.accelerator).toBe("CmdOrCtrl+,");
      expect(item?.enabled).not.toBe(false);
      (item?.click as (() => void) | undefined)?.();
      expect(openSettings).toHaveBeenCalledTimes(1);
    }
  });

  it("opens a folder from Open Folder… on CmdOrCtrl+O, and initializes one from its entry, with or without a graph", () => {
    for (const hasGraph of [true, false]) {
      const openFolder = vi.fn();
      const initRepo = vi.fn();
      const template = appMenuTemplate(l10n, { ...noCommands, openFolder, initRepo }, "linux", {
        hasGraph
      });
      const open = entry(template, MENU_IDS.openFolder);
      const init = entry(template, MENU_IDS.initRepo);

      expect(open?.label).toBe("<desktop.openFolder>");
      expect(open?.accelerator).toBe("CmdOrCtrl+O");
      expect(init?.label).toBe("<desktop.initRepo>");
      expect([open?.enabled, init?.enabled]).not.toContain(false);
      (open?.click as (() => void) | undefined)?.();
      (init?.click as (() => void) | undefined)?.();
      expect([openFolder.mock.calls.length, initRepo.mock.calls.length]).toEqual([1, 1]);
    }
  });

  it("keeps Electron's own menus, the app menu only where the platform has one", () => {
    const roles = (platform: NodeJS.Platform) =>
      appMenuTemplate(l10n, noCommands, platform, { hasGraph: true })
        .map((item) => item.role)
        .filter((role) => role !== undefined);

    expect(roles("win32")).toEqual(["editMenu", "viewMenu", "windowMenu"]);
    expect(roles("darwin")).toEqual(["appMenu", "editMenu", "viewMenu", "windowMenu"]);
  });

  it("spells the File menu out as Electron's role has it, after Open Folder…, Initialize Repository… and Settings…", () => {
    const file = (platform: NodeJS.Platform) =>
      appMenuTemplate(l10n, noCommands, platform, { hasGraph: true }).find(
        (item) => item.label === "<desktop.menu.file>"
      )?.submenu as MenuItemConstructorOptions[];

    expect(file("win32").map((item) => item.id ?? item.role ?? item.type)).toEqual([
      MENU_IDS.openFolder,
      MENU_IDS.initRepo,
      "separator",
      MENU_IDS.settings,
      "separator",
      "quit"
    ]);
    expect(file("darwin").at(-1)?.role).toBe("close");
  });

  it("gives every entry of its own an id no other entry has", () => {
    const ids = itemsOf(appMenuTemplate(l10n, noCommands, "linux", { hasGraph: true }))
      .map((item) => item.id)
      .filter((id) => id !== undefined);

    expect(ids).toEqual(Object.values(MENU_IDS));
  });
});
