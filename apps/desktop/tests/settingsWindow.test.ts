import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";

import { CHANNELS } from "@ging/desktop/channels";
import { createSettingsWindow } from "@ging/desktop/settingsWindow";

// The settings window (#397) as Show Setting reaches it (#398): a window of
// its own at the setting's row, or — when one is open already — that window
// brought forward and told to show the row, never reloaded, so what is typed
// and not yet sent in it stays. Electron's window is a fake that records what
// it was asked (ADR-0032: no test drives a real one but the E2E).

const URL = "ging://app/settings";
const KEY = "ging-git-view.pullRequests.providers";

/** A window that records what it was asked to do. */
function fakeWindow(minimized = false) {
  const did: unknown[][] = [];
  const window = {
    isMinimized: () => minimized,
    restore: () => did.push(["restore"]),
    focus: () => did.push(["focus"]),
    loadURL: async (url: string) => {
      did.push(["loadURL", url]);
    },
    on: () => window,
    webContents: {
      setWindowOpenHandler: () => {},
      on: () => {},
      isDestroyed: () => false,
      send: (channel: string, message: unknown) => did.push(["send", channel, message])
    }
  };
  return { window: window as unknown as BrowserWindow, did };
}

function setUp(minimized?: boolean) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const settings = createSettingsWindow({
    url: URL,
    createWindow: () => {
      const made = fakeWindow(minimized);
      windows.push(made);
      return made.window;
    },
    handle: async () => {},
    opener: { openExternalUrl: () => {} },
    logger: { logError: () => {} },
    valueOf: (key) => (key === KEY ? [{ host: "git.example.com", type: "gitea" }] : undefined)
  });
  return { settings, windows };
}

describe("Show Setting in the settings window", () => {
  it("opens a window at the setting's row when none is open", () => {
    const { settings, windows } = setUp();

    settings.reveal(KEY);

    expect(windows).toHaveLength(1);
    expect(windows[0].did).toEqual([["loadURL", `${URL}?setting=${encodeURIComponent(KEY)}`]]);
  });

  it("brings an open window forward and shows the row there with its value now, without reloading it", () => {
    const { settings, windows } = setUp(true);
    settings.open();
    windows[0].did.length = 0;

    settings.reveal(KEY);

    expect(windows).toHaveLength(1);
    expect(windows[0].did).toEqual([
      ["restore"],
      ["focus"],
      [
        "send",
        CHANNELS.hostMessage,
        {
          command: "settingUpdated",
          key: KEY,
          value: [{ host: "git.example.com", type: "gitea" }],
          error: null
        }
      ],
      ["send", CHANNELS.hostMessage, { command: "revealSetting", key: KEY }]
    ]);
  });
});
