import { describe, expect, it, onTestFinished, vi } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { runNetworkGit } from "@ging/core/backend/gitRun";
import { GitAbortedError } from "@ging/core/backend/utils/gitError";
import {
  createHostShutdown,
  createShutDownFetching,
  startHostShutdown
} from "@ging/vscode/hostShutdown";

import { fakePorts, git, hangingGitServer, makeRepo, rmrf } from "@ging/core/tests/helpers";

// The VS Code host's deactivation (#450): the signal its fetches run under is
// aborted, and deactivation waits, bounded, for the git it stopped to go.

/** Anything asked of it is another of it, callable and constructible: enough
 *  for `extension.ts` to load, nothing of it run. */
const anything = vi.hoisted(() => {
  // Inside `vi.hoisted`: the mock's factory runs before the module's scope.
  // A function each time: `extends` and `new` need one.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const make = (): unknown =>
    new Proxy(function () {}, {
      get: (_target, prop) => (prop === "then" ? undefined : make()),
      apply: () => make(),
      construct: () => make() as object
    });
  return make;
});
vi.mock("vscode", () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => (prop === "then" ? undefined : anything()),
      has: () => true
    }
  );
});

describe("the extension's deactivate", () => {
  it("aborts the signal activate started its fetches under", async () => {
    const shutdown = startHostShutdown();
    const { deactivate } = await import("@ging/vscode/extension");

    await deactivate();

    expect(shutdown.signal.aborted).toBe(true);
  }, 60_000);

  it("stops the fetch activate's services run, and resolves once its git has gone", async () => {
    const server = await hangingGitServer();
    try {
      const repo = makeRepo();
      onTestFinished(() => rmrf(repo));
      git(["remote", "add", "origin", server.url], repo);
      const { ports, calls } = fakePorts();
      const logged: string[] = [];
      // As `activate` builds them.
      const { runRepoMutation, fetchService } = createShutDownFetching({
        watcher: () => undefined,
        afterMutation: () => {},
        fetch: {
          config: {
            fetchAndPrune: () => false,
            fetchAndPruneTags: () => false,
            autoFetchEnabled: () => false,
            autoFetchIntervalMinutes: () => 10
          },
          prompts: ports.prompts,
          l10n: ports.l10n,
          logger: { log: (line) => logged.push(line) },
          gitClientFor: (target) => gitClientFactory(target, "git").getInstance(),
          currentRepo: () => repo,
          repoSource: { getRepos: () => ({ [repo]: { columnWidths: null } }) }
        },
        networkGit: { gitPath: () => "git" }
      });
      const { deactivate } = await import("@ging/vscode/extension");
      const fetching = fetchService.fetchCommand();
      await expect.poll(server.openConnections, { timeout: 15_000 }).toBeGreaterThan(0);

      await deactivate();

      // Gone by the time deactivation is done, not just sent a kill: on
      // Windows the extension host exits right after.
      expect(server.openConnections()).toBe(0);
      await fetching;
      expect(logged).toEqual(["error.unableToFetch: git fetch: aborted"]);
      expect(calls.filter(([name]) => String(name).startsWith("show"))).toEqual([]);
      await expect(runRepoMutation(repo, async () => {})).rejects.toBeInstanceOf(GitAbortedError);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("a host shutdown", () => {
  it("stops a fetch running under it, and resolves once that git has gone", async () => {
    const server = await hangingGitServer();
    try {
      const repo = makeRepo();
      onTestFinished(() => rmrf(repo));
      git(["remote", "add", "origin", server.url], repo);
      const shutdown = createHostShutdown();
      const fetching = runNetworkGit(
        { gitPath: () => "git", signal: shutdown.signal, onAborted: shutdown.onAborted },
        repo,
        ["fetch", "origin"]
      );
      const outcome = fetching.then(
        () => "done",
        (e: unknown) => e
      );
      await expect.poll(server.openConnections, { timeout: 15_000 }).toBeGreaterThan(0);

      await shutdown.shutDown(10_000);

      expect(await outcome).toBeInstanceOf(GitAbortedError);
      // Gone by the time it resolved, not just sent a kill.
      expect(server.openConnections()).toBe(0);
    } finally {
      await server.close();
    }
  }, 40_000);

  it("waits no longer than it is given", async () => {
    const shutdown = createHostShutdown();
    shutdown.onAborted(new Promise<void>(() => {}));
    const started = Date.now();

    await shutdown.shutDown(200);

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
