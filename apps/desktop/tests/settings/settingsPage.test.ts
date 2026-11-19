import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createDesktopConfig } from "@ging/desktop/ports/config";
import { createL10n } from "@ging/desktop/ports/l10n";
import { DESKTOP_SETTINGS_SCHEMA, openDesktopSettings } from "@ging/desktop/settings/schema";
import {
  buildSettingsPageState,
  createSettingsPageHandler,
  schemaLocale
} from "@ging/desktop/settings/settingsPage";
import english from "@ging/shared/l10n/bundle.l10n.json";
import type { SettingsResponse, ThemeChoice } from "@ging/webview/desktop/settings/protocol";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

// The desktop host's half of the settings page (#397): what the page boots
// with, and what the host does with what the page posts — over a real
// settings file in a fresh user data folder.

function subject() {
  const dir = makeTempDir("ging-desktop-settings-page-");
  onTestFinished(() => rmrf(dir));
  const settings = openDesktopSettings(dir);
  const config = createDesktopConfig(settings);
  const logged: string[] = [];
  const changed: string[] = [];
  const themes: ThemeChoice[] = [];
  const replies: SettingsResponse[] = [];
  // A graph instance hears of a write as every listener does (#446).
  const following = settings.onDidUpdate((key) => changed.push(key));
  onTestFinished(() => following.dispose());
  const handle = createSettingsPageHandler({
    config,
    settings,
    l10n: createL10n(english),
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`)
    },
    setTheme: (choice) => themes.push(choice)
  });
  const post = (message: unknown) => handle(message, (answer) => replies.push(answer));
  return { dir, settings, config, logged, changed, themes, replies, post };
}

describe("the settings page's state", () => {
  it("has every desktop setting, in the app's language, with its value now", () => {
    const { settings } = subject();
    const state = buildSettingsPageState({
      schema: DESKTOP_SETTINGS_SCHEMA,
      settings,
      locale: "zh-tw",
      l10n: createL10n(english),
      theme: "dark"
    });

    expect(state.settings.map((s) => s.key)).toEqual(
      DESKTOP_SETTINGS_SCHEMA.settings.map((s) => s.key)
    );
    const interval = state.settings.find(
      (s) => s.key === "ging-git-view.autoFetch.intervalMinutes"
    );
    expect(interval).toMatchObject({
      type: "number",
      minimum: 1,
      maximum: 60,
      default: 10,
      value: 10,
      markdown: false,
      description: expect.stringContaining("auto-fetch 執行的間隔")
    });
    expect(state.theme).toBe("dark");
    expect(state.strings.title).toBe("Settings");
  });

  it.each([
    ["en-US", "en"],
    ["zh-TW", "zh-tw"],
    ["zh-HK", "zh-tw"],
    ["zh-CN", "zh-cn"],
    ["fr", "en"]
  ])("reads the schema in %s as %s", (appLocale, locale) => {
    expect(schemaLocale(appLocale)).toBe(locale);
  });
});

describe("what the host does with the settings page's messages", () => {
  it("writes a setting, tells each graph instance, and answers with the new value", async () => {
    const s = subject();

    await s.post({
      command: "updateSetting",
      key: "ging-git-view.autoFetch.intervalMinutes",
      value: 1
    });

    expect(s.config.autoFetchIntervalMinutes()).toBe(1);
    expect(s.changed).toEqual(["ging-git-view.autoFetch.intervalMinutes"]);
    expect(s.replies).toEqual([
      {
        command: "settingUpdated",
        key: "ging-git-view.autoFetch.intervalMinutes",
        value: 1,
        error: null
      }
    ]);
  });

  it("answers a refused value with the value kept and why, telling no instance", async () => {
    const s = subject();

    await s.post({ command: "updateSetting", key: "ging-git-view.graph.edgeStyle", value: "wavy" });

    expect(s.changed).toEqual([]);
    expect(s.replies).toEqual([
      {
        command: "settingUpdated",
        key: "ging-git-view.graph.edgeStyle",
        value: "rounded",
        error: "This setting does not allow that value."
      }
    ]);
    expect(s.logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("answers a key the app has no setting for, with no value", async () => {
    const s = subject();
    await s.post({ command: "updateSetting", key: "ging-git-view.keepWebviewAlive", value: true });
    expect(s.replies).toEqual([
      {
        command: "settingUpdated",
        key: "ging-git-view.keepWebviewAlive",
        value: undefined,
        error: "GING has no such setting."
      }
    ]);
  });

  it("reports a write that failed, to the page and in the log", async () => {
    const s = subject();
    // A folder where the temporary file would be written: the write cannot land.
    fs.mkdirSync(path.join(s.dir, "settings.json.tmp"));

    await s.post({ command: "updateSetting", key: "ging-git-view.show.tags", value: false });

    expect(s.changed).toEqual([]);
    // The page gets the translated reason; the system's own words go to the log.
    expect(s.replies).toEqual([
      {
        command: "settingUpdated",
        key: "ging-git-view.show.tags",
        value: true,
        error: "The settings file could not be read or written."
      }
    ]);
    expect(s.logged).toEqual([
      expect.stringMatching(/^ERROR: settings: .*show\.tags not saved: \S/)
    ]);
  });

  it("tells a settings file that is not JSON from one that cannot be written", async () => {
    const s = subject();
    fs.writeFileSync(path.join(s.dir, "settings.json"), "{ broken");

    await s.post({ command: "updateSetting", key: "ging-git-view.show.tags", value: false });

    expect(s.replies).toEqual([
      expect.objectContaining({
        error:
          "The settings file does not hold a JSON object, so it was left as it is. Fix it, then try again."
      })
    ]);
    expect(s.logged).toEqual([expect.stringMatching(/^ERROR: settings: .*Cannot parse/)]);
  });

  it("applies a theme the user chose, and nothing that is not one", async () => {
    const s = subject();
    await s.post({ command: "setTheme", theme: "light" });
    await s.post({ command: "setTheme", theme: "sepia" });
    expect(s.themes).toEqual(["light"]);
    expect(s.replies).toEqual([]);
  });
});
