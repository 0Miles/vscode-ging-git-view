import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphInstance } from "@ging/desktop/graphInstance";
import { createSharedServices } from "@ging/desktop/sharedServices";
import type { ResponseMessage } from "@ging/shared/types";

import {
  fakePorts,
  fakeWebview,
  makeRepo,
  makeTempDir,
  rmrf,
  toRepoPath
} from "@ging/core/tests/helpers";

// The desktop main process builds one dispatch, one set of ports and one git
// client per webview instance, over services every instance shares (#388).
// Driven here the way the page drives it: requests in through the channel,
// answers out of it.

const EMAIL = "alice@example.com";

/** A user data folder holding one cached avatar, as an earlier session left it. */
function userDataWithAvatar(): string {
  const userData = makeTempDir("ging-desktop-instance-");
  const avatars = path.join(userData, "globalStorage", "avatars");
  fs.mkdirSync(avatars, { recursive: true });
  fs.writeFileSync(path.join(avatars, "abc.png"), "PNGDATA");
  const avatar = { image: "abc.png", timestamp: Date.now() - 60_000, identicon: false };
  fs.writeFileSync(
    path.join(userData, "state.json"),
    JSON.stringify({ "global:avatarCache": { [EMAIL]: avatar } })
  );
  return userData;
}

function setUp() {
  const userData = userDataWithAvatar();
  const repos = [makeRepo(), makeRepo()].map(toRepoPath);
  const logged: string[] = [];
  /** What the system was asked to open: nothing here starts anything. */
  const opened: unknown[][] = [];
  const shared = createSharedServices({
    userDataPath: userData,
    locale: "en",
    helperDir: userData,
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`),
      reveal: () => {}
    },
    clipboard: { writeText: async () => {} },
    os: {
      openPath: async (file) => {
        opened.push(["openPath", file]);
        return "";
      },
      showItemInFolder: (file) => opened.push(["showItemInFolder", file]),
      openExternal: async (url) => {
        opened.push(["openExternal", url]);
      },
      openTerminal: async (cwd, title) => {
        opened.push(["openTerminal", cwd, title]);
      }
    }
  });
  const instances: { dispose(): void }[] = [];
  onTestFinished(() => {
    instances.forEach((instance) => instance.dispose());
    shared.dispose();
    [userData, ...repos].forEach(rmrf);
  });

  /** An instance on `repo`, as the main process opens one; `asked` is what its
   *  own prompts were asked. */
  const open = (repo: string) => {
    const page = fakeWebview();
    shared.repoSource.addRepo(repo);
    const prompts = fakePorts();
    const instance = createGraphInstance(shared, {
      repo,
      channel: page.webview,
      prompts: prompts.ports.prompts
    });
    instances.push(instance);
    return { instance, asked: prompts.calls, ...page };
  };
  return { shared, repos, open, logged, opened };
}

const sentOf = (posted: ResponseMessage[], command: ResponseMessage["command"]) =>
  posted.filter((msg) => msg.command === command);

describe("a graph instance", () => {
  it("boots its page on its own repository, whichever was opened last", () => {
    const { repos, open } = setUp();
    const first = open(repos[0]);
    open(repos[1]);

    const viewState = first.instance.pageViewState();

    expect(viewState.lastActiveRepo).toBe(repos[0]);
    expect(Object.keys(viewState.repos)).toEqual(expect.arrayContaining(repos));
  });

  it("answers the graph's requests from its repository", async () => {
    const { repos, open, logged } = setUp();
    const page = open(repos[0]);

    await page.receive({ command: "selectRepo", repo: repos[0] });
    await page.receive({ command: "loadBranches", hard: true, token: 1 });

    expect(sentOf(page.posted, "loadBranches")).toEqual([
      expect.objectContaining({ branches: ["main"], head: "main", isRepo: true, token: 1 })
    ]);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("tells its page when the known repositories change, until it is disposed", () => {
    const { shared, repos, open } = setUp();
    const live = open(repos[0]);
    const gone = open(repos[1]);
    gone.instance.dispose();
    const before = gone.posted.length;

    const another = toRepoPath(makeRepo());
    onTestFinished(() => rmrf(another));
    shared.repoSource.addRepo(another);

    expect(sentOf(live.posted, "loadRepos").at(-1)).toMatchObject({
      lastActiveRepo: repos[0],
      repos: expect.objectContaining({ [another]: expect.anything() })
    });
    expect(gone.posted.length).toBe(before);
  });

  it("tells its page of a Repository Setting default the host wrote", async () => {
    const { shared, repos, open } = setUp();
    const page = open(repos[0]);

    await shared.config.update("ging-git-view.show.stashes", false);
    page.instance.settingChanged("ging-git-view.show.stashes");

    expect(sentOf(page.posted, "setRepoSettingDefaults")).toEqual([
      expect.objectContaining({
        defaults: expect.objectContaining({ showStashes: false }),
        changed: ["showStashes"]
      })
    ]);
  });

  it("opens files, links and terminals through the system", async () => {
    const { repos, open, opened } = setUp();
    const page = open(repos[0]);

    await page.receive({ command: "openFile", repo: repos[0], filePath: "README.md" });
    await page.receive({ command: "openExternalUrl", url: "https://example.com/1" });
    await page.receive({ command: "openTerminal", repo: repos[0] });

    expect(sentOf(page.posted, "openFile")).toEqual([{ command: "openFile", success: true }]);
    expect(opened).toEqual([
      ["openPath", path.normalize(`${repos[0]}/README.md`)],
      ["openExternal", "https://example.com/1"],
      ["openTerminal", path.normalize(repos[0]), `GING: ${path.basename(repos[0])}`]
    ]);
  });

  it("says in its own window what the desktop app cannot do yet, and answers as done", async () => {
    const { repos, open, logged } = setUp();
    const asking = open(repos[0]);
    const other = open(repos[1]);
    const repo = repos[0];
    const file = { repo, commitHash: "HEAD", filePath: "f" };

    await asking.receive({ command: "viewFileAtRevision", ...file });
    await asking.receive({ command: "viewDiffWithWorking", ...file });
    await asking.receive({
      command: "viewDiff",
      repo,
      commitHash: "HEAD",
      oldFilePath: "f",
      newFilePath: "f",
      type: "M"
    });
    await asking.receive({ command: "openMergeEditor", repo, filePath: "f" });
    await asking.receive({ command: "openScmView" });

    const notice = ["showInformation", "This is not available in the GING desktop app yet."];
    expect(asking.asked).toEqual([notice, notice, notice, notice, notice]);
    expect(other.asked).toEqual([]);
    // Answered as done: the graph adds no "Unable to open" box of its own.
    for (const command of ["viewFileAtRevision", "viewDiffWithWorking", "viewDiff"] as const) {
      expect(sentOf(asking.posted, command)).toEqual([{ command, success: true }]);
    }
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("answers the graph's Show All once it has run, which clears nothing yet", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);

    await page.receive({ command: "clearBranchFilter", repo: repos[0] });

    expect(sentOf(page.posted, "branchFilterCleared")).toEqual([
      { command: "branchFilterCleared" }
    ]);
    expect(page.asked).toEqual([]);
  });

  it("shares the avatar cache, but stops receiving avatars once disposed", async () => {
    const { repos, open } = setUp();
    const asking = open(repos[0]);
    const closed = open(repos[1]);
    closed.instance.dispose();

    await asking.receive({ command: "fetchAvatar", email: EMAIL, repo: repos[0], commits: ["c"] });

    await expect
      .poll(() => sentOf(asking.posted, "fetchAvatar"))
      .toEqual([
        { command: "fetchAvatar", email: EMAIL, image: "data:image/png;base64,UE5HREFUQQ==" }
      ]);
    expect(sentOf(closed.posted, "fetchAvatar")).toEqual([]);
  });
});
