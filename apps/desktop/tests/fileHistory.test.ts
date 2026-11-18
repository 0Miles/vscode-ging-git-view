import path from "node:path";

import { describe, expect, it } from "vitest";

import { fileHistoryStrings, pathInRepo } from "@ging/desktop/fileHistory";
import { createDesktopL10n } from "@ging/desktop/ports/l10n";

// The file history panel's words (#408) as the main process sends them, and
// where a file picked from the menu's File History… is in the repository.
// graphInstance.test.ts drives the rest with real git behind it.

describe("fileHistoryStrings", () => {
  it("words every part of the panel in every language, leaving the blanks to the panel", () => {
    for (const locale of ["en", "zh-tw", "zh-cn"]) {
      const strings = fileHistoryStrings(createDesktopL10n(locale));
      // A missing key comes back as the key itself.
      for (const word of Object.values(strings)) {
        expect(word, locale).not.toMatch(/^desktop\.fileHistory\./);
      }
      for (const blank of [
        strings.title,
        strings.upTo,
        strings.renamedFrom,
        strings.copiedFrom,
        strings.asPath
      ]) {
        expect(blank, locale).toContain("{0}");
      }
      expect(strings.submodule, locale).toMatch(/\{0\}.*\{1\}/);
    }
  });
});

describe("pathInRepo", () => {
  const repo = path.resolve("/work/repo");

  it("names a file within the repository by its /-separated path", () => {
    expect(pathInRepo(repo, path.join(repo, "src", "a b.ts"))).toBe("src/a b.ts");
    expect(pathInRepo(repo.split(path.sep).join("/"), path.join(repo, "x"))).toBe("x");
  });

  it("has none for the repository itself, or a file outside it", () => {
    expect(pathInRepo(repo, repo)).toBeNull();
    expect(pathInRepo(repo, path.resolve("/work/other/a.ts"))).toBeNull();
    expect(pathInRepo(repo, path.resolve("/work/repo-two/a.ts"))).toBeNull();
  });
});
