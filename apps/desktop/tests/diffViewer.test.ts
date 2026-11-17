import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createShowDiff } from "@ging/desktop/diffViewer";
import type { ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";

import { git, makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

// The main process's half of the diff viewer (#404): both sides read from a
// real repository, decoded per the setting, and handed to the Tab's page.

function setUp(encoding = "utf8") {
  const repo = makeRepo();
  onTestFinished(() => rmrf(repo));
  const posted: ShowDiffMessage[] = [];
  let pageThere = true;
  let setting = encoding;
  const showDiff = createShowDiff({
    gitPath: () => "git",
    fileEncoding: () => setting,
    l10n: { t: (key) => `<${key}>` },
    post: (message) => {
      if (pageThere) posted.push(message);
      return pageThere;
    }
  });
  return {
    repo,
    posted,
    showDiff,
    closePage: () => (pageThere = false),
    setEncoding: (value: string) => (setting = value)
  };
}

/** "naïve\n" in windows-1252: the ï is the one byte 0xEF. */
const WIN1252 = Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);

describe("showing a diff in a Tab's page", () => {
  it("hands the page both sides at their revisions, in the page's own words", async () => {
    const { repo, posted, showDiff } = setUp();
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-m", "one"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(["commit", "-am", "two"], repo);

    const shown = await showDiff({
      title: "a.txt (x^ ↔ x)",
      original: { revision: { repo, filePath: "a.txt", commit: "HEAD^" } },
      modified: { revision: { repo, filePath: "a.txt", commit: rev(repo, "HEAD") } },
      revealLine: 3
    });

    expect(shown).toBe(true);
    expect(posted).toEqual([
      {
        command: "showDiff",
        title: "a.txt (x^ ↔ x)",
        original: { path: "a.txt", content: "one\n" },
        modified: { path: "a.txt", content: "two\n" },
        revealLine: 3,
        strings: {
          sideBySide: "<desktop.diff.sideBySide>",
          inline: "<desktop.diff.inline>",
          close: "<desktop.diff.close>",
          cannotShow: "<desktop.diff.cannotShow>"
        }
      }
    ]);
  });

  it("reads the working tree's side from the file, named by its path in the repository", async () => {
    const { repo, posted, showDiff } = setUp();
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "b.txt"), "edited\n");

    await showDiff({
      title: "t",
      original: { revision: { repo, filePath: "src/b.txt", commit: "HEAD" } },
      modified: { workingFile: path.join(repo, "src", "b.txt"), repo }
    });

    expect(posted[0].original).toEqual({ path: "src/b.txt", content: "" });
    expect(posted[0].modified).toEqual({ path: "src/b.txt", content: "edited\n" });
    expect(posted[0].revealLine).toBeNull();
  });

  it("decodes both sides per the setting as it is for each diff", async () => {
    const { repo, posted, showDiff, setEncoding } = setUp("win1252");
    fs.writeFileSync(path.join(repo, "legacy.txt"), WIN1252);
    git(["add", "legacy.txt"], repo);
    git(["commit", "-m", "legacy"], repo);
    const request = {
      title: "t",
      original: { revision: { repo, filePath: "legacy.txt", commit: "HEAD" } },
      modified: { workingFile: path.join(repo, "legacy.txt"), repo }
    };

    await showDiff(request);
    setEncoding("utf8");
    await showDiff(request);

    expect(posted[0].original.content).toBe("naïve\n");
    expect(posted[0].modified.content).toBe("naïve\n");
    expect(posted[1].original.content).not.toBe("naïve\n");
  });

  it("answers false when the page is gone", async () => {
    const { repo, posted, showDiff, closePage } = setUp();
    closePage();

    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo, filePath: "a", commit: "HEAD" } },
        modified: { revision: { repo, filePath: "a", commit: "HEAD" } }
      })
    ).resolves.toBe(false);
    expect(posted).toEqual([]);
  });

  it("rejects when a side cannot be read, and hands the page nothing", async () => {
    const { repo, posted, showDiff } = setUp();

    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo, filePath: "a", commit: "HEAD" } },
        // A folder, not a file.
        modified: { workingFile: repo, repo }
      })
    ).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});
