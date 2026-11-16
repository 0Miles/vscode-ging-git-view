import { describe, expect, it } from "vitest";

import { isOpenSettingsShortcut, type KeyInput } from "@ging/desktop/shortcuts";

// `CmdOrCtrl+,` opens the settings (#397): tested on its input, as accelerators
// are (ADR-0032), not by sending keys to a window.

const key = (input: Partial<KeyInput>): KeyInput => ({
  type: "keyDown",
  key: ",",
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...input
});

describe("the open-settings shortcut", () => {
  it("is Ctrl+, on Windows and Linux", () => {
    expect(isOpenSettingsShortcut(key({ control: true }), "win32")).toBe(true);
    expect(isOpenSettingsShortcut(key({ control: true }), "linux")).toBe(true);
    expect(isOpenSettingsShortcut(key({ meta: true }), "win32")).toBe(false);
  });

  it("is Cmd+, on macOS", () => {
    expect(isOpenSettingsShortcut(key({ meta: true }), "darwin")).toBe(true);
    expect(isOpenSettingsShortcut(key({ control: true }), "darwin")).toBe(false);
  });

  it.each([
    ["no modifier", key({})],
    ["another modifier too", key({ control: true, shift: true })],
    ["Alt too", key({ control: true, alt: true })],
    ["another key", key({ control: true, key: "." })],
    ["the key's release", key({ control: true, type: "keyUp" })]
  ])("is not %s", (_, input) => {
    expect(isOpenSettingsShortcut(input, "win32")).toBe(false);
  });
});
