import { describe, expect, it } from "vitest";

import { replaceEmojiShortcodes } from "@/webview/utils/emoji";

describe("replaceEmojiShortcodes", () => {
  it("replaces a known built-in shortcode", () => {
    expect(replaceEmojiShortcodes(":tada: release")).toBe("🎉 release");
  });

  it("replaces multiple shortcodes in one string", () => {
    expect(replaceEmojiShortcodes(":sparkles: feat :bug: fix")).toBe("✨ feat 🐛 fix");
  });

  it("resolves the full gitmoji set, including the newer additions", () => {
    expect(replaceEmojiShortcodes(":coffin:")).toBe("⚰️");
    expect(replaceEmojiShortcodes(":money_with_wings:")).toBe("💸");
    expect(replaceEmojiShortcodes(":safety_vest:")).toBe("🦺");
    expect(replaceEmojiShortcodes(":technologist:")).toBe("🧑‍💻");
  });

  it("leaves unknown shortcodes untouched", () => {
    expect(replaceEmojiShortcodes(":not_a_real_code: text")).toBe(":not_a_real_code: text");
  });

  it("handles shortcodes containing + and -", () => {
    expect(replaceEmojiShortcodes(":+1: :-1:")).toBe("👍 👎");
  });

  it("does not touch text without shortcodes", () => {
    expect(replaceEmojiShortcodes("a normal commit message")).toBe("a normal commit message");
  });

  it("does not match a lone colon or url-like text", () => {
    expect(replaceEmojiShortcodes("see https://example.com:8080/path")).toBe(
      "see https://example.com:8080/path"
    );
  });

  it("applies custom mappings over the built-in map", () => {
    expect(replaceEmojiShortcodes(":tada:", { tada: "X" })).toBe("X");
  });

  it("adds new shortcodes via custom mappings", () => {
    expect(replaceEmojiShortcodes(":pizza_party:", { pizza_party: "🍕🎉" })).toBe("🍕🎉");
  });

  it("returns the empty string unchanged", () => {
    expect(replaceEmojiShortcodes("")).toBe("");
  });
});
