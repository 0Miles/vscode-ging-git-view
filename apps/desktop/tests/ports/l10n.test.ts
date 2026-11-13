import { describe, expect, it } from "vitest";

import { bundleLocale, createDesktopL10n, createL10n } from "@ging/desktop/ports/l10n";

describe("the desktop L10n", () => {
  it("speaks the bundle of the app's locale", () => {
    expect(createDesktopL10n("zh-TW").t("ui.refresh")).toBe("重新整理");
    expect(createDesktopL10n("en-US").t("ui.refresh")).toBe("Refresh");
  });

  it("fills in the positional arguments", () => {
    expect(createDesktopL10n("en-US").t("ui.loadedCommitWindow", 300)).toBe(
      "Loaded up to 300 commits"
    );
  });

  it("falls back to English for a string the locale's bundle lacks, then to the key", () => {
    const l10n = createL10n({ hello: "Hello {0}", only: "English only" }, { hello: "你好 {0}" });
    expect(l10n.t("hello", "GING")).toBe("你好 GING");
    expect(l10n.t("only")).toBe("English only");
    expect(l10n.t("missing.key")).toBe("missing.key");
  });

  it("leaves a placeholder no argument was given for as it is", () => {
    expect(createL10n({ two: "{0} and {1}" }).t("two", "one")).toBe("one and {1}");
  });
});

describe("which bundle a locale reads", () => {
  it.each([
    ["zh-TW", "zh-tw"],
    ["zh-HK", "zh-tw"],
    ["zh-Hant", "zh-tw"],
    ["zh-CN", "zh-cn"],
    ["zh", "zh-cn"],
    ["zh-SG", "zh-cn"],
    ["en-US", null],
    ["fr", null],
    ["", null]
  ])("%s reads %s", (locale, bundle) => {
    expect(bundleLocale(locale)).toBe(bundle);
  });
});
