import * as os from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { spawnGit } from "@/backend/gitSpawn";

import { makeRepo, rmrf } from "@tests/backend/helpers";

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
