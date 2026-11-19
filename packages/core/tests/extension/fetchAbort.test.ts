import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { runNetworkGit, stoppableNetworkCommands } from "@ging/core/backend/gitRun";
import { GitAbortedError } from "@ging/core/backend/utils/gitError";
import { createFetchService } from "@ging/core/extension/fetchService";
import { createRunRepoMutation } from "@ging/core/extension/repoMutation";

import { fakePorts, git, hangingGitServer, makeRepo, rmrf } from "@ging/core/tests/helpers";

// The git a fetch starts is stopped when the signal its host hands the fetch
// service and the mutation hook aborts — an instance disposed of, the app
// quitting, the extension deactivated (#450). Driven against a real git and a
// server that never answers, so only a kill ends the fetch.

/** Long enough for a killed git to let its connection go, however loaded. */
const SETTLE_MS = 15_000;

function setUp(signal: AbortSignal, autoFetch = false) {
  const repo = makeRepo();
  onTestFinished(() => rmrf(repo));
  const { ports, calls } = fakePorts();
  const logged: string[] = [];
  const spawned: string[][] = [];
  const mutations: string[] = [];
  const run = createRunRepoMutation({
    watcher: () => undefined,
    afterMutation: () => mutations.push("refresh"),
    signal
  });
  const service = createFetchService({
    config: {
      fetchAndPrune: () => false,
      fetchAndPruneTags: () => false,
      autoFetchEnabled: () => autoFetch,
      autoFetchIntervalMinutes: () => 1
    },
    prompts: ports.prompts,
    l10n: ports.l10n,
    logger: { log: (line) => logged.push(line) },
    gitClientFor: (target) => gitClientFactory(target, "git").getInstance(),
    currentRepo: () => repo,
    repoSource: { getRepos: () => ({ [repo]: { columnWidths: null } }) },
    runRepoMutation: (target, work) => {
      mutations.push("run");
      return run(target, work);
    },
    networkGit: {
      gitPath: () => "git",
      onCommand: (_command, args) => spawned.push(args),
      signal
    }
  });
  onTestFinished(() => service.dispose());
  /** What was said to the user, rather than logged. */
  const said = () => calls.filter(([name]) => name === "showError" || name === "showInformation");
  return { repo, service, logged, spawned, mutations, said };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a fetch whose signal aborts", () => {
  it("stops the git it started, connection and all, and says nothing", async () => {
    const server = await hangingGitServer();
    try {
      const controller = new AbortController();
      const h = setUp(controller.signal);
      git(["remote", "add", "origin", server.url], h.repo);

      const fetching = h.service.fetchCommand();
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBeGreaterThan(0);
      controller.abort();

      // The command settles, and git with its remote helper lets the
      // connection go: nothing else would, the server never answering.
      await fetching;
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBe(0);
      expect(h.said()).toEqual([]);
      expect(h.logged).toEqual(["error.unableToFetch: git fetch: aborted"]);
      // Nothing left to redraw.
      expect(h.mutations).toEqual(["run"]);
    } finally {
      await server.close();
    }
  }, 40_000);

  it("hands its host what settles once that git is gone, for a quit to wait on", async () => {
    const server = await hangingGitServer();
    try {
      const controller = new AbortController();
      const exits: Promise<void>[] = [];
      const repo = makeRepo();
      onTestFinished(() => rmrf(repo));
      git(["remote", "add", "origin", server.url], repo);
      const net = {
        gitPath: () => "git",
        signal: controller.signal,
        onAborted: (exited: Promise<void>) => exits.push(exited)
      };

      const fetching = runNetworkGit(net, repo, ["fetch", "origin"]);
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBeGreaterThan(0);
      controller.abort();

      await expect(fetching).rejects.toBeInstanceOf(GitAbortedError);
      expect(exits).toHaveLength(1);
      await exits[0];
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBe(0);
    } finally {
      await server.close();
    }
  }, 40_000);

  it("stops the fetch of one remote the same way", async () => {
    const server = await hangingGitServer();
    try {
      const controller = new AbortController();
      const h = setUp(controller.signal);
      git(["remote", "add", "origin", server.url], h.repo);

      const fetching = h.service.fetchRemoteCommand();
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBeGreaterThan(0);
      controller.abort();

      await fetching;
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBe(0);
      expect(h.said()).toEqual([]);
    } finally {
      await server.close();
    }
  }, 40_000);
});

describe("a fetch asked for once the signal has aborted", () => {
  it("spawns no git, and says nothing", async () => {
    const server = await hangingGitServer();
    try {
      const controller = new AbortController();
      const h = setUp(controller.signal);
      git(["remote", "add", "origin", server.url], h.repo);
      controller.abort();

      await h.service.fetchCommand();
      await h.service.fetchOneCommand(h.repo, "origin");

      expect(h.spawned).toEqual([]);
      expect(server.openConnections()).toBe(0);
      expect(h.said()).toEqual([]);
      expect(h.logged).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("is refused by the mutation hook without running its work", async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => {});
    const run = createRunRepoMutation({
      watcher: () => undefined,
      afterMutation: () => {},
      signal: controller.signal
    });

    await expect(run("/repo", work)).rejects.toBeInstanceOf(GitAbortedError);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("the auto-fetch timer", () => {
  it("fires no more once the signal aborts", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const h = setUp(controller.signal, true);
    h.service.restartAutoFetch();
    controller.abort();

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(h.mutations).toEqual([]);
  });

  it("is not started again once the signal has aborted", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const h = setUp(controller.signal, true);
    controller.abort();
    h.service.restartAutoFetch();

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(h.mutations).toEqual([]);
  });

  it("stops the git a tick started, connection and all, and says nothing", async () => {
    const server = await hangingGitServer();
    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const controller = new AbortController();
      const h = setUp(controller.signal, true);
      git(["remote", "add", "origin", server.url], h.repo);
      h.service.restartAutoFetch();

      vi.advanceTimersByTime(60 * 1000);
      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBeGreaterThan(0);
      controller.abort();

      await expect.poll(server.openConnections, { timeout: SETTLE_MS }).toBe(0);
      expect(h.said()).toEqual([]);
      expect(h.mutations).toEqual(["run"]);
    } finally {
      await server.close();
    }
  }, 40_000);
});

describe("a remote named like an option", () => {
  it("is fetched as a name, never run as one", async () => {
    const controller = new AbortController();
    const h = setUp(controller.signal);
    const marker = path.join(h.repo, "ran");
    const remote = `--upload-pack=touch ${marker.replaceAll("\\", "/")}`;

    await h.service.fetchOneCommand(h.repo, remote);

    expect(fs.existsSync(marker)).toBe(false);
    expect(h.said().map(([name]) => name)).toEqual(["showError"]);
  });
});

describe("a git client's network commands, through NetworkGit (the graph's own)", () => {
  async function client(signal: AbortSignal) {
    const server = await hangingGitServer();
    const repo = makeRepo();
    onTestFinished(() => rmrf(repo));
    git(["remote", "add", "origin", server.url], repo);
    const exits: Promise<void>[] = [];
    const stoppable = stoppableNetworkCommands(
      gitClientFactory(repo, "git").getInstance(),
      () => repo,
      {
        gitPath: () => "git",
        signal,
        onAborted: (exited) => exits.push(exited)
      }
    );
    return { server, repo, stoppable, exits };
  }

  it.each([
    ["fetch", ["fetch", "--all"]],
    ["push", ["push", "origin", "main"]],
    [
      "push with -c before it",
      ["-c", "push.useForceIfIncludes=true", "push", "--force-with-lease", "origin", "main"]
    ]
  ])(
    "stops a %s its signal aborts",
    async (_name, args) => {
      const controller = new AbortController();
      const c = await client(controller.signal);
      try {
        const running = c.stoppable.raw(args);
        await expect.poll(c.server.openConnections, { timeout: SETTLE_MS }).toBeGreaterThan(0);
        controller.abort();

        await expect(running).rejects.toBeInstanceOf(GitAbortedError);
        expect(c.exits).toHaveLength(1);
        await expect.poll(c.server.openConnections, { timeout: SETTLE_MS }).toBe(0);
      } finally {
        await c.server.close();
      }
    },
    40_000
  );

  it("leaves every other command to the client", async () => {
    const controller = new AbortController();
    controller.abort();
    const c = await client(controller.signal);
    try {
      // Read through the client even with the signal aborted: only the
      // network commands are the signal's.
      expect((await c.stoppable.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
      await expect(c.stoppable.raw(["fetch", "origin"])).rejects.toBeInstanceOf(GitAbortedError);
      expect(c.server.openConnections()).toBe(0);
    } finally {
      await c.server.close();
    }
  });
});
