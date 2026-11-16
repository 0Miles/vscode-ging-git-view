import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphInstance } from "@ging/desktop/graphInstance";
import { createSharedServices } from "@ging/desktop/sharedServices";
import type { ResponseMessage } from "@ging/shared/types";

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
  const shared = createSharedServices({
    userDataPath: userData,
    locale: "en",
    helperDir: userData,
    logger: {
      log: (line) => logged.push(line),
      logError: (line) => logged.push(`ERROR: ${line}`),
      reveal: () => {}
    },
    clipboard: { writeText: async () => {} }
  });
  const instances: { dispose(): void }[] = [];
  /** The settings each instance asked the app to show. */
  const revealed: string[] = [];
  onTestFinished(() => {
    instances.forEach((instance) => instance.dispose());
    shared.dispose();
    [userData, ...repos].forEach(rmrf);
  });

  /** An instance on `repo`, as the main process opens one. */
  const open = (repo: string) => {
    const page = fakeWebview();
    const { ports, answers } = fakePorts();
    shared.repoSource.addRepo(repo);
    const instance = createGraphInstance(shared, {
      repo,
      channel: page.webview,
      prompts: ports.prompts,
      revealSetting: (key) => revealed.push(key)
    });
    instances.push(instance);
    return { instance, answers, ...page };
  };
  return { shared, repos, open, logged, revealed };
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
