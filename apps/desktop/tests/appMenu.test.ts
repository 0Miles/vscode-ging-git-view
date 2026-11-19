import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  type AppMenuCommands,
  type AppMenuState,
  appMenuTemplate,
  GRAPH_SHORTCUT_KEYS,
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
    fileHistory: vi.fn(),
    blameFile: vi.fn(),
    openTerminal: vi.fn(),
    setGitUserDetails: vi.fn(),
    managePullRequestProviders: vi.fn(),
    versionInfo: vi.fn(),
    hideApp: vi.fn(),
    openFolder: vi.fn(),
    openRecent: vi.fn(),
    initRepository: vi.fn(),
    cloneRepository: vi.fn()
  };
}

/** The commands without the optional ones: #394's and #395's. */
function withoutOpening(): AppMenuCommands {
  const {
    openFolder: _f,
    openRecent: _r,
    initRepository: _i,
    cloneRepository: _c,
    ...today
  } = mockCommands();
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

/**
 * The accelerators a role brings — its own, and for a role menu its entries' —
 * as Electron gives them (its `roles.ts`, Electron 45). The template never
 * sees them, so they are written out here, for each role the template uses.
 */
function roleAccelerators(role: string, platform: NodeJS.Platform): string[] {
  const mac = platform === "darwin";
  const own: Record<string, string[]> = {
    undo: ["CommandOrControl+Z"],
    redo: [platform === "win32" ? "Control+Y" : "Shift+CommandOrControl+Z"],
    cut: ["CommandOrControl+X"],
    copy: ["CommandOrControl+C"],
    paste: ["CommandOrControl+V"],
    pasteAndMatchStyle: ["Shift+CommandOrControl+V"],
    selectAll: ["CommandOrControl+A"],
    minimize: ["CommandOrControl+M"],
    close: ["CommandOrControl+W"],
    quit: platform === "win32" ? [] : ["CommandOrControl+Q"],
    toggleDevTools: [mac ? "Alt+Command+I" : "Ctrl+Shift+I"],
    resetZoom: ["CommandOrControl+0"],
    zoomIn: ["CommandOrControl+Plus"],
    zoomOut: ["CommandOrControl+-"],
    togglefullscreen: [mac ? "Control+Command+F" : "F11"],
    hide: ["Command+H"],
    hideOthers: ["Command+Alt+H"],
    reload: ["CommandOrControl+R"],
    forceReload: ["Shift+CommandOrControl+R"]
  };
  const menus: Record<string, string[]> = {
    editMenu: [
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      ...(mac ? ["pasteAndMatchStyle"] : []),
      "selectAll"
    ],
    // Not used: here so that using one again is caught.
    viewMenu: [
      "reload",
      "forceReload",
      "toggleDevTools",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "togglefullscreen"
    ],
    appMenu: ["hide", "hideOthers", "quit"],
    windowMenu: ["minimize", ...(mac ? [] : ["close"])]
  };
  return (menus[role] ?? [role]).flatMap((name) => own[name] ?? []);
}

/** Whether `accelerator` is a graph shortcut's default — Control or Command
 *  with F, R, H or S, Shift or not, as the graph reads either — but not with
 *  Alt, which hands the page another key (and is AltGr on Windows). */
function takesGraphShortcut(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.at(-1)!.toUpperCase();
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase());
  const ctrlOrCmd = modifiers.some((m) =>
    ["cmdorctrl", "commandorcontrol", "cmd", "command", "ctrl", "control"].includes(m)
  );
  const alt = modifiers.some((m) => ["alt", "option", "altgr"].includes(m));
  return ctrlOrCmd && !alt && (GRAPH_SHORTCUT_KEYS as readonly string[]).includes(key);
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
    id: MENU_IDS.fileHistory,
    label: "desktop.menu.fileHistory",
    command: "fileHistory",
    enabledIn: ["graph"]
  },
  {
    id: MENU_IDS.blameFile,
    label: "desktop.menu.blameFile",
    command: "blameFile",
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
  },
  // #395's, asked and shown on the Welcome page, which is brought forward
  // over a Tab for it (#461): whatever is in front.
  {
    id: MENU_IDS.cloneRepository,
    label: "desktop.menu.cloneRepository",
    command: "cloneRepository",
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

  it("offers #394's and #395's entries only once their handlers are given", () => {
    const items = template(withoutOpening());

    for (const id of [
      MENU_IDS.openFolder,
      MENU_IDS.openRecent,
      MENU_IDS.cloneRepository,
      MENU_IDS.initRepository
    ]) {
      expect(entry(items, id)).toBeUndefined();
    }
  });

  // While a clone is asked for or running, nothing that would open a Tab over
  // the Welcome page its prompts and progress are drawn on (#395).
  it.each([
    [MENU_IDS.cloneRepository, true, false],
    [MENU_IDS.openFolder, true, false],
    [MENU_IDS.openRecent, true, false],
    [MENU_IDS.initRepository, true, false],
    [MENU_IDS.settings, true, true],
    [MENU_IDS.versionInfo, true, true],
    [MENU_IDS.setGitUserDetails, true, true]
  ])("enables %s %s with no clone, %s with one under way", (id, idle, cloning) => {
    const enabled = (busy: boolean) =>
      entry(template(mockCommands(), { focus: "welcome", recentRepos: ["/r"], cloning: busy }), id)
        ?.enabled ?? true;

    expect(enabled(false)).toBe(idle);
    expect(enabled(true)).toBe(cloning);
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

  it("keeps Electron's Edit and Window menus, and spells the others out with ids of GING's", () => {
    const menus = (platform: NodeJS.Platform) =>
      template(withoutOpening(), { focus: "graph" }, platform).map((item) => item.id ?? item.role);

    expect(menus("win32")).toEqual([
      MENU_IDS.fileMenu,
      "editMenu",
      MENU_IDS.repositoryMenu,
      MENU_IDS.viewMenu,
      "windowMenu",
      MENU_IDS.helpMenu
    ]);
    expect(menus("darwin")).toEqual([
      MENU_IDS.appMenu,
      MENU_IDS.fileMenu,
      "editMenu",
      MENU_IDS.repositoryMenu,
      MENU_IDS.viewMenu,
      "windowMenu",
      MENU_IDS.helpMenu
    ]);
  });

  it("puts Settings… and a Hide of GING's own in the macOS app menu, and Help where macOS looks for it", () => {
    const commands = mockCommands();
    const items = template(commands, { focus: "notice" }, "darwin");
    const appMenu = entry(items, MENU_IDS.appMenu)?.submenu as MenuItemConstructorOptions[];

    expect(shape(appMenu)).toEqual([
      "about",
      "separator",
      MENU_IDS.settings,
      "separator",
      "services",
      "separator",
      MENU_IDS.hide,
      "hideOthers",
      "unhide",
      "separator",
      "quit"
    ]);
    const hide = entry(items, MENU_IDS.hide);
    expect(hide?.label).toBe("<desktop.menu.hide>");
    // Not the `hide` role, whose Cmd+H is scrollToHead's.
    expect(hide?.accelerator).toBeUndefined();
    click(hide);
    expect(commands.hideApp).toHaveBeenCalledWith();
    expect(entry(items, MENU_IDS.helpMenu)?.role).toBe("help");
    expect(entry(template(commands), MENU_IDS.helpMenu)?.role).toBeUndefined();
    expect(entry(template(commands), MENU_IDS.appMenu)).toBeUndefined();
  });

  it("spells the View menu out without Reload, which would take the graph's refresh", () => {
    const view = (platform: NodeJS.Platform) =>
      shape(
        entry(template(withoutOpening(), { focus: "graph" }, platform), MENU_IDS.viewMenu)
          ?.submenu as MenuItemConstructorOptions[]
      );

    expect(view("win32")).toEqual([
      "toggleDevTools",
      "separator",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "separator",
      "togglefullscreen"
    ]);
    expect(view("darwin")).toEqual([
      "toggleDevTools",
      "separator",
      "resetZoom",
      "zoomIn",
      "zoomOut"
    ]);
  });

  it.each(["win32", "linux", "darwin"] as const)(
    "takes none of the graph's default shortcuts on %s, its own accelerators or its roles'",
    (platform) => {
      const items = itemsOf(template(mockCommands(), { focus: "graph" }, platform));
      const accelerators = items.flatMap((item) =>
        (typeof item.accelerator === "string" ? [item.accelerator] : []).concat(
          item.role === undefined ? [] : roleAccelerators(item.role, platform)
        )
      );

      expect(accelerators.length).toBeGreaterThan(0);
      expect(accelerators.filter(takesGraphShortcut)).toEqual([]);
    }
  );

  it("doubles a label's & outside macOS, where a single one marks a mnemonic", () => {
    const amp = {
      t: (key: string) => (key === "desktop.menu.setGitUserDetails" ? "Name & Email" : key)
    };
    const label = (platform: NodeJS.Platform, id: string) =>
      entry(
        appMenuTemplate(amp, mockCommands(), platform, { focus: "graph", recentRepos: ["/R&D"] }),
        id
      )?.label;

    expect(label("win32", MENU_IDS.setGitUserDetails)).toBe("Name && Email");
    expect(label("linux", openRecentId("/R&D"))).toBe("/R&&D");
    expect(label("darwin", MENU_IDS.setGitUserDetails)).toBe("Name & Email");
    expect(label("darwin", openRecentId("/R&D"))).toBe("/R&D");
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
      MENU_IDS.cloneRepository,
      MENU_IDS.initRepository,
      "separator",
      MENU_IDS.settings,
      "separator",
      "quit"
    ]);
    // Settings… is in the app menu there.
    expect(shape(file(withoutOpening(), "darwin"))).toEqual(["close"]);
    expect(shape(file(mockCommands(), "darwin"))).toEqual([
      MENU_IDS.openFolder,
      MENU_IDS.openRecent,
      MENU_IDS.cloneRepository,
      MENU_IDS.initRepository,
      "separator",
      "close"
    ]);
  });

  it("gives every entry of its own an id no other entry has", () => {
    const seen = new Set<string>();
    for (const platform of ["linux", "darwin"] as const) {
      const items = itemsOf(
        template(mockCommands(), { focus: "graph", recentRepos: ["/r"] }, platform)
      );
      // GING's own: a label of its, with or without a role (macOS's Help).
      const ours = items.filter((item) => item.label !== undefined);
      const ids = ours.map((item) => item.id);

      expect(ids.every((id) => id !== undefined)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id) => seen.add(id!));
    }
    expect([...seen]).toEqual(expect.arrayContaining(Object.values(MENU_IDS)));
  });

  it("takes its focus from the focused Tab: its graph, its notice, or no Tab at all", () => {
    expect(menuFocus({ graph: true })).toBe("graph");
    expect(menuFocus({ graph: false })).toBe("notice");
    expect(menuFocus(null)).toBe("welcome");
  });
});
