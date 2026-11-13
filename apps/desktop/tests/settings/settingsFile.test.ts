import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { SettingSchema, SettingsSchema } from "@ging/desktop/settings/deriveSchema";
import { openSettings } from "@ging/desktop/settings/settingsFile";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

const text = { en: "", "zh-cn": "", "zh-tw": "" };
const setting = (key: string, node: Partial<SettingSchema>): SettingSchema => ({
  key,
  title: key,
  description: text,
  descriptionFormat: "plain",
  type: "string",
  ...node
});

const SCHEMA: SettingsSchema = {
  settings: [
    setting("ging-git-view.show.tags", { type: "boolean", default: true }),
    setting("ging-git-view.graph.edgeStyle", {
      type: "string",
      enum: ["rounded", "angular"],
      default: "rounded"
    }),
    setting("ging-git-view.autoFetch.intervalMinutes", {
      type: "number",
      default: 10,
      minimum: 1,
      maximum: 60
    }),
    setting("ging-git-view.graph.palette", {
      type: "array",
      items: { type: "string", pattern: "^#[0-9a-f]{6}$" },
      default: ["#000000"]
    }),
    setting("ging-git-view.columnVisibility", {
      type: "object",
      default: { date: true }
    })
  ]
};

function subject() {
  const dir = makeTempDir("ging-desktop-settings-");
  onTestFinished(() => rmrf(dir));
  const file = path.join(dir, "settings.json");
  const errors: string[] = [];
  const settings = openSettings(file, SCHEMA, { onError: (message) => errors.push(message) });
  return {
    settings,
    errors,
    write: (values: unknown) => fs.writeFileSync(file, JSON.stringify(values)),
    writeText: (content: string) => fs.writeFileSync(file, content)
  };
}

describe("the desktop settings file", () => {
  it("answers each setting's default while there is no file", () => {
    const s = subject();
    expect(s.settings.get("ging-git-view.show.tags")).toBe(true);
    expect(s.settings.get("ging-git-view.graph.palette")).toEqual(["#000000"]);
    expect(s.errors).toEqual([]);
  });

  it("answers what the user set, keyed as in VS Code's settings.json", () => {
    const s = subject();
    s.write({ "ging-git-view.show.tags": false, "ging-git-view.graph.edgeStyle": "angular" });
    expect(s.settings.get("ging-git-view.show.tags")).toBe(false);
    expect(s.settings.get("ging-git-view.graph.edgeStyle")).toBe("angular");
  });

  it("reads the file anew each time, so a change reaches the next read", () => {
    const s = subject();
    s.write({ "ging-git-view.show.tags": false });
    expect(s.settings.get("ging-git-view.show.tags")).toBe(false);
    s.write({});
    expect(s.settings.get("ging-git-view.show.tags")).toBe(true);
  });

  it.each([
    ["the wrong type", "ging-git-view.show.tags", "yes", true],
    ["a value off its enum", "ging-git-view.graph.edgeStyle", "wavy", "rounded"],
    ["a number that is not finite", "ging-git-view.autoFetch.intervalMinutes", null, 10],
    ["an array where an object belongs", "ging-git-view.columnVisibility", [], { date: true }],
    ["an object where an array belongs", "ging-git-view.graph.palette", {}, ["#000000"]]
  ])("answers the default for %s", (_, key, value, expected) => {
    const s = subject();
    s.write({ [key]: value });
    expect(s.settings.get(key)).toEqual(expected);
  });

  it("brings a number out of its range to the nearest end, as a user who overshot meant", () => {
    const s = subject();
    s.write({ "ging-git-view.autoFetch.intervalMinutes": 120 });
    expect(s.settings.get("ging-git-view.autoFetch.intervalMinutes")).toBe(60);
    s.write({ "ging-git-view.autoFetch.intervalMinutes": 0.5 });
    expect(s.settings.get("ging-git-view.autoFetch.intervalMinutes")).toBe(1);
  });

  it("drops the entries of a list that do not fit its items, and keeps the rest", () => {
    const s = subject();
    s.write({ "ging-git-view.graph.palette": ["#123456", "red", 7, "#abcdef"] });
    expect(s.settings.get("ging-git-view.graph.palette")).toEqual(["#123456", "#abcdef"]);
  });

  it("answers the defaults for a file it cannot parse, and says so once", () => {
    const s = subject();
    s.writeText('{ "ging-git-view.show.tags": false, }');
    expect(s.settings.get("ging-git-view.show.tags")).toBe(true);
    expect(s.settings.get("ging-git-view.show.tags")).toBe(true);
    expect(s.errors).toEqual([expect.stringContaining("settings.json")]);
  });

  it("refuses a key that is not a setting", () => {
    expect(() => subject().settings.get("ging-git-view.keepWebviewAlive")).toThrow(
      /keepWebviewAlive/
    );
  });
});
