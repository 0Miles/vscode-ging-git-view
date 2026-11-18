import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { fileHistoryStrings, pathInRepo } from "@ging/desktop/fileHistory";
import { createDesktopL10n } from "@ging/desktop/ports/l10n";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

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
  /** A folder holding a repository's folder `repo` with `src/a b.ts` and
   *  `..foo` in it, a junction `link` to `repo`, a folder `outside` beside it
   *  with `secret.ts`, and inside `repo` a junction `out` to `outside`. A
   *  junction, not a symlink: Windows makes one without privileges, and
   *  elsewhere it is a symlink to a folder. */
  function layout() {
    const root = makeTempDir("ging-path-in-repo-");
    const repo = path.join(root, "repo");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(repo, "src", "a b.ts"), "");
    fs.writeFileSync(path.join(repo, "..foo"), "");
    fs.writeFileSync(path.join(outside, "secret.ts"), "");
    const link = path.join(root, "link");
    fs.symlinkSync(repo, link, "junction");
    fs.symlinkSync(outside, path.join(repo, "out"), "junction");
    onTestFinished(() => {
      // The links first, so nothing removing the folder follows them.
      fs.unlinkSync(link);
      fs.unlinkSync(path.join(repo, "out"));
      rmrf(root);
    });
    return { repo, outside, link };
  }

  it("names a file within the repository by its /-separated path", async () => {
    const { repo } = layout();

    expect(await pathInRepo(repo, path.join(repo, "src", "a b.ts"))).toBe("src/a b.ts");
    expect(await pathInRepo(repo.split(path.sep).join("/"), path.join(repo, "src"))).toBe("src");
  });

  it("takes a file at the top whose name starts with two dots as inside", async () => {
    const { repo } = layout();

    expect(await pathInRepo(repo, path.join(repo, "..foo"))).toBe("..foo");
  });

  it("finds the file through a junction to the repository, either way round", async () => {
    const { repo, link } = layout();

    expect(await pathInRepo(link, path.join(repo, "src", "a b.ts"))).toBe("src/a b.ts");
    expect(await pathInRepo(repo, path.join(link, "src", "a b.ts"))).toBe("src/a b.ts");
  });

  it("has none for the repository itself, a file outside it, a link out of it, or no file", async () => {
    const { repo, outside } = layout();

    expect(await pathInRepo(repo, repo)).toBeNull();
    expect(await pathInRepo(repo, path.join(outside, "secret.ts"))).toBeNull();
    expect(await pathInRepo(repo, path.join(repo, "out", "secret.ts"))).toBeNull();
    expect(await pathInRepo(repo, path.join(repo, "missing.ts"))).toBeNull();
  });
});
