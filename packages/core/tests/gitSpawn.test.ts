import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { spawnGit } from "@ging/core/backend/gitSpawn";

import { makeRepo, rmrf } from "@ging/core/tests/helpers";

// The two tree-kill tests share one shape. The alias's shell marks `started`,
// sleeps, then marks `survived`; if anything below the killed child lives on,
// the second marker gets written. Each test kills only once `started` is there,
// so the shell already exists when `taskkill` looks for the tree, and checks a
// second after the sleep would have ended. `killTree` does not wait for
// `taskkill`, so the sleep is all the time the tree gets to die in: under load
// `taskkill` has been measured at up to ~5 s, and a shell has taken up to ~4.4 s
// to start (#343).
const slowAlias = (sleepSeconds: number) =>
  `alias.nggslow=!echo > started && sleep ${sleepSeconds} && echo done > survived`;
const hasStarted = (dir: string) => fs.existsSync(path.join(dir, "started"));
const START_TIMEOUT_MS = 10_000;

/** Resolves with the time the alias's shell was first seen to have started. */
async function waitForStart(dir: string): Promise<number> {
  await vi.waitFor(() => expect(hasStarted(dir), "the alias has not started").toBe(true), {
    timeout: START_TIMEOUT_MS,
    interval: 20
  });
  return Date.now();
}

/** Waits until a second after the alias's sleep would have ended, then checks
 *  that nothing was left alive to mark `survived`. */
async function expectTreeGone(dir: string, startedAt: number, sleepSeconds: number) {
  const sleepEnded = startedAt + sleepSeconds * 1000;
  await new Promise((r) => setTimeout(r, Math.max(0, sleepEnded + 1000 - Date.now())));
  expect(fs.existsSync(path.join(dir, "survived"))).toBe(false);
}

describe("spawnGit (real git)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmrf(repo);
  });

  it("feeds stdin to the git child", async () => {
    const result = await spawnGit({
      gitPath: "git",
      cwd: repo,
      args: ["hash-object", "--stdin"],
      stdin: "hello\n"
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.exitCode).toBe(0);
    // `printf 'hello\n' | git hash-object --stdin`, worked out independently.
    expect(result.stdout.toString().trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("logs the command it spawns, with the colour-off config the git client uses", async () => {
    const logged: { command: string; args: string[] }[] = [];
    await spawnGit({
      gitPath: "git",
      cwd: repo,
      args: ["rev-parse", "HEAD"],
      onCommand: (command, args) => logged.push({ command, args })
    });
    expect(logged).toHaveLength(1);
    expect(logged[0].command).toBe("git");
    expect(logged[0].args).toEqual(expect.arrayContaining(["-c", "color.ui=false"]));
    expect(logged[0].args.slice(-2)).toEqual(["rev-parse", "HEAD"]);
  });

  it("kills a child that runs past the timeout and reports the timeout", async () => {
    // A `!`-shell alias that would sleep far longer than the budget. Run from the
    // temp dir, not the repo: on Windows killing git does not reach the shell it
    // started, and the orphan must not hold the repo open against `rmrf`.
    const started = Date.now();
    const result = await spawnGit({
      gitPath: "git",
      cwd: os.tmpdir(),
      args: ["-c", "alias.nggsleep=!sleep 5", "nggsleep"],
      timeoutMs: 300
    });
    expect(result.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  // Killing only the direct child is not enough: on Windows `git` on PATH is
  // the `cmd\git.exe` wrapper, and the real git and the shell under it live on.
  it("kills the whole process tree under the timed-out git", async () => {
    // The timer runs from the spawn, so it must not fire before the shell has
    // started (up to ~4.4 s under load), and the sleep must then still leave
    // `taskkill` at least sleepSeconds - timeoutMs = 5 s.
    const timeoutMs = 5000;
    const sleepSeconds = 10;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-kill-"));
    try {
      // Checked the moment the timeout settles, i.e. as `killTree` runs.
      let startedBeforeKill: boolean | undefined;
      const running = spawnGit({
        gitPath: "git",
        cwd: dir,
        args: ["-c", slowAlias(sleepSeconds), "nggslow"],
        timeoutMs
      }).then((result) => {
        startedBeforeKill = hasStarted(dir);
        return result;
      });
      const startedAt = await waitForStart(dir);
      expect((await running).kind).toBe("timeout");
      expect(startedBeforeKill, "the timeout fired before the alias started").toBe(true);
      await expectTreeGone(dir, startedAt, sleepSeconds);
    } finally {
      rmrf(dir);
    }
  });

  // Aborting must take the processes down too, not just drop the result: a
  // lookup nobody wants any more would otherwise run on to its deadline.
  it("kills the whole process tree when aborted, and reports the abort", async () => {
    const sleepSeconds = 5;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-abort-"));
    try {
      const abort = new AbortController();
      const running = spawnGit({
        gitPath: "git",
        cwd: dir,
        args: ["-c", slowAlias(sleepSeconds), "nggslow"],
        // Only a backstop, well past the wait for the start.
        timeoutMs: 30_000,
        signal: abort.signal
      });
      const startedAt = await waitForStart(dir);
      const abortedAt = Date.now();
      abort.abort();
      expect((await running).kind).toBe("aborted");
      expect(Date.now() - abortedAt).toBeLessThan(2000);
      await expectTreeGone(dir, startedAt, sleepSeconds);
    } finally {
      rmrf(dir);
    }
  });

  it("spawns nothing once already aborted", async () => {
    const logged: string[][] = [];
    const abort = new AbortController();
    abort.abort();
    const result = await spawnGit({
      gitPath: "git",
      cwd: repo,
      args: ["rev-parse", "HEAD"],
      signal: abort.signal,
      onCommand: (_command, args) => logged.push(args)
    });
    expect(result.kind).toBe("aborted");
    expect(logged).toEqual([]);
  });

  it("reports a git that cannot be started as an error rather than throwing", async () => {
    const result = await spawnGit({
      gitPath: "ngg-no-such-git-binary",
      cwd: repo,
      args: ["--version"]
    });
    expect(result.kind).toBe("error");
  });

  // Same sanitising as the git client: an ambient GIT_DIR must not redirect the
  // child away from the repo it was pointed at, while ordinary variables pass.
  describe("environment", () => {
    const saved: Record<string, string | undefined> = {};
    const setEnv = (key: string, value: string) => {
      saved[key] = process.env[key];
      process.env[key] = value;
    };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("strips repo-location overrides inherited from the host", async () => {
      setEnv("GIT_DIR", os.tmpdir());
      const result = await spawnGit({ gitPath: "git", cwd: repo, args: ["rev-parse", "HEAD"] });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toMatch(/^[0-9a-f]{40}$/);
    });

    it("forwards ordinary inherited variables to the child", async () => {
      const marker = `ngg-marker-${process.pid}`;
      setEnv("NGG_TEST_MARKER", marker);
      const result = await spawnGit({
        gitPath: "git",
        cwd: repo,
        args: ["-c", 'alias.nggechomarker=!printf %s "$NGG_TEST_MARKER"', "nggechomarker"]
      });
      expect(result.kind === "ok" && result.stdout.toString()).toBe(marker);
    });
  });
});
