import { describe, expect, it, onTestFinished, vi } from "vitest";

import { runNetworkGit } from "@ging/core/backend/gitRun";
import { GitAbortedError } from "@ging/core/backend/utils/gitError";
import { createHostShutdown, startHostShutdown } from "@ging/vscode/hostShutdown";

import { git, hangingGitServer, makeRepo, rmrf } from "@ging/core/tests/helpers";

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
