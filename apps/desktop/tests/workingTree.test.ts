import { describe, expect, it } from "vitest";

import { createDesktopL10n } from "@ging/desktop/ports/l10n";
import { workingTreeStrings } from "@ging/desktop/workingTree";

// The working tree panel's words (#403), as the main process sends them.

describe("workingTreeStrings", () => {
  it("names the platform's commit shortcut", () => {
    const l10n = createDesktopL10n("en");

    expect(workingTreeStrings(l10n, "darwin").message).toBe("Commit message (⌘Enter to commit)");
    expect(workingTreeStrings(l10n, "win32").message).toBe("Commit message (Ctrl+Enter to commit)");
    expect(workingTreeStrings(l10n, "linux").message).toBe("Commit message (Ctrl+Enter to commit)");
  });

  it("titles the panel apart from its list of changes, and leaves the count to the panel", () => {
    for (const locale of ["en", "zh-tw", "zh-cn"]) {
      const strings = workingTreeStrings(createDesktopL10n(locale), "linux");
      expect(strings.title, locale).not.toBe(strings.unstaged);
      expect(strings.more, locale).toContain("{0}");
    }
  });
});
