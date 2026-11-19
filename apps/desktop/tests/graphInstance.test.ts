import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { REPO_CHANGE_DEBOUNCE_MS } from "@ging/core/backend/utils/repoWatchPaths";
import { createGraphInstance } from "@ging/desktop/graphInstance";
import { createRecentRepos } from "@ging/desktop/recentRepos";
import { createSharedServices } from "@ging/desktop/sharedServices";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";
import type {
  FileBlameHostMessage,
  FileBlameRequest
} from "@ging/webview/desktop/diff/blameProtocol";
import type {
  ShowDiffMessage,
  ShowFileMessage,
  ViewerMessage
} from "@ging/webview/desktop/diff/protocol";
import type { FileHistoryRequest } from "@ging/webview/desktop/fileHistory/protocol";
import type { SideViewStateMessage } from "@ging/webview/desktop/sideViews/protocol";
import type { WorkingTreeRequest } from "@ging/webview/desktop/workingTree/protocol";

import {
  fakePorts,
  fakeWebview,
  git,
  hangingGitServer,
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
  /** The test's two repositories, each made when first asked for: most
   *  tests open only the first. */
  const made: string[] = [];
  const madeAt = (i: number) => (made[i] ??= toRepoPath(makeRepo()));
  const repos = {
    get 0() {
      return madeAt(0);
    },
    get 1() {
      return madeAt(1);
    }
  };
  const logged: string[] = [];
  /** What the system was asked to open: nothing here starts anything. */
  const opened: unknown[][] = [];
  /** What was put on the clipboard. */
  const copied: string[] = [];
  const shared = createSharedServices({
    userDataPath: userData,
    locale: "en",
    helperDir: userData,
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`),
      reveal: () => {}
    },
    clipboard: {
      writeText: async (text) => {
        copied.push(text);
      }
    },
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
    rmrf(userData);
    made.forEach(rmrf);
  });

  /** An instance on `repo`, as the main process opens one; `asked` is what its
   *  own prompts were asked. */
  const open = (repo: string, picked: (root: string) => string | null = () => null) => {
    const page = fakeWebview();
    const { ports, answers, calls } = fakePorts();
    shared.repoSource.addRepo(repo);
    const state = shared.tabStates.newTab(repo);
    /** What its side views were sent (#399). */
    const sideViews: SideViewStateMessage[] = [];
    /** The diffs (#404) and files (#405) it handed its page. */
    const diffs: ViewerMessage[] = [];
    const instance = createGraphInstance(shared, {
      repo,
      channel: page.webview,
      prompts: ports.prompts,
      postSideView: (message) => {
        if (message.command === "sideViewState") sideViews.push(message);
      },
      extensionState: state,
      revealSetting: (key) => revealed.push(key),
      postDiff: (message) => {
        diffs.push(message);
        return true;
      },
      pickFile: async (root) => picked(root)
    });
    instances.push(instance);
    return { instance, answers, state, asked: calls, diffs, sideViews, ...page };
  };
  return { shared, repos, open, logged, opened, revealed, copied };
}

/** A known repository's path whose folder is not there. */
function goneFolder(): string {
  const parent = makeTempDir("ging-desktop-gone-");
  onTestFinished(() => rmrf(parent));
  return toRepoPath(path.join(parent, "repo"));
}

/** Twenty numbered lines, `edit` making some of them something else. */
const lines = (edit: (n: number) => string) =>
  Array.from({ length: 20 }, (_, i) => edit(i + 1)).join("\n") + "\n";

const sentOf = (posted: ResponseMessage[], command: ResponseMessage["command"]) =>
  posted.filter((msg) => msg.command === command);

/** The file histories handed to the page (#408): past the graph's types. */
const histories = (posted: ResponseMessage[]) =>
  posted.filter((msg) => (msg.command as string) === "fileHistory") as unknown as {
    path: string;
    start: string | null;
    entries: { subject: string; path: string; oldPath: string; hash: string }[];
    first: boolean;
    more: boolean;
    error: string | null;
  }[];

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

  it("drops its own repository no second time once it has left the known set", async () => {
    const { shared, repos, open, logged } = setUp();
    const page = open(repos[0]);
    const other = open(repos[1]);
    rmrf(path.join(repos[0], ".git"));
    await page.receive({ command: "loadRepos", check: true });
    const before = sentOf(page.posted, "loadRepos").length;
    const otherBefore = sentOf(other.posted, "loadRepos").length;

    await page.receive({ command: "loadRepos", check: true });

    // Nothing of its own left to check: answered as an unchecked loadRepos is,
    // and the set not written, so no other Tab is told of it again.
    expect(sentOf(page.posted, "loadRepos").slice(before)).toEqual([
      { command: "loadRepos", repos: {}, lastActiveRepo: null }
    ]);
    expect(sentOf(other.posted, "loadRepos")).toHaveLength(otherBefore);
    expect(Object.keys(shared.repoSource.getRepos())).toEqual([repos[1]]);
    expect(logged.filter((line) => line.includes("dropped from the known set"))).toHaveLength(1);
  });

  it("says nothing kept of its own repository once it has left the known set, its folder gone", async () => {
    const { shared, repos, open, logged } = setUp();
    const page = open(repos[0]);
    shared.repoSource.dropRepo(repos[0]);
    rmrf(repos[0]);
    expect(fs.existsSync(repos[0])).toBe(false);
    const before = sentOf(page.posted, "loadRepos").length;

    await page.receive({ command: "loadRepos", check: true });

    expect(sentOf(page.posted, "loadRepos").slice(before)).toEqual([
      { command: "loadRepos", repos: {}, lastActiveRepo: null }
    ]);
    expect(logged.filter((line) => line.includes("kept in the known set"))).toEqual([]);
  });

  it("keeps its own repository, its folder not there now, on the recent list (#454)", async () => {
    const { shared, repos, open, logged } = setUp();
    const unmounted = repos[0];
    const page = open(unmounted);
    // Its folder gone from under the open Tab, as `goneFolder` names one: a
    // disk not mounted at the moment, which no look at the disk tells from a
    // folder deleted. (A Tab is opened on a folder that is there only.)
    rmrf(unmounted);
    expect(fs.existsSync(unmounted)).toBe(false);
    /** Told when a look at the list's folders found one otherwise. */
    let lookedAt: () => void = Function.prototype as () => void;
    const recent = createRecentRepos({
      store: shared.storage.workspace,
      repoSource: shared.repoSource,
      onChange: () => lookedAt()
    });
    onTestFinished(() => recent.dispose());
    recent.opened(unmounted);
    const current = page.state.getLastActiveRepo();
    const before = sentOf(page.posted, "loadRepos").length;

    await page.receive({ command: "loadRepos", check: true });

    expect(Object.keys(shared.repoSource.getRepos())).toEqual([unmounted]);
    // Nothing dropped, so answered as an unchecked loadRepos is, once.
    expect(sentOf(page.posted, "loadRepos").slice(before)).toEqual([
      { command: "loadRepos", repos: { [unmounted]: expect.anything() }, lastActiveRepo: unmounted }
    ]);
    expect(page.state.getLastActiveRepo()).toBe(current);
    expect(logged).toContain(`tabs: ${unmounted}'s folder is not there now, kept in the known set`);
    expect(logged.filter((line) => line.includes("dropped from the known set"))).toEqual([]);

    // Still listed, and marked as not there once looked at.
    expect(recent.list().map((entry) => entry.path)).toEqual([unmounted]);
    const looked = new Promise<void>((resolve) => {
      lookedAt = resolve;
    });
    recent.check();
    await looked;
    expect(recent.list()).toEqual([expect.objectContaining({ path: unmounted, missing: true })]);
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

  it("shows a file at a commit read-only in its own page, decoded per the setting (#405)", async () => {
    const { shared, repos, open, logged } = setUp();
    const asking = open(repos[0]);
    const other = open(repos[1]);
    const repo = repos[0];
    // "café\n" in windows-1252: the é is the one byte 0xE9, which is no utf8.
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(
      path.join(repo, "src", "legacy.ts"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    );
    git(["add", "src/legacy.ts"], repo);
    git(["commit", "-m", "add legacy"], repo);
    const head = rev(repo, "HEAD");
    // Changed since: what is shown is the commit's.
    fs.writeFileSync(path.join(repo, "src", "legacy.ts"), "edited\n");
    await shared.config.update("ging-git-view.defaultFileEncoding", "win1252");

    await asking.receive({
      command: "viewFileAtRevision",
      repo,
      commitHash: head,
      filePath: "src/legacy.ts"
    });

    expect(sentOf(asking.posted, "viewFileAtRevision")).toEqual([
      { command: "viewFileAtRevision", success: true }
    ]);
    expect(asking.diffs).toEqual([
      {
        command: "showFile",
        title: `legacy.ts (${head.slice(0, 8)})`,
        file: { path: "src/legacy.ts", content: "café\n" },
        notShown: null,
        strings: { close: "Close File", cannotShow: "The file viewer could not be loaded." },
        // And offered to be blamed (#409), the toggle left as it is.
        blame: {
          file: 1,
          show: false,
          strings: {
            toggle: "Blame",
            blaming: "Blaming...",
            failed: "Git could not blame this file.",
            findInGraph: "Find Commit in Graph"
          }
        }
      }
    ]);
    expect(other.diffs).toEqual([]);
    // No notice: the desktop app shows it.
    expect(asking.asked).toEqual([]);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("answers that a file of no revision it reads could not be opened, and shows nothing (#405)", async () => {
    const { repos, open } = setUp();
    const asking = open(repos[0]);

    await asking.receive({
      command: "viewFileAtRevision",
      repo: repos[0],
      commitHash: "--output=x",
      filePath: "f"
    });

    // The graph says it itself, as for any file it could not open.
    expect(sentOf(asking.posted, "viewFileAtRevision")).toEqual([
      { command: "viewFileAtRevision", success: false }
    ]);
    expect(asking.diffs).toEqual([]);
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
        notShown: null,
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

  describe("a file's history (#408)", () => {
    const BEFORE = "one\ntwo\nthree\nfour\n";
    const AFTER = BEFORE + "five\n";
    /** `repo` with "old.txt" committed, changed, then renamed "new.txt". */
    function renamed(repo: string) {
      fs.writeFileSync(path.join(repo, "old.txt"), BEFORE);
      git(["add", "old.txt"], repo);
      git(["commit", "-qm", "add old"], repo);
      fs.writeFileSync(path.join(repo, "old.txt"), AFTER);
      git(["commit", "-qam", "change old"], repo);
      git(["mv", "old.txt", "new.txt"], repo);
      git(["commit", "-qm", "rename to new"], repo);
    }

    it("reads its panel's history past the dispatch, each entry under the path the file had there", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);
      renamed(repos[0]);
      const fromPanel = (request: FileHistoryRequest) =>
        page.receive(request as unknown as RequestMessage);

      await fromPanel({ command: "fileHistoryReady" });
      await fromPanel({ command: "fileHistoryOpen", request: 1, path: "new.txt", start: null });

      expect(page.posted[0]).toEqual({
        command: "fileHistoryStrings",
        strings: expect.objectContaining({ menuItem: "View File History" })
      });
      const [history] = histories(page.posted);
      expect(history).toMatchObject({
        path: "new.txt",
        start: rev(repos[0], "HEAD"),
        request: 1,
        first: true,
        more: false
      });
      expect(
        history.entries.map(({ subject, path: at, oldPath }) => [subject, at, oldPath])
      ).toEqual([
        ["rename to new", "new.txt", "old.txt"],
        ["change old", "old.txt", "old.txt"],
        ["add old", "old.txt", "old.txt"]
      ]);
      // Only read: the graph is not refreshed, nothing asked.
      expect(sentOf(page.posted, "refresh")).toEqual([]);
      expect(page.asked).toEqual([]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("opens an entry from before the rename as the old path's diff, in its own page", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);
      renamed(repos[0]);
      const changed = rev(repos[0], "HEAD~1");

      await page.receive({
        command: "fileHistoryDiff",
        entry: { hash: changed, change: "M", path: "old.txt", oldPath: "old.txt", submodule: null }
      } as unknown as RequestMessage);

      expect(page.diffs).toEqual([
        expect.objectContaining({
          title: `old.txt (${changed.slice(0, 8)}^ ↔ ${changed.slice(0, 8)})`,
          original: { path: "old.txt", content: BEFORE },
          modified: { path: "old.txt", content: AFTER }
        })
      ]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("refuses an entry whose commit is not a hash, reading nothing", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);

      await page.receive({
        command: "fileHistoryDiff",
        entry: { hash: "--output=x", change: "M", path: "f", oldPath: "f", submodule: null }
      } as unknown as RequestMessage);

      expect(page.diffs).toEqual([]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toHaveLength(1);
    });

    it("shows the history of the file the menu's File History… picked, from HEAD", async () => {
      const { repos, open } = setUp();
      const asked: string[] = [];
      const page = open(repos[0], (root) => {
        asked.push(root);
        return path.join(repos[0], "new.txt");
      });
      renamed(repos[0]);

      await page.instance.commands.fileHistory();

      expect(asked).toEqual([repos[0]]);
      expect(histories(page.posted)).toEqual([
        expect.objectContaining({ path: "new.txt", start: rev(repos[0], "HEAD"), error: null })
      ]);
    });

    it("says so in its own window when the file picked is not in its repository", async () => {
      const { repos, open } = setUp();
      const outside = path.join(repos[1], "f");
      const page = open(repos[0], () => outside);

      await page.instance.commands.fileHistory();

      expect(histories(page.posted)).toEqual([]);
      expect(page.asked).toEqual([["showError", `${outside} is not in this repository.`]]);
    });

    it("says so in its own window when the file picked is one git does not track", async () => {
      const { repos, open } = setUp();
      fs.writeFileSync(path.join(repos[0], "scratch.txt"), "never added");
      const page = open(repos[0], () => path.join(repos[0], "scratch.txt"));

      await page.instance.commands.fileHistory();

      expect(histories(page.posted)).toEqual([]);
      expect(page.asked).toEqual([
        [
          "showInformation",
          "scratch.txt is not tracked by Git (untracked or ignored): it has no history."
        ]
      ]);
    });

    it("answers its panel's later pages of the history open, and none once it is closed", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      renamed(repos[0]);
      const fromPanel = (request: FileHistoryRequest) =>
        page.receive(request as unknown as RequestMessage);

      await fromPanel({ command: "fileHistoryOpen", request: 1, path: "new.txt", start: null });
      await fromPanel({ command: "fileHistoryMore", request: 1 });
      // A page of a history not open is nobody's.
      await fromPanel({ command: "fileHistoryMore", request: 7 });
      await fromPanel({ command: "fileHistoryClose" });
      await fromPanel({ command: "fileHistoryMore", request: 1 });

      expect(histories(page.posted).map(({ first, more }) => ({ first, more }))).toEqual([
        { first: true, more: false },
        { first: false, more: false }
      ]);
    });

    it("does nothing when no file is picked", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);

      await page.instance.commands.fileHistory();

      expect(page.posted).toEqual([]);
      expect(page.asked).toEqual([]);
    });
  });

  describe("a file's blame (#409)", () => {
    /** `repo` with "a.txt" committed by Bea, then its second line changed by
     *  the user; the commits' hashes. */
    function twoCommits(repo: string) {
      fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
      git(["add", "a.txt"], repo);
      git(["commit", "-qm", "add a", "--author=Bea <bea@example.com>"], repo);
      const first = rev(repo, "HEAD");
      fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\n");
      git(["commit", "-qam", "shout two"], repo);
      return { first, second: rev(repo, "HEAD") };
    }
    /** The blame view's messages handed to the page: past the graph's types. */
    const blameMessages = (posted: ResponseMessage[]) =>
      posted.filter((msg) =>
        (msg.command as string).startsWith("fileBlame")
      ) as unknown as FileBlameHostMessage[];
    const fromPage = (page: { receive(m: RequestMessage): Promise<void> }, r: FileBlameRequest) =>
      page.receive(r as unknown as RequestMessage);

    /** The file at `commit`, opened as the CDV's View File at this Revision
     *  opens it; the number it is offered to be blamed by. */
    async function viewAt(
      page: Awaited<ReturnType<ReturnType<typeof setUp>["open"]>>,
      repo: string,
      commit: string
    ) {
      await page.receive({
        command: "viewFileAtRevision",
        repo,
        commitHash: commit,
        filePath: "a.txt"
      });
      const shown = page.diffs.at(-1) as ShowFileMessage;
      return shown.blame!.file;
    }

    it("blames the file its page shows as the commit has it, past the dispatch", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);
      const { first, second } = twoCommits(repos[0]);
      const file = await viewAt(page, repos[0], second);

      await fromPage(page, { command: "fileBlameOpen", file });

      expect(blameMessages(page.posted)).toEqual([
        {
          command: "fileBlame",
          file,
          blame: {
            repo: repos[0],
            commits: [
              { sha: first, uncommitted: false, text: expect.stringMatching(/^Bea, .* • add a$/) },
              {
                sha: second,
                uncommitted: false,
                text: expect.stringMatching(/^You, .* • shout two$/)
              }
            ],
            lines: [0, 1]
          }
        }
      ]);
      // Only read: nothing refreshed, nothing asked.
      expect(sentOf(page.posted, "refresh")).toEqual([]);
      expect(page.asked).toEqual([]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("blames nothing but the file offered last", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      const { first, second } = twoCommits(repos[0]);
      const before = await viewAt(page, repos[0], first);
      await viewAt(page, repos[0], second);

      await fromPage(page, { command: "fileBlameOpen", file: before });
      await fromPage(page, { command: "fileBlameOpen", file: 99 });

      expect(blameMessages(page.posted)).toEqual([]);
    });

    it("offers no blame of the index's copy of a file", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      twoCommits(repos[0]);

      await page.instance.showFile({
        title: "a.txt (index)",
        file: { revision: { repo: repos[0], filePath: "a.txt", commit: ":0" } }
      });

      expect((page.diffs[0] as ShowFileMessage).blame).toBeUndefined();
    });

    it("writes a line's hover in full, and runs its links: a hash copied, the line's change shown, the commit located", async () => {
      const { repos, open, copied } = setUp();
      const page = open(repos[0]);
      const { first, second } = twoCommits(repos[0]);
      const file = await viewAt(page, repos[0], second);
      await fromPage(page, { command: "fileBlameOpen", file });

      await fromPage(page, { command: "fileBlameHoverOf", file, line: 1 });
      const [, hover] = blameMessages(page.posted);
      expect(hover).toMatchObject({ command: "fileBlameHover", file, line: 1 });
      expect((hover as { markdown: string }).markdown).toContain("-two\n+TWO");
      expect((hover as { markdown: string }).markdown).toContain(
        "(command:ging.blame.locateCommit?"
      );

      await fromPage(page, { command: "fileBlameRun", file, link: "copySha", arg: second });
      expect(copied).toEqual([second]);
      expect(blameMessages(page.posted).at(-1)).toEqual({
        command: "fileBlameSaid",
        file,
        text: `Copied commit hash ${second.slice(0, 8)}`
      });

      const change = { repo: repos[0], sha: second, filename: "a.txt", line: 2 };
      await fromPage(page, {
        command: "fileBlameRun",
        file,
        link: "openLineChange",
        arg: { ...change, previous: { sha: first, filename: "a.txt" } }
      });
      expect(page.diffs.at(-1)).toMatchObject({
        command: "showDiff",
        original: { path: "a.txt", content: "one\ntwo\n" },
        modified: { path: "a.txt", content: "one\nTWO\n" },
        revealLine: 2
      });

      await fromPage(page, {
        command: "fileBlameRun",
        file,
        link: "locateCommit",
        arg: { repo: repos[0], sha: first }
      });
      expect(sentOf(page.posted, "locateCommit")).toEqual([
        { command: "locateCommit", repo: repos[0], hash: first, seq: 1 }
      ]);
      expect(page.asked).toEqual([]);
    });

    it("runs no link whose argument is not of its repository, saying so for a locate", async () => {
      const { repos, open, copied } = setUp();
      const page = open(repos[0]);
      const { second } = twoCommits(repos[0]);
      const file = await viewAt(page, repos[0], second);

      await fromPage(page, { command: "fileBlameRun", file, link: "copySha", arg: "HEAD" });
      await fromPage(page, {
        command: "fileBlameRun",
        file,
        link: "locateCommit",
        arg: { repo: repos[1], sha: second }
      });

      expect(copied).toEqual([]);
      expect(sentOf(page.posted, "locateCommit")).toEqual([]);
      expect(page.asked).toEqual([["showError", "Unable to locate the commit in the GING graph"]]);
    });

    it("shows the menu's Blame File… pick as the working tree has it, blamed at once, its lines not committed said so", async () => {
      const { repos, open } = setUp();
      twoCommits(repos[0]);
      fs.writeFileSync(path.join(repos[0], "a.txt"), "one\nTWO\nnot yet\n");
      const page = open(repos[0], (root) => path.join(root, "a.txt"));

      await page.instance.commands.blameFile();

      const [shown] = page.diffs as ShowFileMessage[];
      expect(shown).toMatchObject({
        command: "showFile",
        title: "a.txt (Working Tree)",
        file: { path: "a.txt", content: "one\nTWO\nnot yet\n" },
        blame: { show: true }
      });
      await fromPage(page, { command: "fileBlameOpen", file: shown.blame!.file });
      const [answer] = blameMessages(page.posted) as {
        blame: { commits: unknown[]; lines: number[] };
      }[];
      expect(answer.blame.lines).toEqual([0, 1, 2]);
      expect(answer.blame.commits[2]).toEqual({
        sha: "0".repeat(40),
        uncommitted: true,
        text: "You • Uncommitted changes"
      });
    });

    it("says so in its own window when the file picked is one git does not track", async () => {
      const { repos, open } = setUp();
      fs.writeFileSync(path.join(repos[0], "scratch.txt"), "never added");
      const page = open(repos[0], () => path.join(repos[0], "scratch.txt"));

      await page.instance.commands.blameFile();

      expect(page.diffs).toEqual([]);
      expect(page.asked).toEqual([
        [
          "showInformation",
          "scratch.txt is not tracked by Git (untracked or ignored): no commit has its lines."
        ]
      ]);
    });

    it("answers a hover asked over with none, never one short of its message and hunk", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      const { second } = twoCommits(repos[0]);
      const file = await viewAt(page, repos[0], second);
      await fromPage(page, { command: "fileBlameOpen", file });

      // The pointer sweeps down the annotations: line 0 asked, then line 1.
      const overtaken = fromPage(page, { command: "fileBlameHoverOf", file, line: 0 });
      const latest = fromPage(page, { command: "fileBlameHoverOf", file, line: 1 });
      await Promise.all([overtaken, latest]);

      const hovers = blameMessages(page.posted)
        .filter((m) => m.command === "fileBlameHover")
        .toSorted((a, b) => (a as { line: number }).line - (b as { line: number }).line);
      expect(hovers).toEqual([
        { command: "fileBlameHover", file, line: 0, markdown: null },
        expect.objectContaining({ line: 1, markdown: expect.stringContaining("+TWO") })
      ]);
    });

    it("stops blaming once its page lets the file go, and answers nothing after", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      const { second } = twoCommits(repos[0]);
      const file = await viewAt(page, repos[0], second);

      const blaming = fromPage(page, { command: "fileBlameOpen", file });
      await fromPage(page, { command: "fileBlameClose", file });
      await blaming;
      await fromPage(page, { command: "fileBlameHoverOf", file, line: 0 });

      expect(blameMessages(page.posted)).toEqual([]);
    });
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

  it("opens its working tree panel's file in its page's diff viewer, and stages a hunk of it there, past the dispatch (#460, #406)", async () => {
    const { repos, open, logged } = setUp();
    const page = open(repos[0]);
    const repo = repos[0];
    fs.writeFileSync(path.join(repo, "n.txt"), lines(String));
    git(["add", "n.txt"], repo);
    git(["commit", "-m", "numbered"], repo);
    fs.writeFileSync(
      path.join(repo, "n.txt"),
      lines((n) => (n === 2 || n === 19 ? "x" : String(n)))
    );
    const posted = (request: unknown) => page.receive(request as RequestMessage);

    await posted({ command: "workingTreeShowDiff", path: "n.txt", area: "unstaged" });
    expect(page.diffs).toEqual([
      expect.objectContaining({
        title: "n.txt (Working Tree)",
        hunks: expect.objectContaining({ area: "unstaged", label: "Stage Hunk" })
      })
    ]);
    const refreshesBefore = sentOf(page.posted, "refresh").length;

    await posted({
      command: "diffHunk",
      path: "n.txt",
      area: "unstaged",
      token: (page.diffs[0] as ShowDiffMessage).hunks!.token,
      hunk: 0,
      asked: 1
    });

    expect(
      cp.execFileSync("git", ["diff", "--cached", "--numstat"], { cwd: repo }).toString()
    ).toBe("1\t1\tn.txt\n");
    expect(page.diffs).toHaveLength(2);
    expect((page.diffs[1] as ShowDiffMessage).hunks?.hunks).toHaveLength(1);
    // The graph, and the panel with it, redrawn after the change.
    expect(sentOf(page.posted, "refresh")).toHaveLength(refreshesBefore + 1);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  describe("in a merge stopped on a conflict (#410)", () => {
    /** `repo`'s merge of `side` stopped on a conflict in f, with the merge
     *  tool `theirs` configured in the repository: a command, no window. */
    function conflicted(repo: string) {
      const run = (...args: string[]) => git(args, repo);
      run("checkout", "-q", "-b", "side");
      fs.writeFileSync(path.join(repo, "f"), "side\n");
      run("commit", "-qam", "side");
      run("checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "f"), "main\n");
      run("commit", "-qam", "main");
      expect(cp.spawnSync("git", ["merge", "side"], { cwd: repo }).status).not.toBe(0);
      run("config", "merge.tool", "theirs");
      run("config", "mergetool.theirs.cmd", 'cp "$REMOTE" "$MERGED"');
      run("config", "mergetool.theirs.trustExitCode", "true");
    }
    const unmerged = (repo: string) =>
      cp.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repo }).toString();

    it("hands the graph's conflicted file to the merge tool, and says in its own window when there is none to resolve", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);
      const other = open(repos[1]);
      conflicted(repos[0]);

      await page.receive({ command: "openMergeEditor", repo: repos[0], filePath: "f" });
      // The port answers nothing; the graph redrawn once the tool has closed
      // is what tells. `git mergetool` is a shell script of git's: seconds,
      // on Windows, before it so much as starts the tool.
      await expect
        .poll(() => sentOf(page.posted, "refresh").length, { timeout: 20_000 })
        .toBeGreaterThan(0);
      // Resolved: nothing to say.
      expect(unmerged(repos[0])).toBe("");
      expect(fs.readFileSync(path.join(repos[0], "f"), "utf8")).toBe("side\n");
      expect(page.asked).toEqual([]);

      await page.receive({ command: "openMergeEditor", repo: repos[0], filePath: "f" });
      await expect
        .poll(() => page.asked)
        .toEqual([["showInformation", "f has no conflict to resolve."]]);
      expect(other.asked).toEqual([]);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });

    it("asks before the banner's Mark Resolved stages a file still holding conflict markers", async () => {
      const { repos, open } = setUp();
      const page = open(repos[0]);
      conflicted(repos[0]);
      const ask = [
        "choose",
        "f still has conflict markers in it. Mark it resolved anyway?",
        { detail: undefined, actions: ["Mark Resolved"] }
      ];

      // Declined: the dispatch never hears of it, and the graph is answered.
      await page.receive({ command: "markResolved", repo: repos[0], filePath: "f" });
      expect(page.asked).toEqual([ask]);
      expect(unmerged(repos[0])).toBe("f\n");
      expect(sentOf(page.posted, "markResolved")).toEqual([
        { command: "markResolved", status: null }
      ]);

      page.answers.choose = "Mark Resolved";
      await page.receive({ command: "markResolved", repo: repos[0], filePath: "f" });
      await expect.poll(() => unmerged(repos[0])).toBe("");
      expect(page.asked).toEqual([ask, ask]);
    });

    it("marks resolved and continues for its working tree panel, asking first while markers remain", async () => {
      const { repos, open, logged } = setUp();
      const page = open(repos[0]);
      conflicted(repos[0]);
      const fromPanel = (request: WorkingTreeRequest) =>
        page.receive(request as unknown as RequestMessage);
      const answers = () =>
        page.posted.filter((msg) => (msg.command as string) === "workingTreeStatus") as unknown as {
          request: string;
          status: { conflicted: unknown[]; operation?: string } | null;
          error: string | null;
        }[];

      await fromPanel({ command: "workingTreeLoad" });
      expect(answers()[0].status).toMatchObject({
        operation: "merge",
        conflicted: [{ path: "f" }]
      });

      // Markers left, and the question dismissed: nothing changes.
      await fromPanel({ command: "workingTreeResolve", paths: ["f"] });
      expect(page.asked).toHaveLength(1);
      expect(answers()[1].status?.conflicted).toHaveLength(1);

      fs.writeFileSync(path.join(repos[0], "f"), "both\n");
      await fromPanel({ command: "workingTreeResolve", paths: ["f"] });
      expect(page.asked).toHaveLength(1);
      expect(answers()[2].status?.conflicted).toEqual([]);

      await fromPanel({ command: "workingTreeContinue" });
      expect(answers()[3]).toMatchObject({ request: "workingTreeContinue", error: null });
      expect(answers()[3].status?.operation).toBeUndefined();
      expect(
        cp.execFileSync("git", ["log", "-1", "--format=%P"], { cwd: repos[0] }).toString().trim()
      ).toMatch(/^\S+ \S+$/);
      expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
    });
  });

  it("filters the graph by its side view's selection, and clears it for the graph's Show All (#399)", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);
    await page.receive({ command: "selectRepo", repo: repos[0] });

    await page.instance.sideView({
      command: "sideViewSetFilter",
      repo: repos[0],
      branches: ["main"],
      seq: 1
    });
    expect(sentOf(page.posted, "setBranchFilter")).toEqual([
      { command: "setBranchFilter", branches: ["main"] }
    ]);

    // The graph's filter chip: Show All is the side view's, as in VS Code.
    await page.receive({ command: "clearBranchFilter", repo: repos[0] });
    expect(sentOf(page.posted, "setBranchFilter").at(-1)).toEqual({
      command: "setBranchFilter",
      branches: []
    });
    expect(sentOf(page.posted, "branchFilterCleared")).toEqual([
      { command: "branchFilterCleared" }
    ]);
    expect(page.asked).toEqual([]);
  });

  it("clears no filter for a Show All that names another repository", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);
    await page.receive({ command: "selectRepo", repo: repos[0] });
    await page.instance.sideView({
      command: "sideViewSetFilter",
      repo: repos[0],
      branches: ["main"],
      seq: 1
    });

    await page.receive({ command: "clearBranchFilter", repo: repos[1] });

    expect(sentOf(page.posted, "setBranchFilter")).toHaveLength(1);
    // Answered all the same: the graph is not left waiting.
    expect(sentOf(page.posted, "branchFilterCleared")).toHaveLength(1);
  });

  it("sends its side views the repository's branches once the page listens", async () => {
    const { repos, open } = setUp();
    const page = open(repos[0]);
    expect(page.sideViews).toEqual([]);

    // Settles once both reads have been sent, in either order: the last state
    // carries both.
    await page.instance.sideView({ command: "sideViewReady" });

    expect(page.sideViews.at(-1)).toMatchObject({
      repo: repos[0],
      branches: { roots: [{ type: "leaf", branch: "main", isHead: true }] },
      remotes: []
    });
  });

  it("pops a stash its Stash view lists, asking in its own prompts, and redraws its graph (#400)", async () => {
    const { shared, repos, open, logged } = setUp();
    const page = open(repos[0]);
    fs.writeFileSync(path.join(repos[0], "f"), "stashed");
    git(["stash", "push", "-m", "wip"], repos[0]);
    await page.instance.sideView({ command: "sideViewReady" });
    const [stash] = page.sideViews.at(-1)!.stashes!;
    expect(stash).toMatchObject({ selector: "stash@{0}", message: "On main: wip" });
    // Its stash log watch reads once more after it is hung, past the
    // debounce: let that land before acting, so what follows is the pop's.
    const sentBefore = page.sideViews.length;
    await expect
      .poll(() => page.sideViews.length, { timeout: REPO_CHANGE_DEBOUNCE_MS + 5_000 })
      .toBeGreaterThan(sentBefore);
    page.answers.choose = shared.l10n.t("dialog.stash.pop");

    await page.instance.sideView({ command: "sideViewStash", action: "pop", id: stash.id });

    expect(page.asked[0]).toEqual([
      "choose",
      shared.l10n.t("dialog.stash.popConfirm", "stash@{0}"),
      {
        detail: shared.l10n.t("dialog.stash.reinstateIndexDetail"),
        actions: [
          shared.l10n.t("dialog.stash.pop"),
          shared.l10n.t("dialog.stash.popReinstateIndex")
        ]
      }
    ]);
    expect(fs.readFileSync(path.join(repos[0], "f"), "utf8")).toBe("stashed");
    expect(page.sideViews.at(-1)!.stashes).toEqual([]);
    // Changed muted, then redrawn, as core's command services' changes are.
    expect(sentOf(page.posted, "refresh").length).toBeGreaterThan(0);
    expect(logged.filter((line) => line.startsWith("ERROR"))).toEqual([]);
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
    for (const repo of [repos[0], repos[1]])
      git(["remote", "add", "origin", "https://example.com/r.git"], repo);
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

  it("stops the git its fetch started once disposed, and no other instance's, saying nothing (#450)", async () => {
    const servers = [await hangingGitServer(), await hangingGitServer()];
    const { repos, open, logged } = setUp();
    const closed = open(repos[0]);
    const other = open(repos[1]);
    try {
      git(["remote", "add", "origin", servers[0].url], repos[0]);
      git(["remote", "add", "origin", servers[1].url], repos[1]);
      const closedFetch = closed.instance.commands.fetch();
      void other.instance.commands.fetch();
      await expect.poll(servers[0].openConnections, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect.poll(servers[1].openConnections, { timeout: 15_000 }).toBeGreaterThan(0);
      const otherConnections = servers[1].openConnections();

      closed.instance.dispose();

      // Its fetch ends, and with it the connection git held: the server never
      // answers, so only a kill lets it go.
      await closedFetch;
      await expect.poll(servers[0].openConnections, { timeout: 15_000 }).toBe(0);
      // The other's fetch runs on, connected as it was.
      expect(servers[1].openConnections()).toBe(otherConnections);
      // Nothing said in the disposed instance's page: a line in the log.
      expect(
        closed.asked.filter(([name]) => name === "showError" || name === "showInformation")
      ).toEqual([]);
      expect(logged).toContain("error.unableToFetch: git fetch: aborted");
    } finally {
      other.instance.dispose();
      await Promise.all(servers.map((server) => server.close()));
    }
  }, 60_000);
});
