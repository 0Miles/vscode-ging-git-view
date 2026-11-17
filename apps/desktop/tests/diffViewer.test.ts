import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { L10nArg } from "@ging/core/host/ports";
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
    l10n: { t: (key: string, ...args: L10nArg[]) => `<${[key, ...args].join(" ")}>` },
    repoRoot: () => repo,
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

/** A file committed into `repo`: its commit's hash. */
function commitFile(repo: string, name: string, content: string | Buffer): string {
  fs.writeFileSync(path.join(repo, name), content);
  git(["add", name], repo);
  git(["commit", "-m", `add ${name}`], repo);
  return rev(repo, "HEAD");
}

describe("showing a diff in a Tab's page", () => {
  it("hands the page both sides at their revisions, in the page's own words", async () => {
    const { repo, posted, showDiff } = setUp();
    commitFile(repo, "a.txt", "one\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(["commit", "-am", "two"], repo);
    const head = rev(repo, "HEAD");

    const shown = await showDiff({
      title: "a.txt (x^ ↔ x)",
      original: { revision: { repo, filePath: "a.txt", commit: `${head}^` } },
      modified: { revision: { repo, filePath: "a.txt", commit: head } },
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
        notShown: null,
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
      original: { revision: { repo, filePath: "src/b.txt", commit: rev(repo, "HEAD") } },
      modified: { workingFile: path.join(repo, "src", "b.txt"), repo }
    });

    expect(posted[0].original).toEqual({ path: "src/b.txt", content: "" });
    expect(posted[0].modified).toEqual({ path: "src/b.txt", content: "edited\n" });
    expect(posted[0].revealLine).toBeNull();
  });

  it("reads the index as the revision `:0`", async () => {
    const { repo, posted, showDiff } = setUp();
    fs.writeFileSync(path.join(repo, "c.txt"), "staged\n");
    git(["add", "c.txt"], repo);

    await showDiff({
      title: "t",
      original: { revision: { repo, filePath: "c.txt", commit: ":0" } },
      modified: { workingFile: path.join(repo, "c.txt"), repo }
    });

    expect(posted[0].original.content).toBe("staged\n");
  });

  it("decodes both sides per the setting as it is for each diff", async () => {
    const { repo, posted, showDiff, setEncoding } = setUp("win1252");
    const head = commitFile(repo, "legacy.txt", WIN1252);
    const request = {
      title: "t",
      original: { revision: { repo, filePath: "legacy.txt", commit: head } },
      modified: { workingFile: path.join(repo, "legacy.txt"), repo }
    };

    await showDiff(request);
    setEncoding("utf8");
    await showDiff(request);

    expect(posted[0].original.content).toBe("naïve\n");
    expect(posted[0].modified.content).toBe("naïve\n");
    expect(posted[1].original.content).not.toBe("naïve\n");
  });

  it("sends no binary file's bytes, but one line saying why there is nothing to compare", async () => {
    const { repo, posted, showDiff } = setUp();
    const head = commitFile(repo, "image.png", Buffer.from([0x89, 0x50, 0, 0x47]));

    await showDiff({
      title: "t",
      original: { revision: { repo, filePath: "image.png", commit: `${head}^` } },
      modified: { revision: { repo, filePath: "image.png", commit: head } }
    });

    expect(posted[0]).toMatchObject({
      original: { path: "image.png", content: "" },
      modified: { path: "image.png", content: "" },
      notShown: "<desktop.diff.binary>"
    });
  });

  it("sends neither side of a diff with a side too large to show, saying so", async () => {
    const { repo, posted, showDiff } = setUp();
    const head = commitFile(repo, "small.txt", "small\n");
    // Larger than FILE_TEXT_LIMIT (5 MiB), in the working tree only.
    fs.writeFileSync(path.join(repo, "small.txt"), "x".repeat(5 * 1024 * 1024 + 1));

    await showDiff({
      title: "t",
      original: { revision: { repo, filePath: "small.txt", commit: head } },
      modified: { workingFile: path.join(repo, "small.txt"), repo }
    });

    expect(posted[0]).toMatchObject({
      original: { content: "" },
      modified: { content: "" },
      notShown: "<desktop.diff.tooLarge 5>"
    });
  });

  it("reads nothing of a repository that is not the Tab's", async () => {
    const { repo, posted, showDiff } = setUp();
    const other = makeRepo();
    onTestFinished(() => rmrf(other));
    const head = rev(other, "HEAD");

    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo: other, filePath: "f", commit: head } },
        modified: { revision: { repo, filePath: "f", commit: rev(repo, "HEAD") } }
      })
    ).rejects.toThrow("not this Tab's repository");
    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo, filePath: "f", commit: rev(repo, "HEAD") } },
        modified: { workingFile: path.join(other, "f"), repo: other }
      })
    ).rejects.toThrow("not in this Tab's repository");
    expect(posted).toEqual([]);
  });

  it("runs no revision but a hash, a parent of one, or the index", async () => {
    const { repo, posted, showDiff } = setUp();
    const written = path.join(repo, "written.txt");
    const side = (commit: string) => ({ revision: { repo, filePath: "f", commit } });

    const head = rev(repo, "HEAD");
    await Promise.all(
      [`--output=${written}`, "HEAD", "main", "@{-1}", "abc:def"].map((commit) =>
        expect(
          showDiff({ title: "t", original: side(commit), modified: side(head) }),
          commit
        ).rejects.toThrow("is not a revision a diff reads")
      )
    );
    expect(fs.existsSync(written)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("answers false when the page is gone", async () => {
    const { repo, posted, showDiff, closePage } = setUp();
    closePage();
    const head = rev(repo, "HEAD");

    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo, filePath: "a", commit: head } },
        modified: { revision: { repo, filePath: "a", commit: head } }
      })
    ).resolves.toBe(false);
    expect(posted).toEqual([]);
  });

  it("rejects when a side cannot be read, and hands the page nothing", async () => {
    const { repo, posted, showDiff } = setUp();

    await expect(
      showDiff({
        title: "t",
        original: { revision: { repo, filePath: "a", commit: rev(repo, "HEAD") } },
        // A folder, not a file.
        modified: { workingFile: repo, repo }
      })
    ).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});
