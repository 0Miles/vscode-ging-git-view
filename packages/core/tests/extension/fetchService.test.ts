import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchService, type FetchServiceDeps } from "@ging/core/extension/fetchService";

import { fakePorts } from "@ging/core/tests/helpers";

// The one fetch service and the three entry points that reach it from outside
// the graph's webview bridge — the `fetch` command, the auto-fetch timer and
// the Remotes side-view's fetch. Each is driven with fake ports, a fake git that
// records its argv, and a recording `runRepoMutation`, so one ordered log shows
// whether the git call ran inside the hook, and how a failure was reported.

const REPO = "/repo";

function harness(overrides: Partial<FetchServiceDeps> = {}) {
  const { ports, calls } = fakePorts();
  const settings = { prune: true, pruneTags: false, autoFetch: false, minutes: 10 };
  let gitFails = false;
  let currentRepo: string | null = REPO;
  const fakeGit = (repo: string) =>
    ({
      raw: async (args: string[]) => {
        calls.push(["git", repo, ...args]);
        if (gitFails) throw new Error("fatal: unable to access 'https://example.invalid/'");
        return "";
      }
    }) as unknown as SimpleGit;
  const service = createFetchService({
    config: {
      fetchAndPrune: () => settings.prune,
      fetchAndPruneTags: () => settings.pruneTags,
      autoFetchEnabled: () => settings.autoFetch,
      autoFetchIntervalMinutes: () => settings.minutes
    },
    prompts: ports.prompts,
    l10n: ports.l10n,
    gitClientFor: fakeGit,
    currentRepo: () => currentRepo,
    runRepoMutation: async (repo, work) => {
      calls.push(["runRepoMutation", repo]);
      try {
        await work();
      } finally {
        calls.push(["runRepoMutation done", repo]);
      }
    },
    ...overrides
  });
  return {
    service,
    calls,
    settings,
    fakeGit,
    failGit: () => {
      gitFails = true;
    },
    setCurrentRepo: (repo: string | null) => {
      currentRepo = repo;
    }
  };
}

describe("the git call", () => {
  it("fetches every remote with the prune flags read at the moment of the call", async () => {
    const h = harness();
    await h.service.fetchAll(h.fakeGit(REPO));
    h.settings.pruneTags = true;
    await h.service.fetchAll(h.fakeGit(REPO));
    expect(h.calls).toEqual([
      ["git", REPO, "fetch", "--all", "--prune"],
      ["git", REPO, "fetch", "--all", "--prune", "--prune-tags"]
    ]);
  });

  it("fetches one remote with the same flags", async () => {
    const h = harness();
    h.settings.prune = false;
    h.settings.pruneTags = true;
    await h.service.fetchRemote(h.fakeGit(REPO), "upstream");
    // `--prune-tags` without `--prune` is git's rule, not ours (ADR-0012).
    expect(h.calls).toEqual([["git", REPO, "fetch", "upstream"]]);
  });

  it("goes around the hook, and leaves a failure to its caller", async () => {
    const h = harness();
    h.failGit();
    await expect(h.service.fetchAll(h.fakeGit(REPO))).rejects.toThrow("unable to access");
    await expect(h.service.fetchRemote(h.fakeGit(REPO), "origin")).rejects.toThrow();
    expect(h.calls.filter(([name]) => name !== "git")).toEqual([]);
  });
});

describe("the fetch command", () => {
  it("fetches the current repository inside the hook", async () => {
    const h = harness();
    await h.service.fetchCommand();
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--all", "--prune"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("reports a failure as a toast, after the hook has finished", async () => {
    const h = harness();
    h.failGit();
    await h.service.fetchCommand();
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--all", "--prune"],
      ["runRepoMutation done", REPO],
      ["showError", "error.unableToFetch: unable to access 'https://example.invalid/'"]
    ]);
  });

  it("reports a repo whose client cannot be built the same way", async () => {
    const h = harness({
      gitClientFor: () => {
        throw new Error("Cannot use simple-git on a directory that does not exist");
      }
    });
    await h.service.fetchCommand();
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["runRepoMutation done", REPO],
      ["showError", "error.unableToFetch: Cannot use simple-git on a directory that does not exist"]
    ]);
  });

  it("says so, and fetches nothing, without a current repository", async () => {
    const h = harness();
    h.setCurrentRepo(null);
    await h.service.fetchCommand();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });
});

describe("the Remotes side-view's fetch", () => {
  it("fetches the named remote of the item's repo inside the hook", async () => {
    const h = harness();
    await h.service.fetchOneCommand("/other", "upstream");
    expect(h.calls).toEqual([
      ["runRepoMutation", "/other"],
      ["git", "/other", "fetch", "--prune", "upstream"],
      ["runRepoMutation done", "/other"]
    ]);
  });

  it("reports a failure as a toast", async () => {
    const h = harness();
    h.failGit();
    await h.service.fetchOneCommand("/other", "upstream");
    expect(h.calls.at(-1)).toEqual([
      "showError",
      "error.unableToFetch: unable to access 'https://example.invalid/'"
    ]);
  });
});

describe("auto-fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const MINUTE = 60_000;

  it("does not run while it is off", async () => {
    const h = harness();
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(h.calls).toEqual([]);
  });

  it("fetches the current repository inside the hook, once per interval", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.settings.minutes = 5;
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--all", "--prune"],
      ["runRepoMutation done", REPO]
    ]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(h.calls).toHaveLength(6);
  });

  it("stays silent when the fetch fails", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.failGit();
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--all", "--prune"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("skips a tick, silently, with no current repository", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.setCurrentRepo(null);
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(h.calls).toEqual([]);
  });

  it("skips a tick while the last tick's fetch is still running", async () => {
    let finish!: () => void;
    let started = 0;
    const h = harness({
      gitClientFor: () =>
        ({
          raw: () => {
            started += 1;
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          }
        }) as unknown as SimpleGit
    });
    h.settings.autoFetch = true;
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(started).toBe(1);
    // A second tick lands while the first fetch hangs (a slow or offline remote).
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(started).toBe(1);
    expect(h.calls).toEqual([["runRepoMutation", REPO]]);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual([
      ["runRepoMutation", REPO],
      ["runRepoMutation done", REPO]
    ]);
    // Once it has settled, the next tick fetches again.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(started).toBe(2);
  });

  it("keeps the interval between one minute and an hour", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.settings.minutes = 0;
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.calls).toHaveLength(3);

    h.calls.length = 0;
    h.settings.minutes = 600;
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(h.calls).toHaveLength(3);
  });

  it("re-reads the settings on a restart, dropping the old timer", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.service.restartAutoFetch();
    h.settings.autoFetch = false;
    h.service.restartAutoFetch();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(h.calls).toEqual([]);
  });

  it("stops on dispose", async () => {
    const h = harness();
    h.settings.autoFetch = true;
    h.service.restartAutoFetch();
    h.service.dispose();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(h.calls).toEqual([]);
  });
});
