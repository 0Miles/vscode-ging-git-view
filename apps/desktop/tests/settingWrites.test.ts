import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, onTestFinished } from "vitest";

import { CHANNELS } from "@ging/desktop/channels";
import { createDesktopConfig } from "@ging/desktop/ports/config";
import { createL10n } from "@ging/desktop/ports/l10n";
import { DESKTOP_SETTINGS_SCHEMA, openDesktopSettings } from "@ging/desktop/settings/schema";
import { SettingRefused } from "@ging/desktop/settings/settingsFile";
import {
  buildSettingsPageState,
  createSettingsPageHandler
} from "@ging/desktop/settings/settingsPage";
import { createSettingsWindow } from "@ging/desktop/settingsWindow";
import { tellOfSettingWrites } from "@ging/desktop/settingWrites";
import english from "@ging/shared/l10n/bundle.l10n.json";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

// Who hears of a setting written (#446): whoever writes it — the settings
// page, or Manage Pull Request Providers (#398) through `HostConfig.update` —
// an open settings window shows the new value, and every graph instance is
// told once. Over a real settings file; Electron's window is a fake that
// records what it was sent (ADR-0032).

const URL = "ging://app/settings";
const PROVIDERS = "ging-git-view.pullRequests.providers";
const PROVIDER = [
  { host: "git.example.com", type: "custom", urlTemplate: "https://git.example.com/{branch}" }
];

function fakeWindow() {
  const sent: unknown[] = [];
  const loaded: string[] = [];
  const window = {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    loadURL: async (url: string) => {
      loaded.push(url);
    },
    on: () => window,
    webContents: {
      setWindowOpenHandler: () => {},
      on: () => {},
      isDestroyed: () => false,
      send: (channel: string, message: unknown) => {
        expect(channel).toBe(CHANNELS.hostMessage);
        sent.push(message);
      }
    }
  };
  return { window: window as unknown as BrowserWindow, sent, loaded };
}

function subject() {
  const dir = makeTempDir("ging-desktop-setting-writes-");
  onTestFinished(() => rmrf(dir));
  /** What the settings file reported. */
  const errors: string[] = [];
  const settings = openDesktopSettings(dir, { onError: (message) => errors.push(message) });
  const config = createDesktopConfig(settings);
  const l10n = createL10n(english);
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const handle = createSettingsPageHandler({
    config,
    settings,
    l10n,
    logger: { log: () => {}, logError: () => {} },
    setTheme: () => {}
  });
  /** The page's messages being handled, to wait for. */
  const handling: Promise<void>[] = [];
  const settingsWindow = createSettingsWindow({
    url: URL,
    createWindow: () => {
      const made = fakeWindow();
      windows.push(made);
      return made.window;
    },
    handle: (message, reply) => {
      const handled = handle(message, reply);
      handling.push(handled);
      return handled;
    },
    opener: { openExternalUrl: () => {} },
    logger: { logError: () => {} },
    valueOf: (key) => settings.get(key)
  });
  // Two graph instances, each counting what it is told.
  const told: [string[], string[]] = [[], []];
  const following = tellOfSettingWrites({
    settings,
    settingsWindow,
    instances: () => told.map((keys) => ({ settingChanged: (key: string) => keys.push(key) }))
  });
  onTestFinished(() => following.dispose());
  /** What the settings page posts, as the window hands it on; resolves once
   *  the page has been answered. */
  const post = async (message: unknown) => {
    const page = windows.at(-1)!.window.webContents as unknown as WebContents;
    expect(settingsWindow.deliver(page, message)).toBe(true);
    await Promise.all(handling);
  };
  return { settings, config, l10n, settingsWindow, windows, told, errors, post };
}

describe("a setting written elsewhere, while the settings window is open", () => {
  it("is pushed to the page with the value the app holds now, and no error", async () => {
    const s = subject();
    s.settingsWindow.open();

    await s.config.update(PROVIDERS, PROVIDER);

    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].sent).toEqual([
      { command: "settingUpdated", key: PROVIDERS, value: PROVIDER, error: null }
    ]);
  });

  it("pushes nothing when the write is refused", async () => {
    const s = subject();
    s.settingsWindow.open();

    await expect(s.config.update(PROVIDERS, "not a list")).rejects.toBeInstanceOf(SettingRefused);

    expect(s.windows[0].sent).toEqual([]);
    expect(s.told).toEqual([[], []]);
  });
});

describe("a setting written elsewhere, with no settings window open", () => {
  it("opens no window and throws nothing; the window opened later shows the new value", async () => {
    const s = subject();

    await expect(s.config.update(PROVIDERS, PROVIDER)).resolves.toBeUndefined();
    expect(s.windows).toEqual([]);

    s.settingsWindow.open();
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].loaded).toEqual([URL]);
    // What that page is served with.
    const state = buildSettingsPageState({
      schema: DESKTOP_SETTINGS_SCHEMA,
      settings: s.settings,
      locale: "en",
      l10n: s.l10n,
      theme: "system"
    });
    expect(state.settings.find((row) => row.key === PROVIDERS)?.value).toEqual(PROVIDER);
  });
});

describe("each graph instance, told of a setting written", () => {
  it("once per write made elsewhere, as a graph instance's own providers write is", async () => {
    const s = subject();

    await s.config.update(PROVIDERS, PROVIDER);
    await s.config.update("ging-git-view.show.tags", false);

    expect(s.told).toEqual([
      [PROVIDERS, "ging-git-view.show.tags"],
      [PROVIDERS, "ging-git-view.show.tags"]
    ]);
  });

  it("once per write the settings page makes, not twice", async () => {
    const s = subject();
    s.settingsWindow.open();

    await s.post({ command: "updateSetting", key: "ging-git-view.show.tags", value: false });

    expect(s.told).toEqual([["ging-git-view.show.tags"], ["ging-git-view.show.tags"]]);
  });

  it("not at all for a write the settings page made that failed", async () => {
    const s = subject();
    s.settingsWindow.open();

    await s.post({ command: "updateSetting", key: "ging-git-view.graph.edgeStyle", value: "wavy" });

    expect(s.told).toEqual([[], []]);
  });
});

describe("the settings page's own write", () => {
  it("is answered as before, with the new value and no error", async () => {
    const s = subject();
    s.settingsWindow.open();

    await s.post({ command: "updateSetting", key: "ging-git-view.show.tags", value: false });

    // Its reply, after the push every write makes — the same message.
    const answer = {
      command: "settingUpdated",
      key: "ging-git-view.show.tags",
      value: false,
      error: null
    };
    expect(s.windows[0].sent).toEqual([answer, answer]);
  });

  it("that failed is answered with why, to that page only, and nothing more is pushed", async () => {
    const s = subject();
    s.settingsWindow.open();

    await s.post({ command: "updateSetting", key: "ging-git-view.graph.edgeStyle", value: "wavy" });

    expect(s.windows[0].sent).toEqual([
      {
        command: "settingUpdated",
        key: "ging-git-view.graph.edgeStyle",
        value: "rounded",
        error: "This setting does not allow that value."
      }
    ]);
  });
});

describe("following setting writes", () => {
  it("stops once disposed", async () => {
    const s = subject();
    s.settingsWindow.open();
    const told: string[] = [];
    const extra = tellOfSettingWrites({
      settings: s.settings,
      settingsWindow: { updated: () => {} },
      instances: () => [{ settingChanged: (key: string) => told.push(key) }]
    });

    await s.config.update("ging-git-view.show.tags", false);
    extra.dispose();
    await s.config.update("ging-git-view.show.tags", true);

    expect(told).toEqual(["ging-git-view.show.tags"]);
  });

  it("keeps a write that landed when one who hears of it throws, and tells the rest", async () => {
    const s = subject();
    const failing = s.settings.onDidUpdate(() => {
      throw new Error("boom");
    });
    onTestFinished(() => failing.dispose());

    await expect(s.config.update("ging-git-view.show.tags", false)).resolves.toBeUndefined();

    expect(s.config.showTags()).toBe(false);
    expect(s.told).toEqual([["ging-git-view.show.tags"], ["ging-git-view.show.tags"]]);
    // And the throw is reported, naming the setting written.
    expect(s.errors).toEqual([expect.stringContaining("ging-git-view.show.tags")]);
  });
});
