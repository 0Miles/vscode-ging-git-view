import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphInstance } from "@ging/desktop/graphInstance";
import { createSharedServices } from "@ging/desktop/sharedServices";
import type { ResponseMessage } from "@ging/shared/types";
import type { ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";

import {
  fakePorts,
  fakeWebview,
  git,
  makeRepo,
  makeTempDir,
  rev,
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
  /** The settings each instance asked the app to show. */
  const revealed: string[] = [];
  onTestFinished(() => {
    instances.forEach((instance) => instance.dispose());
    shared.dispose();
    [userData, ...repos].forEach(rmrf);
  });

  /** An instance on `repo`, as the main process opens one; `asked` is what its
   *  own prompts were asked. */
  const open = (repo: string) => {
    const page = fakeWebview();
    const { ports, answers, calls } = fakePorts();
    shared.repoSource.addRepo(repo);
    const state = shared.tabStates.newTab(repo);
    /** The diffs it handed its page (#404). */
    const diffs: ShowDiffMessage[] = [];
    const instance = createGraphInstance(shared, {
      repo,
      channel: page.webview,
      prompts: ports.prompts,
      extensionState: state,
      revealSetting: (key) => revealed.push(key),
      postDiff: (message) => {
        diffs.push(message);
        return true;
      }
    });
    instances.push(instance);
    return { instance, answers, state, asked: calls, diffs, ...page };
  };
  return { shared, repos, open, logged, opened, revealed };
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
    expect(Object.keys(viewState.repos)).toEqual([repos[0]]);
  });

  it("boots on no other repository once its own has left the known set", () => {
    const { shared, repos, open } = setUp();
    const page = open(repos[0]);
    open(repos[1]);

    // Gone from the set, as `checkReposExist` drops a folder that is no
    // repository any more: the Tab's graph must not move to the other one,
    // which another Tab has open (#393).
    shared.repoSource.dropRepo(repos[0]);

    expect(sentOf(page.posted, "loadRepos").at(-1)).toMatchObject({ lastActiveRepo: null });
    expect(page.instance.pageViewState().lastActiveRepo).toBeNull();
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
    shared.repoSource.updateRepoState(repos[0], { customName: "Renamed" });

    // Its own repository alone, as it is now: another Tab's is none of its.
    const told = sentOf(live.posted, "loadRepos").at(-1);
    expect(told).toMatchObject({ lastActiveRepo: repos[0] });
    expect(told).toHaveProperty("repos", {
      [repos[0]]: expect.objectContaining({ customName: "Renamed" })
    });
    expect(gone.posted.length).toBe(before);
  });

  it("stays on its own repository when its page asks for another", async () => {
    const { repos, open, logged } = setUp();
    const page = open(repos[0]);
    open(repos[1]);
    expect(Object.keys(page.instance.pageViewState().repos)).toEqual([repos[0]]);

    await page.receive({ command: "selectRepo", repo: repos[0] });
    await page.receive({ command: "selectRepo", repo: repos[1] });

    // Never handed to the dispatch, which would have written it to the Tab's
    // state: a known repository passes `setLastActiveRepo`'s rule.
    expect(page.state.getLastActiveRepo()).toBe(repos[0]);
    expect(logged).toContain(`tabs: the Tab on ${repos[0]} stays on it, not ${repos[1]}`);
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
    fs.writeFileSync(path.join(repos[0], "README.md"), "# readme\n");

    await page.receive({ command: "openFile", repo: repos[0], filePath: "README.md" });
    await page.receive({ command: "openExternalUrl", url: "https://example.com/1" });
    await page.receive({ command: "openTerminal", repo: repos[0] });

    expect(sentOf(page.posted, "openFile")).toEqual([{ command: "openFile", success: true }]);
    // The terminal once its folder is found in the repository: not awaited by
    // the dispatch, whose port answers nothing.
    await expect
      .poll(() => opened)
      .toEqual([
        ["openPath", fs.realpathSync.native(path.join(repos[0], "README.md"))],
        ["openExternal", "https://example.com/1"],
        ["openTerminal", fs.realpathSync.native(repos[0]), `GING: ${path.basename(repos[0])}`]
      ]);
  });

  it("says in its own window what the desktop app cannot do yet, and answers as done", async () => {
    const { repos, open, logged } = setUp();
    const asking = open(repos[0]);
    const other = open(repos[1]);
    const repo = repos[0];
    const file = { repo, commitHash: "HEAD", filePath: "f" };

    await asking.receive({ command: "viewFileAtRevision", ...file });
    await asking.receive({ command: "openMergeEditor", repo, filePath: "f" });
    await asking.receive({ command: "openScmView" });

    const notice = ["showInformation", "This is not available in the GING desktop app yet."];
    expect(asking.asked).toEqual([notice, notice, notice]);
    expect(other.asked).toEqual([]);
    // Answered as done: the graph adds no "Unable to open" box of its own.
    expect(sentOf(asking.posted, "viewFileAtRevision")).toEqual([
      { command: "viewFileAtRevision", success: true }
    ]);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("shows a commit's change to a file in its own page's diff viewer, decoded per the setting (#404)", async () => {
    const { shared, repos, open, logged } = setUp();
    const asking = open(repos[0]);
    const other = open(repos[1]);
    const repo = repos[0];
    // "café\n" in windows-1252: the é is the one byte 0xE9, which is no utf8.
    fs.writeFileSync(path.join(repo, "legacy.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    git(["add", "legacy.txt"], repo);
    git(["commit", "-m", "add legacy"], repo);
    const head = rev(repo, "HEAD");
    await shared.config.update("ging-git-view.defaultFileEncoding", "win1252");

    await asking.receive({
      command: "viewDiff",
      repo,
      commitHash: head,
      oldFilePath: "legacy.txt",
      newFilePath: "legacy.txt",
      type: "A"
    });

    expect(sentOf(asking.posted, "viewDiff")).toEqual([{ command: "viewDiff", success: true }]);
    expect(asking.diffs).toEqual([
      {
        command: "showDiff",
        title: `legacy.txt (Added in ${head.slice(0, 8)})`,
        original: { path: "legacy.txt", content: "" },
        modified: { path: "legacy.txt", content: "café\n" },
        revealLine: null,
        strings: {
          sideBySide: "Side by Side",
          inline: "Inline",
          close: "Close Diff",
          cannotShow: "The diff viewer could not be loaded."
        }
      }
    ]);
    expect(other.diffs).toEqual([]);
    expect(asking.asked).toEqual([]);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("shows a file at a commit against the working tree's in its page's diff viewer (#404)", async () => {
    const { repos, open, logged } = setUp();
    const page = open(repos[0]);
    const repo = repos[0];
    fs.writeFileSync(path.join(repo, "notes.txt"), "committed\n");
    git(["add", "notes.txt"], repo);
    git(["commit", "-m", "add notes"], repo);
    fs.writeFileSync(path.join(repo, "notes.txt"), "committed, then edited\n");
    const head = rev(repo, "HEAD");

    await page.receive({
      command: "viewDiffWithWorking",
      repo,
      commitHash: head,
      filePath: "notes.txt"
    });

    expect(sentOf(page.posted, "viewDiffWithWorking")).toEqual([
      { command: "viewDiffWithWorking", success: true }
    ]);
    expect(page.diffs).toEqual([
      expect.objectContaining({
        title: `notes.txt (${head.slice(0, 8)} ↔ Working Tree)`,
        original: { path: "notes.txt", content: "committed\n" },
        modified: { path: "notes.txt", content: "committed, then edited\n" }
      })
    ]);
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

  it("configures the provider of a host Create Pull Request knows none for, in its own prompts, into the app's settings", async () => {
    const { shared, repos, open, revealed, logged } = setUp();
    const page = open(repos[0]);
    git(["remote", "add", "origin", "https://git.example.com/owner/repo.git"], repos[0]);
    const configure = shared.l10n.t("pullRequest.configureProvider");
    page.answers.showError = configure;
    page.answers.replies = ["Gitea / Forgejo", shared.l10n.t("pullRequest.providers.showSetting")];

    await page.receive({ command: "selectRepo", repo: repos[0] });
    await page.receive({
      command: "createPullRequest",
      repo: repos[0],
      branchName: "main",
      remote: "origin"
    });

    await expect.poll(() => revealed).toEqual(["ging-git-view.pullRequests.providers"]);
    expect(shared.config.pullRequestProviders()).toEqual([
      { host: "git.example.com", type: "gitea" }
    ]);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
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
