import path from "node:path";

import { describe, expect, it } from "vitest";

import type { L10nArg } from "@ging/core/host/ports";
import {
  createDesktopOpener,
  type FileFacts,
  opensDirectly,
  type OsShell
} from "@ging/desktop/ports/opener";

// The desktop Opener (#391), over a fake of what the system opens things
// with and of the file system: nothing here starts a program, a browser or a
// terminal, and the links and modes are the fake's.

const NOT_YET = "desktop.notSupportedYet";
const REPO = path.resolve("/work/repo");
const at = (...parts: string[]) => path.join(REPO, ...parts);

/** A file system of `links` (path → where it leads) and `modes` (real path →
 *  permission bits); any other path is its own real path, mode 0o644. A path
 *  under `missing` does not exist. */
function fakeFiles(
  links: Record<string, string> = {},
  modes: Record<string, number> = {},
  missing: string[] = []
): FileFacts {
  return {
    realpath: async (file) => {
      const normal = path.normalize(file);
      if (missing.includes(normal)) throw new Error(`ENOENT: ${normal}`);
      return links[normal] ?? path.resolve(normal);
    },
    mode: async (file) => modes[file] ?? 0o644
  };
}

function setUp({
  platform = "linux" as NodeJS.Platform,
  env = {} as NodeJS.ProcessEnv,
  files = fakeFiles(),
  openPath = async (_file: string) => "",
  openTerminal = async (_cwd: string, _title: string) => {}
} = {}) {
  const calls: unknown[][] = [];
  const logged: string[] = [];
  const os: OsShell = {
    openPath: (file) => {
      calls.push(["openPath", file]);
      return openPath(file);
    },
    showItemInFolder: (file) => calls.push(["showItemInFolder", file]),
    openExternal: async (url) => {
      calls.push(["openExternal", url]);
    },
    openTerminal: (cwd, title) => {
      calls.push(["openTerminal", cwd, title]);
      return openTerminal(cwd, title);
    }
  };
  const opener = createDesktopOpener({
    os,
    prompts: {
      showInformation: async (message: string) => {
        calls.push(["showInformation", message]);
        return undefined;
      },
      showError: async (message) => {
        calls.push(["showError", message]);
        return undefined;
      }
    },
    l10n: { t: (key: string, ...args: L10nArg[]) => [key, ...args].join(" ") },
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`)
    },
    repoRoot: () => REPO,
    platform,
    env,
    files
  });
  return { opener, calls, logged };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the desktop Opener's openFile", () => {
  it("opens a file of a type it knows only to be shown with the system's program", async () => {
    const { opener, calls, logged } = setUp();

    await opener.openFile(`${REPO}/src/a.txt`);

    expect(calls).toEqual([["openPath", at("src", "a.txt")]]);
    expect(logged).toEqual([]);
  });

  it("rejects, saying why in the log, when the system could not open the file", async () => {
    const { opener, logged } = setUp({ openPath: async () => "Failed to open path" });

    await expect(opener.openFile(at("a.txt"))).rejects.toThrow("Failed to open path");
    expect(logged).toEqual([expect.stringMatching(/^ERROR: opener: not opening .*a\.txt/)]);
  });

  it.each(["setup.bat", "run.js", "tool.py", "page.html", "Makefile", "x.weird"])(
    "shows %s in its folder instead of opening it",
    async (name) => {
      const { opener, calls } = setUp({ platform: "win32" });

      await opener.openFile(at(name));

      expect(calls).toEqual([["showItemInFolder", at(name)]]);
    }
  );

  it("judges a link by the file it leads to", async () => {
    const files = fakeFiles({ [at("notes.txt")]: at("bin", "tool.exe") });
    const { opener, calls } = setUp({ platform: "win32", files });

    await opener.openFile(at("notes.txt"));

    expect(calls).toEqual([["showItemInFolder", at("bin", "tool.exe")]]);
  });

  it.each(["darwin", "linux"] as const)(
    "shows an executable file in its folder on %s, whatever its name",
    async (platform) => {
      const files = fakeFiles({}, { [at("notes.txt")]: 0o755, [at("run")]: 0o700 });
      const { opener, calls } = setUp({ platform, files });

      await opener.openFile(at("notes.txt"));
      await opener.openFile(at("run"));

      expect(calls).toEqual([
        ["showItemInFolder", at("notes.txt")],
        ["showItemInFolder", at("run")]
      ]);
    }
  );

  it.each(["a.bat.", "a.bat ", "a.bat. . "])(
    "reads no trailing dots or spaces as a Windows extension: %j",
    async (name) => {
      const { opener, calls } = setUp({ platform: "win32" });

      await opener.openFile(at(name));

      expect(calls).toEqual([["showItemInFolder", at(name)]]);
    }
  );

  it("refuses a Windows path naming a stream of a file", async () => {
    const { opener, calls, logged } = setUp({ platform: "win32" });

    await expect(opener.openFile("C:/work/repo/a.txt::$DATA")).rejects.toThrow(
      "not a plain file path"
    );
    expect(calls).toEqual([]);
    expect(logged).toEqual([expect.stringContaining("ERROR: opener: not opening")]);
  });

  const outside = path.resolve("/etc/passwd.txt");
  it.each([
    ["by `..`", `${REPO}/../other/a.txt`],
    ["absolute", outside],
    ["through a link", at("escape.txt")]
  ])("refuses a path out of the repository, %s", async (_how, file) => {
    const { opener, calls } = setUp({ files: fakeFiles({ [at("escape.txt")]: outside }) });

    await expect(opener.openFile(file)).rejects.toThrow("not in the repository");
    expect(calls).toEqual([]);
  });

  it("rejects a file that is not there", async () => {
    const { opener, calls } = setUp({ files: fakeFiles({}, {}, [at("gone.txt")]) });

    await expect(opener.openFile(at("gone.txt"))).rejects.toThrow("ENOENT");
    expect(calls).toEqual([]);
  });
});

describe("the desktop Opener", () => {
  it("opens web addresses in the browser, as parsed, and nothing else", async () => {
    const { opener, calls, logged } = setUp();

    opener.openExternalUrl("https://example.com/issues/1");
    opener.openExternalUrl("HTTPS://Example.com/a b");
    opener.openExternalUrl("file:///etc/passwd");
    opener.openExternalUrl("ms-settings:privacy");
    opener.openExternalUrl("javascript:alert(1)");

    expect(calls).toEqual([
      ["openExternal", "https://example.com/issues/1"],
      ["openExternal", "https://example.com/a%20b"]
    ]);
    expect(logged).toEqual([
      "opener: not opening file:///etc/passwd: not a web address",
      "opener: not opening ms-settings:privacy: not a web address",
      "opener: not opening javascript:alert(1): not a web address"
    ]);
  });

  it("starts the system's terminal in the folder, titled as asked", async () => {
    const { opener, calls } = setUp();

    opener.openTerminal(REPO, "GING: repo");
    await settled();

    expect(calls).toEqual([["openTerminal", REPO, "GING: repo"]]);
  });

  it("says so in an error when no terminal could be started", async () => {
    const { opener, calls, logged } = setUp({
      openTerminal: async () => {
        throw new Error("spawn xterm ENOENT");
      }
    });

    opener.openTerminal("/work/repo", "GING: repo");
    await settled();

    expect(calls.at(-1)).toEqual([
      "showError",
      "desktop.cannotOpenTerminal Error: spawn xterm ENOENT"
    ]);
    expect(logged).toEqual([expect.stringContaining("ERROR: opener: could not open a terminal")]);
  });

  // The stubs: each says the desktop app cannot do it yet, and answers as
  // done, so the graph adds no "Unable to open" box of its own.
  describe("what the desktop app cannot show yet", () => {
    const side = { repo: REPO, filePath: "a.txt", commit: "abc" };
    type TestOpener = ReturnType<typeof setUp>["opener"];

    it.each([
      ["openFileAtRevision", (o: TestOpener) => o.openFileAtRevision(side)],
      ["diffWithWorking", (o: TestOpener) => o.diffWithWorking(side, at("a.txt"), "t")]
    ])("%s resolves after the notice", async (_name, open) => {
      const { opener, calls, logged } = setUp();

      await expect(open(opener)).resolves.toBeUndefined();

      expect(calls).toEqual([["showInformation", NOT_YET]]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("openCommitDiff resolves to true after the notice", async () => {
      const { opener, calls } = setUp();

      await expect(
        opener.openCommitDiff({
          repo: REPO,
          commitHash: "abc",
          oldFilePath: "a.txt",
          newFilePath: "a.txt",
          type: "M"
        })
      ).resolves.toBe(true);
      expect(calls).toEqual([["showInformation", NOT_YET]]);
    });

    it("openMergeEditor gives the notice", () => {
      const { opener, calls, logged } = setUp();

      opener.openMergeEditor(REPO, "a.txt");

      expect(calls).toEqual([["showInformation", NOT_YET]]);
      expect(logged).toEqual(["desktop: merging a.txt (#410) is not supported yet"]);
    });
  });
});

describe("opensDirectly", () => {
  it("opens only the types it lists, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const file of ["a.txt", "b.md", "c.png", "d.json", "e.ts", "f.pdf"]) {
        expect(opensDirectly(file, platform, {}, 0o644), `${platform} ${file}`).toBe(true);
      }
      for (const file of ["a.exe", "b.sh", "c.js", "d.py", "e.html", "f.svg", "README", ".env"]) {
        expect(opensDirectly(file, platform, {}, 0o644), `${platform} ${file}`).toBe(false);
      }
    }
  });

  it("opens nothing Windows' PATHEXT makes a program, a listed type included", () => {
    expect(opensDirectly("a.txt", "win32", { PATHEXT: ".EXE;.TXT" }, 0)).toBe(false);
    expect(opensDirectly("a.md", "win32", { PATHEXT: ".EXE;.TXT" }, 0)).toBe(true);
  });

  it("opens no executable file outside Windows", () => {
    expect(opensDirectly("a.txt", "darwin", {}, 0o744)).toBe(false);
    expect(opensDirectly("a.txt", "linux", {}, 0o701)).toBe(false);
    // Windows has no such bits to read.
    expect(opensDirectly("a.txt", "win32", {}, 0o777)).toBe(true);
  });

  it("strips a Windows name's trailing dots and spaces before reading its type", () => {
    expect(opensDirectly("a.bat.", "win32", {}, 0)).toBe(false);
    expect(opensDirectly("a.txt. ", "win32", {}, 0)).toBe(true);
  });
});
