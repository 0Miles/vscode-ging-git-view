import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  type AppMenuCommands,
  type AppMenuState,
  appMenuTemplate,
  MENU_IDS,
  type MenuFocus,
  menuFocus,
  openRecentId
} from "@ging/desktop/appMenu";

// The application menu as data (ADR-0032): what Electron builds it from, read
// without Electron. Its entries are found by a stable id, the E2E's way in,
// and when each is enabled is the template's to say: a direct `click()` does
// not check it, so this is where it is held. Accelerators are held here too:
// Playwright cannot press one (microsoft/playwright#8004).

const l10n = { t: (key: string) => `<${key}>` };
const FOCUSES: readonly MenuFocus[] = ["graph", "notice", "welcome"];

/** Every command, each a mock of its own. */
function mockCommands(): { [K in keyof AppMenuCommands]-?: Mock<(repo?: string) => void> } {
  return {
    openSettings: vi.fn(),
    fetch: vi.fn(),
    fetchRemote: vi.fn(),
    manageRemotes: vi.fn(),
    toggleRemoteVisibility: vi.fn(),
    viewReflog: vi.fn(),
    showStatistics: vi.fn(),
    openTerminal: vi.fn(),
    setGitUserDetails: vi.fn(),
    managePullRequestProviders: vi.fn(),
    versionInfo: vi.fn(),
    openFolder: vi.fn(),
    openRecent: vi.fn(),
    initRepository: vi.fn()
  };
}

/** The commands as main.ts gives them today: without #394's. */
function withoutOpening(): AppMenuCommands {
  const { openFolder: _f, openRecent: _r, initRepository: _i, ...today } = mockCommands();
  return today;
}

function template(
  commands: AppMenuCommands = withoutOpening(),
  state: AppMenuState = { focus: "graph" },
  platform: NodeJS.Platform = "linux"
) {
  return appMenuTemplate(l10n, commands, platform, state);
}

/** Every item of `items`, submenus included. */
function itemsOf(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? itemsOf(item.submenu) : [])
  ]);
}

function entry(items: MenuItemConstructorOptions[], id: string) {
  return itemsOf(items).find((item) => item.id === id);
}

/** What `items` are, one word each: an entry's id, a role, or a separator. */
function shape(items: MenuItemConstructorOptions[]) {
  return items.map((item) => item.id ?? item.role ?? item.type);
}

/** Click `item` as `MenuItem.click()` does from the E2E: no window, no event. */
function click(item: MenuItemConstructorOptions | undefined) {
  (item?.click as ((...args: unknown[]) => void) | undefined)?.(undefined, undefined, undefined);
}

/**
 * Each entry of GING's own: its id, its label's key, the command it runs, its
 * accelerator, and the focuses it is enabled in.
 */
const ENTRIES: readonly {
  id: string;
  label: string;
  command: keyof AppMenuCommands;
  accelerator?: string;
  enabledIn: readonly MenuFocus[];
}[] = [
  {
    id: MENU_IDS.settings,
    label: "desktop.menu.settings",
    command: "openSettings",
    accelerator: "CmdOrCtrl+,",
    enabledIn: FOCUSES
  },
  { id: MENU_IDS.fetch, label: "desktop.menu.fetch", command: "fetch", enabledIn: ["graph"] },
  {
    id: MENU_IDS.fetchRemote,
    label: "desktop.menu.fetchRemote",
    command: "fetchRemote",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.manageRemotes,
    label: "desktop.menu.manageRemotes",
    command: "manageRemotes",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.toggleRemoteVisibility,
    label: "desktop.menu.toggleRemoteVisibility",
    command: "toggleRemoteVisibility",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.managePullRequestProviders,
    label: "desktop.menu.managePullRequestProviders",
    command: "managePullRequestProviders",
    enabledIn: ["graph", "welcome"]
  },
  {
    id: MENU_IDS.viewReflog,
    label: "desktop.menu.viewReflog",
    command: "viewReflog",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.showStatistics,
    label: "desktop.menu.showStatistics",
    command: "showStatistics",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.setGitUserDetails,
    label: "desktop.menu.setGitUserDetails",
    command: "setGitUserDetails",
    enabledIn: ["graph", "welcome"]
  },
  {
    id: MENU_IDS.openTerminal,
    label: "desktop.menu.openTerminal",
    command: "openTerminal",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.versionInfo,
    label: "desktop.menu.versionInfo",
    command: "versionInfo",
    enabledIn: FOCUSES
  },
  // #394's, once their handlers are given.
  {
    id: MENU_IDS.openFolder,
    label: "desktop.menu.openFolder",
    command: "openFolder",
    accelerator: "CmdOrCtrl+O",
    enabledIn: FOCUSES
  },
  {
    id: MENU_IDS.initRepository,
    label: "desktop.menu.initRepository",
    command: "initRepository",
    enabledIn: FOCUSES
  }
];

describe("the application menu", () => {
  describe.each(ENTRIES)("$id", ({ id, label, command, accelerator, enabledIn }) => {
    it("runs its command, labelled in the app's language, with no window handed to it", () => {
      const commands = mockCommands();
      const item = entry(template(commands), id);

      expect(item?.label).toBe(`<${label}>`);
      click(item);
      expect(commands[command]).toHaveBeenCalledTimes(1);
      // Its target is looked up by the command, not taken from the click.
      expect(commands[command]).toHaveBeenCalledWith();
    });

    it(`has ${accelerator ?? "no"} accelerator`, () => {
      expect(entry(template(mockCommands()), id)?.accelerator).toBe(accelerator);
    });

    it.each(FOCUSES)("is enabled with focus %s as its rule says", (focus) => {
      const item = entry(template(mockCommands(), { focus }), id);
      // Enabled is Electron's default: `undefined` is enabled.
      expect(item?.enabled ?? true).toBe(enabledIn.includes(focus));
    });
  });

  it("offers #394's entries only once their handlers are given", () => {
    const items = template(withoutOpening());

    for (const id of [MENU_IDS.openFolder, MENU_IDS.openRecent, MENU_IDS.initRepository]) {
      expect(entry(items, id)).toBeUndefined();
    }
  });

  it("lists Open Recent's repositories, each by an id of its own, and opens the one clicked", () => {
    const commands = mockCommands();
    const recent = ["/work/a", "/work/b"];
    const items = template(commands, { focus: "welcome", recentRepos: recent });

    const submenu = entry(items, MENU_IDS.openRecent)?.submenu as MenuItemConstructorOptions[];
    expect(submenu.map((item) => [item.id, item.label])).toEqual([
      [openRecentId("/work/a"), "/work/a"],
      [openRecentId("/work/b"), "/work/b"]
    ]);
    click(entry(items, openRecentId("/work/b")));
    expect(commands.openRecent).toHaveBeenCalledWith("/work/b");
    // Nothing to open: there, but not offered.
    expect(entry(template(commands, { focus: "graph" }), MENU_IDS.openRecent)?.enabled).toBe(false);
  });

  it("keeps Electron's own menus, the app menu only where the platform has one", () => {
    const roles = (platform: NodeJS.Platform) =>
      template(withoutOpening(), { focus: "graph" }, platform)
        .map((item) => item.role)
        .filter((role) => role !== undefined);

    expect(roles("win32")).toEqual(["editMenu", "viewMenu", "windowMenu"]);
    expect(roles("darwin")).toEqual(["appMenu", "editMenu", "viewMenu", "windowMenu"]);
  });

  it("spells the File menu out as Electron's role has it, GING's entries above Close or Quit", () => {
    const file = (commands: AppMenuCommands, platform: NodeJS.Platform) =>
      entry(template(commands, { focus: "graph" }, platform), MENU_IDS.fileMenu)
        ?.submenu as MenuItemConstructorOptions[];

    expect(shape(file(withoutOpening(), "win32"))).toEqual([
      MENU_IDS.settings,
      "separator",
      "quit"
    ]);
    expect(shape(file(mockCommands(), "win32"))).toEqual([
      MENU_IDS.openFolder,
      MENU_IDS.openRecent,
      MENU_IDS.initRepository,
      "separator",
      MENU_IDS.settings,
      "separator",
      "quit"
    ]);
    expect(file(withoutOpening(), "darwin").at(-1)?.role).toBe("close");
  });

  it("gives every entry of its own an id no other entry has", () => {
    const items = itemsOf(template(mockCommands(), { focus: "graph", recentRepos: ["/r"] }));
    const ours = items.filter((item) => item.role === undefined && item.type !== "separator");
    const ids = ours.map((item) => item.id);

    expect(ids.every((id) => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(Object.values(MENU_IDS)));
  });

  it("takes its focus from the focused Tab: its graph, its notice, or no Tab at all", () => {
    expect(menuFocus({ graph: true })).toBe("graph");
    expect(menuFocus({ graph: false })).toBe("notice");
    expect(menuFocus(null)).toBe("welcome");
  });
});
