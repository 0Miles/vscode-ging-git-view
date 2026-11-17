import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphInstance } from "@ging/desktop/graphInstance";
import { createSharedServices } from "@ging/desktop/sharedServices";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";
import type { WorkingTreeRequest } from "@ging/webview/desktop/workingTree/protocol";

import {
  fakePorts,
  fakeWebview,
  git,
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
    },
    hostVersions: [{ name: "GING", version: "1.2.3" }]
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
    const instance = createGraphInstance(shared, {
      repo,
      channel: page.webview,
      prompts: ports.prompts,
      extensionState: state,
      revealSetting: (key) => revealed.push(key)
    });
    instances.push(instance);
    return { instance, answers, state, asked: calls, ...page };
  };
  return { shared, repos, open, logged, opened, revealed };
}

/** A known repository's path whose folder is not there. */
function goneFolder(): string {
  const parent = makeTempDir("ging-desktop-gone-");
  onTestFinished(() => rmrf(parent));
  return toRepoPath(path.join(parent, "repo"));
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

  it("checks only its own repository when its graph asks which still exist", async () => {
    const { shared, repos, open } = setUp();
    const page = open(repos[0]);
    // On the recent list, its folder not there now: a disk not mounted, say.
    const unmounted = goneFolder();
    shared.repoSource.addRepo(unmounted);
    const before = sentOf(page.posted, "loadRepos").length;

    await page.receive({ command: "loadRepos", check: true });

    expect(Object.keys(shared.repoSource.getRepos())).toEqual(
      expect.arrayContaining([repos[0], unmounted])
    );
    // Its own is there: answered with it, as an unchecked loadRepos is.
    expect(sentOf(page.posted, "loadRepos").slice(before)).toEqual([
      expect.objectContaining({ lastActiveRepo: repos[0] })
    ]);
  });

  it("drops its own repository once it is none, and no other known one", async () => {
    const { shared, repos, open, logged } = setUp();
    const page = open(repos[0]);
    open(repos[1]);
    const unmounted = goneFolder();
    shared.repoSource.addRepo(unmounted);
    fs.rmSync(path.join(repos[0], ".git"), { recursive: true, force: true });

    await page.receive({ command: "loadRepos", check: true });

    expect(Object.keys(shared.repoSource.getRepos()).toSorted()).toEqual(
      [repos[1], unmounted].toSorted()
    );
    expect(logged).toContain(
      `tabs: ${repos[0]} is no Git repository any more, dropped from the known set`
    );
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

    const notice = ["showInformation", "This is not available in the GING desktop app yet."];
    expect(asking.asked).toEqual([notice, notice, notice, notice]);
    expect(other.asked).toEqual([]);
    // Answered as done: the graph adds no "Unable to open" box of its own.
    for (const command of ["viewFileAtRevision", "viewDiffWithWorking", "viewDiff"] as const) {
      expect(sentOf(asking.posted, command)).toEqual([{ command, success: true }]);
    }
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("opens its working tree panel for the graph's Open Source Control View, and nothing else", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);

    await page.receive({ command: "openScmView" });

    expect(page.posted).toEqual([{ command: "workingTreeShow" }]);
    expect(page.asked).toEqual([]);
  });

  it("stages and commits for its working tree panel, past the dispatch, and refreshes the graph", async () => {
    const { repos, open, logged } = setUp();
    const page = open(repos[0]);
    fs.writeFileSync(path.join(repos[0], "f"), "changed");
    /** A request of the panel's, as its page posts one: past the graph's types. */
    const fromPanel = (request: WorkingTreeRequest) =>
      page.receive(request as unknown as RequestMessage);
    const answers = () =>
      page.posted.filter((msg) => (msg.command as string) === "workingTreeStatus");

    await fromPanel({ command: "workingTreeLoad" });
    await fromPanel({ command: "workingTreeStage", paths: ["f"] });
    await fromPanel({ command: "workingTreeCommit", message: "From the panel" });

    expect(answers()).toEqual([
      expect.objectContaining({
        request: "workingTreeLoad",
        status: expect.objectContaining({ unstaged: [{ path: "f", change: "modified" }] }),
        error: null,
        strings: expect.objectContaining({ commit: "Commit", stageAll: "Stage All" })
      }),
      expect.objectContaining({
        request: "workingTreeStage",
        status: expect.objectContaining({ staged: [{ path: "f", change: "modified" }] })
      }),
      expect.objectContaining({
        request: "workingTreeCommit",
        status: expect.objectContaining({ staged: [], unstaged: [] }),
        error: null
      })
    ]);
    expect(
      cp.execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repos[0] }).toString().trim()
    ).toBe("From the panel");
    // The graph redrawn after each change, not after the read.
    expect(sentOf(page.posted, "refresh")).toHaveLength(2);
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

  it("runs the menu's remote commands on its own repository, asking in its own prompts", async () => {
    const { shared, repos, open, logged } = setUp();
    const page = open(repos[0]);
    const other = open(repos[1]);
    for (const repo of repos) git(["remote", "add", "origin", "https://example.com/r.git"], repo);
    page.answers.replies = ["origin", shared.l10n.t("remotes.rename"), "upstream"];

    await page.instance.commands.manageRemotes();

    const remotes = (repo: string) =>
      cp.execFileSync("git", ["remote"], { cwd: repo }).toString().trim();
    expect(remotes(repos[0])).toBe("upstream");
    expect(remotes(repos[1])).toBe("origin");
    expect(other.asked).toEqual([]);
    // A change to its repository redraws its graph.
    expect(sentOf(page.posted, "refresh").length).toBeGreaterThan(0);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("answers the figures of its own repository for Show Statistics", async () => {
    const { repos, open } = setUp();
    git(["commit", "--allow-empty", "-m", "second"], repos[1]);
    const page = open(repos[0]);
    open(repos[1]);

    expect(await page.instance.commands.statistics()).toMatchObject({ total: 1 });
  });

  it("opens the system terminal in its repository, named after its folder", async () => {
    const { repos, open, opened } = setUp();
    const page = open(repos[0]);

    page.instance.commands.openTerminal();

    // Once its folder is found in the repository, as the graph's own button.
    await expect
      .poll(() => opened)
      .toEqual([
        ["openTerminal", fs.realpathSync.native(repos[0]), `GING: ${path.basename(repos[0])}`]
      ]);
  });

  it("lists the app's versions and git's in Version Information, offering to copy them", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);

    await page.instance.commands.versionInfo();

    expect(page.asked).toEqual([
      [
        "showInformation",
        expect.stringMatching(/^GING: 1\.2\.3\nOS: .+\ngit version /),
        { modal: true, actions: ["Copy"] }
      ]
    ]);
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
