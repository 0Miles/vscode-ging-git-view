import { describe, expect, it } from "vitest";

import { normalizeKeybinding } from "@/backend/utils/keybinding";

describe("normalizeKeybinding", () => {
  it("maps a CTRL/CMD + <key> value to the lowercase key char", () => {
    expect(normalizeKeybinding("CTRL/CMD + F", "x")).toBe("f");
    expect(normalizeKeybinding("CTRL/CMD + R", "x")).toBe("r");
    expect(normalizeKeybinding("CTRL/CMD + Z", "x")).toBe("z");
  });

  it("returns null for UNASSIGNED (the shortcut is disabled)", () => {
    expect(normalizeKeybinding("UNASSIGNED", "f")).toBeNull();
  });

  it("falls back to the default key for empty or malformed values", () => {
    expect(normalizeKeybinding("", "h")).toBe("h");
    expect(normalizeKeybinding("CTRL + F", "h")).toBe("h"); // wrong prefix
    expect(normalizeKeybinding("CTRL/CMD + FF", "h")).toBe("h"); // not a single A-Z
    expect(normalizeKeybinding("ctrl/cmd + f", "h")).toBe("h"); // case-sensitive prefix
  });
});
