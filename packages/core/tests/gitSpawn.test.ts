import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { spawnGit, streamGit } from "@ging/core/backend/gitSpawn";

import { makeRepo, rmrf } from "@ging/core/tests/helpers";

// The two tree-kill tests share one shape. The alias's shell marks `started`,
// sleeps, then marks `survived`; if anything below the killed child lives on,
// the second marker gets written. Each test kills only once `started` is there,
// so the shell already exists when `taskkill` looks for the tree, and checks a
// second after the sleep would have ended. `killTree` does not wait for
// `taskkill`, so the sleep is all the time the tree gets to die in (timings in
// #343).
// Waiting for `started` deliberately keeps these tests off #361: a kill during
// tree birth is a known gap (ADR-0028); a test comes with any fix.
const slowAlias = (sleepSeconds: number) =>
  `alias.nggslow=!echo > started && sleep ${sleepSeconds} && echo done > survived`;
const hasStarted = (dir: string) => fs.existsSync(path.join(dir, "started"));
const START_TIMEOUT_MS = 10_000;
/** How long the tree is given to die once `killTree` runs. */
const TASKKILL_WINDOW_MS = 5000;

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

// A paused stream that is killed must still end (#484): a child's `close`
// waits for its stdout to close. Node resumes a child's stdout when the child
// exits, but a reader that pauses on every piece it is handed — as the file
// history's does once it has a page — pauses it again at the next piece, and
// the rest of what git wrote before it died is never read to its end. The
// first case is that one, every time: git killed on a full pipe, which the old
// `kill` left hanging (its `ended` never settled). The second kills at once,
// git exited or not by then, and must end either way. Neither waits for
// anything but `ended`.
describe("streamGit (real git)", () => {
  let repo: string;
  /** A blob far larger than any pipe's buffer: git writing it blocks on a
   *  reader that has paused. */
  let big: string;
  beforeAll(async () => {
    repo = makeRepo();
    const written = await spawnGit({
      gitPath: "git",
      cwd: repo,
      args: ["hash-object", "-w", "--stdin"],
      stdin: "x".repeat(4 * 1024 * 1024)
    });
    big = written.kind === "ok" ? written.stdout.toString().trim() : "";
  });
  afterAll(() => {
    rmrf(repo);
  });

  it("ends once killed while git waits on the full pipe of a paused reader", async () => {
    const stream = streamGit({ gitPath: "git", cwd: repo, args: ["cat-file", "-p", big] });
    let read = 0;
    const first = new Promise<void>((resolve) =>
      stream.onData((chunk) => {
        read += chunk.length;
        stream.pause();
        resolve();
      })
    );
    stream.resume();
    await first;

    stream.kill();

    const how = await stream.ended;
    expect("error" in how).toBe(false);
    expect(read).toBeLessThan(4 * 1024 * 1024);
  });

  it("ends once killed before a byte of it was read, whether git had exited or not", async () => {
    const stream = streamGit({ gitPath: "git", cwd: repo, args: ["rev-parse", "HEAD"] });
    // A reader listens, and pauses on what it is handed, as the file history's does.
    stream.onData(() => stream.pause());

    stream.kill();

    expect("error" in (await stream.ended)).toBe(false);
  });

  it("reads to the end and ends on its own when resumed", async () => {
    const stream = streamGit({ gitPath: "git", cwd: repo, args: ["cat-file", "-p", big] });
    let read = 0;
    stream.onData((chunk) => (read += chunk.length));
    stream.resume();

    expect(await stream.ended).toEqual({ exitCode: 0, stderr: "" });
    expect(read).toBe(4 * 1024 * 1024);
  });
});

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

  it("hands stderr to onStderr as it comes, and keeps all of it in the result", async () => {
    const heard: string[] = [];
    const result = await spawnGit({
      gitPath: "git",
      cwd: repo,
      // An unknown revision: git says so on stderr, in its own words.
      args: ["rev-parse", "--verify", "no-such-revision"],
      onStderr: (text) => heard.push(text)
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(heard.join("")).toBe(result.stderr);
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
    // started, and the sleep must then still leave `taskkill` its window.
    const timeoutMs = 5000;
    const sleepSeconds = (timeoutMs + TASKKILL_WINDOW_MS) / 1000;
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
    const sleepSeconds = TASKKILL_WINDOW_MS / 1000;
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

  // Settled at once, but a caller about to clean up after git (a cancelled
  // clone, #395) needs to know when it is actually gone. git asking a local
  // HTTP server that never answers runs a remote helper of its own, a native
  // program on every platform, which shares its stderr; no shell in the tree,
  // so none of ADR-0028's three gaps.
  it("says when an aborted child, and what shares its output, is gone", async () => {
    const server = http.createServer((req) => req.resume());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    let requests = 0;
    server.on("request", () => (requests += 1));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-abort-exit-"));
    try {
      const abort = new AbortController();
      const running = spawnGit({
        gitPath: "git",
        cwd: repo,
        args: ["ls-remote", `http://127.0.0.1:${port}/repo.git`],
        timeoutMs: 60_000,
        signal: abort.signal,
        ownProcessGroup: true,
        // Nobody to ask for a credential, and no config of the machine's.
        gitEnv: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: ""
        }
      });
      await vi.waitFor(() => expect(requests).toBeGreaterThan(0), { timeout: START_TIMEOUT_MS });
      abort.abort();
      const result = await running;
      if (result.kind !== "aborted") throw new Error(`expected aborted, got ${result.kind}`);
      const abortedAt = Date.now();

      await result.exited;

      // Not git's own giving up, which takes as long as the server's silence.
      expect(Date.now() - abortedAt).toBeLessThan(TASKKILL_WINDOW_MS);
    } finally {
      server.closeAllConnections();
      server.close();
      rmrf(home);
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
    if (result.kind === "aborted") await expect(result.exited).resolves.toBeUndefined();
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
