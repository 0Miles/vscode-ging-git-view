import type { SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";

import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnGit } from "@ging/core/backend/gitSpawn";
import { standInTerminals } from "@ging/desktop/e2e/mainProcess";
import { terminalLaunches } from "@ging/desktop/terminal";

// The E2E's stand-in for the system's terminal (e2e/mainProcess.ts) against
// what the app really hands `spawn`: it must take every terminal the app
// starts and no git. Outside Windows a git that goes to the network is
// detached too, in a process group of its own (#450); taken for a terminal,
// it was handed a child with no stdout, and the graph's Fetch failed with
// "Cannot read properties of undefined (reading 'on')" on Linux CI.

/** Each `spawn` the core's git makes, by its options; none is run. */
const gitSpawns = vi.hoisted((): SpawnOptions[] => []);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (_command: string, _args: string[], options: SpawnOptions) => {
    gitSpawns.push(options);
    throw new Error("not run");
  }
}));

/** What `spawnGit` hands `spawn` for a git that goes to the network, as it
 *  runs one outside Windows. */
async function networkGitOptions(): Promise<SpawnOptions> {
  gitSpawns.length = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  let run: Promise<unknown>;
  try {
    run = spawnGit({
      gitPath: "git",
      cwd: "/work/repo",
      args: ["fetch"],
      ownProcessGroup: true
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  await run.catch(() => {});
  expect(gitSpawns).toHaveLength(1);
  return gitSpawns[0];
}

const REAL_CHILD = { real: true };
/** The main process's global list the stand-in keeps what it took in. */
const KEPT = "terminalStandInTest";
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEPT];
});

/** The stand-in, put in place as `electronApp.evaluate` would, over a main
 *  process whose `node:child_process` spawns `REAL_CHILD`: its `spawn`, and
 *  what it kept. */
async function standIn() {
  const childProcess = { spawn: vi.fn((..._args: unknown[]) => REAL_CHILD) };
  const real = childProcess.spawn;
  const node = createRequire(import.meta.url);
  const mainModule = Object.getOwnPropertyDescriptor(process, "mainModule");
  Object.defineProperty(process, "mainModule", {
    configurable: true,
    writable: true,
    value: {
      require: (id: string) => (id === "node:child_process" ? childProcess : node(id))
    }
  });
  const electronApp = {
    evaluate: async (work: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
      work({}, arg)
  } as unknown as ElectronApplication;
  try {
    await standInTerminals(electronApp, KEPT);
  } finally {
    if (mainModule === undefined) delete (process as { mainModule?: unknown }).mainModule;
    else Object.defineProperty(process, "mainModule", mainModule);
  }
  const seen = (globalThis as Record<string, unknown>)[KEPT] as unknown[];
  const spawn = childProcess.spawn as unknown as (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => unknown;
  return { spawn, real, seen };
}

describe("standInTerminals", () => {
  it("lets a git that goes to the network run, though it is detached outside Windows (#450)", async () => {
    const options = await networkGitOptions();
    expect(options.detached).toBe(true);
    const { spawn, real, seen } = await standIn();

    expect(spawn("git", ["fetch"], options)).toBe(REAL_CHILD);
    expect(real).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "takes the terminal the app starts on %s",
    async (platform) => {
      const [launch] = terminalLaunches(
        platform,
        { ComSpec: "C:\\Windows\\system32\\cmd.exe", PATH: "/usr/bin" },
        "/work/repo",
        "GING: repo",
        () => true
      );
      const { spawn, real, seen } = await standIn();

      expect(spawn(launch.command, launch.args, launch.options)).not.toBe(REAL_CHILD);
      expect(real).not.toHaveBeenCalled();
      expect(seen).toEqual([
        {
          kind: "terminal",
          command: launch.command,
          args: launch.args,
          cwd: "/work/repo"
        }
      ]);
    }
  );
});
