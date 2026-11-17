import type { MessageBoxOptions, OpenDialogOptions } from "electron";
import { describe, expect, it } from "vitest";

import { createRepoOpening } from "@ging/desktop/repoOpening";
import type { RepoToOpen } from "@ging/desktop/repoToOpen";

// Open Folder, Initialize Repository and a recent repository (#394), with the
// system's dialogs, the check of a folder, core's init and the Tabs all faked:
// what is asked, in which order, and what ends up opened.

type Answers = {
  /** The folder the dialog answers; `null` cancels it. */
  folder?: string | null;
  /** The message box's button clicked. */
  button?: number;
  /** What each folder names; a folder in none by default. */
  repos?: Record<string, RepoToOpen>;
  /** What init answers for a folder; `undefined` for a failure it has said. */
  init?: (folder: string) => { repo: string; created: boolean } | undefined;
  /** Known spellings, by the spelling git gives today (`TabWindow.resolve`). */
  spellings?: Record<string, string>;
};

function make(answers: Answers = {}) {
  const asked: (["open", OpenDialogOptions] | ["box", MessageBoxOptions] | ["init", string])[] = [];
  const opened: string[] = [];
  const logged: string[] = [];
  const opening = createRepoOpening({
    dialogs: {
      showOpenDialog: async (options) => {
        asked.push(["open", options]);
        const folder = answers.folder ?? null;
        return folder === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [folder] };
      },
      showMessageBox: async (options) => {
        asked.push(["box", options]);
        return { response: answers.button ?? 0 };
      }
    },
    l10n: { t: (key, ...args) => [key, ...args].join("|") },
    logger: { log: (line) => logged.push(line) },
    check: async (folder) => answers.repos?.[folder] ?? { unusable: folder, why: "notRepository" },
    initRepo: async (folder) => {
      asked.push(["init", folder]);
      return answers.init ? answers.init(folder) : { repo: `${folder}!`, created: true };
    },
    openRepo: (repo) => opened.push(repo),
    resolve: (repo) => answers.spellings?.[repo] ?? repo
  });
  return { opening, asked, opened, logged };
}

const FOLDER_DIALOG = (button: string): ["open", OpenDialogOptions] => [
  "open",
  { properties: ["openDirectory", "createDirectory"], buttonLabel: button }
];

/** The error box saying why `path` opens nothing, in `key`'s words. */
const CANNOT_OPEN = (key: string, path: string): ["box", MessageBoxOptions] => [
  "box",
  { type: "error", message: "error.unableToLoadGitGraph", detail: `${key}|${path}` }
];

describe("Open Folder", () => {
  it("opens the repository the folder chosen is in", async () => {
    const h = make({
      folder: "C:\\work\\app\\src",
      repos: { "C:\\work\\app\\src": { repo: "C:/work/app" } }
    });
    await h.opening.openFolder();

    expect(h.asked).toEqual([FOLDER_DIALOG("desktop.folderDialog.open")]);
    expect(h.opened).toEqual(["C:/work/app"]);
    expect(h.logged).toEqual(["open folder: opening C:/work/app"]);
  });

  it("does nothing more when the dialog is cancelled", async () => {
    const h = make({ folder: null });
    await h.opening.openFolder();

    expect(h.asked).toEqual([FOLDER_DIALOG("desktop.folderDialog.open")]);
    expect(h.opened).toEqual([]);
  });

  it("offers to initialize a folder in no repository, and opens what it makes", async () => {
    const h = make({ folder: "/plain", button: 0 });
    await h.opening.openFolder();

    expect(h.asked).toEqual([
      FOLDER_DIALOG("desktop.folderDialog.open"),
      [
        "box",
        {
          type: "warning",
          message: "desktop.cannotOpenRepo|/plain",
          buttons: ["desktop.initThisFolder", "dialog.cancel"],
          defaultId: 0,
          cancelId: 1
        }
      ],
      ["init", "/plain"]
    ]);
    expect(h.opened).toEqual(["/plain!"]);
  });

  it("leaves a folder in no repository as it is when the offer is declined", async () => {
    const h = make({ folder: "/plain", button: 1 });
    await h.opening.openFolder();

    expect(h.asked.map(([what]) => what)).toEqual(["open", "box"]);
    expect(h.opened).toEqual([]);
  });

  it("offers no Initialize for a bare repository or a .git folder, and says why", async () => {
    const h = make({
      folder: "/srv/app.git",
      repos: { "/srv/app.git": { unusable: "/srv/app.git", why: "noWorkTree" } }
    });
    await h.opening.openFolder();

    expect(h.asked).toEqual([
      FOLDER_DIALOG("desktop.folderDialog.open"),
      CANNOT_OPEN("desktop.noWorkTree", "/srv/app.git")
    ]);
    expect(h.opened).toEqual([]);
  });
});

describe("Initialize Repository", () => {
  it("makes a repository in the folder chosen and opens it", async () => {
    const h = make({ folder: "/new" });
    await h.opening.initRepo();

    expect(h.asked).toEqual([FOLDER_DIALOG("desktop.folderDialog.initialize"), ["init", "/new"]]);
    expect(h.opened).toEqual(["/new!"]);
    expect(h.logged).toEqual(["init: made a repository in /new!"]);
  });

  it("opens a folder that already is a repository as it is", async () => {
    const h = make({ folder: "/repo", init: () => ({ repo: "/repo", created: false }) });
    await h.opening.initRepo();

    expect(h.opened).toEqual(["/repo"]);
    expect(h.logged).toEqual(["init: /repo already is a repository, opening it"]);
  });

  it("opens nothing when init could not make one (it has said why)", async () => {
    const h = make({ folder: "/locked", init: () => undefined });
    await h.opening.initRepo();

    expect(h.opened).toEqual([]);
  });

  it("asks nothing of git when the dialog is cancelled", async () => {
    const h = make({ folder: null });
    await h.opening.initRepo();

    expect(h.asked).toEqual([FOLDER_DIALOG("desktop.folderDialog.initialize")]);
  });
});

describe("a repository of the recent list", () => {
  it("opens when it still is one", async () => {
    const h = make({ repos: { "/a": { repo: "/a" } } });
    await h.opening.openRecent("/a");

    expect(h.opened).toEqual(["/a"]);
    expect(h.asked).toEqual([]);
  });

  it("opens when git spells it otherwise today, as the known set knows it (#413)", async () => {
    const h = make({
      repos: { "C:/Work/app": { repo: "c:/work/app" } },
      spellings: { "c:/work/app": "C:/Work/app" }
    });
    await h.opening.openRecent("C:/Work/app");

    expect(h.opened).toEqual(["C:/Work/app"]);
    expect(h.asked).toEqual([]);
  });

  it("says its folder is not there when it is not, rather than that it is no repository", async () => {
    const h = make({ repos: { "/gone": { unusable: "/gone", why: "missing" } } });
    await h.opening.openRecent("/gone");

    expect(h.opened).toEqual([]);
    expect(h.asked).toEqual([CANNOT_OPEN("desktop.folderNotFound", "/gone")]);
    expect(h.logged).toEqual(["recent: cannot open /gone (missing)"]);
  });

  it("says why when its folder is no repository any more, and opens nothing", async () => {
    const h = make();
    await h.opening.openRecent("/plain");

    expect(h.opened).toEqual([]);
    expect(h.asked).toEqual([CANNOT_OPEN("desktop.cannotOpenRepo", "/plain")]);
  });

  it("does not open the repository around its folder in its place", async () => {
    const h = make({ repos: { "/outer/inner": { repo: "/outer" } } });
    await h.opening.openRecent("/outer/inner");

    expect(h.opened).toEqual([]);
    expect(h.asked).toEqual([CANNOT_OPEN("desktop.cannotOpenRepo", "/outer/inner")]);
    expect(h.logged).toEqual(["recent: cannot open /outer/inner, it is inside /outer now"]);
  });
});
