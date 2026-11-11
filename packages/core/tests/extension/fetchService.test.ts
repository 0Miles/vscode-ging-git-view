import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchService, type FetchServiceDeps } from "@ging/core/extension/fetchService";

import { fakeGit, fakePorts, recordingRunRepoMutation } from "@ging/core/tests/helpers";

// The one fetch service and the entry points that reach it from outside the
// graph's webview bridge — the `fetch` and `fetchRemote` commands, the
// auto-fetch timer and the fetch of one listed remote. Each is driven with fake ports, a fake git that
// records its argv, and a recording `runRepoMutation`, so one ordered log shows
// whether the git call ran inside the hook, and how a failure was reported.

const REPO = "/repo";
const UNREACHABLE = "fatal: unable to access 'https://example.invalid/'";

function harness(overrides: Partial<FetchServiceDeps> = {}) {
  const { ports, calls, answers } = fakePorts();
  const settings = { prune: true, pruneTags: false, autoFetch: false, minutes: 10 };
  const git = fakeGit(calls);
  let currentRepo: string | null = REPO;
  const service = createFetchService({
    config: {
      fetchAndPrune: () => settings.prune,
      fetchAndPruneTags: () => settings.pruneTags,
      autoFetchEnabled: () => settings.autoFetch,
      autoFetchIntervalMinutes: () => settings.minutes
    },
    prompts: ports.prompts,
    l10n: ports.l10n,
    gitClientFor: git.clientFor,
    currentRepo: () => currentRepo,
    repoSource: { getRepos: () => ({ [REPO]: { columnWidths: null } }) },
    runRepoMutation: recordingRunRepoMutation(calls),
    ...overrides
  });
  return {
    service,
    calls,
    answers,
    settings,
    git: git.state,
    fakeGit: git.clientFor,
    failGit: () => {
      git.state.failure = UNREACHABLE;
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
    await h.service.fetchRemoteCommand();
    // `--prune-tags` without `--prune` is git's rule, not ours (ADR-0012).
    expect(h.calls).toContainEqual(["git", REPO, "fetch", "origin"]);
  });

  it("goes around the hook, and leaves a failure to its caller", async () => {
    const h = harness();
    h.failGit();
    await expect(h.service.fetchAll(h.fakeGit(REPO))).rejects.toThrow("unable to access");
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

describe("the Fetch Remote command", () => {
  it("fetches the only remote of the current repository without asking", async () => {
    const h = harness();
    await h.service.fetchRemoteCommand();
    expect(h.calls).toEqual([
      ["git", REPO, "remote", "-v"],
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--prune", "origin"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("asks which of several remotes, and fetches the one picked inside the hook", async () => {
    const h = harness();
    h.git.remotes.upstream = "https://example.com/upstream.git";
    h.answers.pick = "upstream";
    await h.service.fetchRemoteCommand();
    expect(h.calls).toEqual([
      ["git", REPO, "remote", "-v"],
      ["pick", [{ label: "origin" }, { label: "upstream" }], { placeholder: "fetch.pickRemote" }],
      ["runRepoMutation", REPO],
      ["git", REPO, "fetch", "--prune", "upstream"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("fetches nothing when the pick is dismissed", async () => {
    const h = harness();
    h.git.remotes.upstream = "https://example.com/upstream.git";
    await h.service.fetchRemoteCommand();
    expect(h.calls.map(([name]) => name)).toEqual(["git", "pick"]);
  });

  it("says so when the repository has no remotes", async () => {
    const h = harness();
    h.git.remotes = {};
    await h.service.fetchRemoteCommand();
    expect(h.calls).toEqual([
      ["git", REPO, "remote", "-v"],
      ["showInformation", "fetch.noRemotes"]
    ]);
  });

  it("reports a failure to list the remotes as a fetch failure", async () => {
    const h = harness();
    h.git.failure = "fatal: not a git repository";
    await h.service.fetchRemoteCommand();
    expect(h.calls).toEqual([
      ["git", REPO, "remote", "-v"],
      ["showError", "error.unableToFetch: not a git repository"]
    ]);
  });

  it("says so, and fetches nothing, without a current repository", async () => {
    const h = harness();
    h.setCurrentRepo(null);
    await h.service.fetchRemoteCommand();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
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
