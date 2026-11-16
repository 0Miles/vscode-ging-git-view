import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";

// An interactive rebase through Electron, end to end (#392): the rebase dialog
// with a commit unticked out of the middle sends `rebaseInteractive`, whose todo
// the instance's sequence editor stages; git, spawned by the main process, runs
// the app's GIT_SEQUENCE_EDITOR helper — the app's own binary run as Node
// (`ELECTRON_RUN_AS_NODE` with `process.execPath`) — which puts that todo in
// place of git's and deletes it. `wasApplied` is that deletion. Had the helper
// not run, git's own todo would keep every commit and the action would fail
// with "never reached git" (rebase.ts); a RunAsNode fuse turned off (ADR-0032)
// is caught here.

const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;
/** What the page's failure report leaves in the log (graph.spec.ts). */
const WEBVIEW_FAILURE = /ERROR: webview |"reportError"/;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;

async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    // English whatever the machine's locale, so the page's words can be read.
    args: ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`, ...args],
    env: env as Record<string, string>
  });
  return app;
}

/** Close the app and read its whole log (see graph.spec.ts for why the file). */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(scratch, { recursive: true, force: true });
});

test("a rebase with a commit unticked from the middle runs GING's todo", async () => {
  const repo: FixtureRepo = makeFixtureRepo(env);
  let clock = 1_800_000_000;
  const git = (...args: string[]) => {
    const date = `${(clock += 60)} +0000`;
    return execFileSync("git", args, {
      cwd: repo.path,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        GIT_AUTHOR_NAME: "Alice",
        GIT_AUTHOR_EMAIL: "alice@example.com",
        GIT_COMMITTER_NAME: "Alice",
        GIT_COMMITTER_EMAIL: "alice@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      }
    })
      .toString()
      .trim();
  };
  // The rebase commits as someone: the isolated config knows nobody, and the
  // app's git is not given the fixture's GIT_AUTHOR_* / GIT_COMMITTER_*.
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  // Three more commits on main, each in a file of its own, so that replaying
  // any of them without another is no conflict.
  const added = ["a", "b", "c"].map((name) => {
    writeFileSync(path.join(repo.path, `${name}.txt`), `${name}\n`);
    git("add", `${name}.txt`);
    git("commit", "-m", `Add ${name}`);
    return git("rev-parse", "HEAD");
  });
  const [, b] = added;
  const third = repo.commits[0];
  const subjects = () => git("log", "--format=%s", "main").split("\n");
  try {
    const page = await (await launch("--repo", repo.path)).firstWindow();
    const rows = page.locator("#commitTable tr.commit");
    await expect(rows).toHaveCount(repo.commits.length + added.length);

    // Rebase main on its own Third commit: the dialog lists the three added
    // commits, all ticked, which would rebase nothing.
    await page.locator(`#commitTable tr.commit[data-hash="${third.hash}"]`).click({
      button: "right"
    });
    await page
      .locator("#contextMenu .contextMenuItem")
      .filter({ hasText: "Rebase current branch on this Commit" })
      .click();
    const dialog = page.locator("#dialog");
    await expect(dialog.locator(".rebasePickRow")).toHaveCount(added.length);

    // Unticking the middle one leaves a gap no range can spell: only an
    // interactive rebase with a todo of GING's own can run it.
    await dialog.locator(`.rebasePickRow input[data-hash="${b}"]`).uncheck();
    await expect(dialog.locator("#rebasePickCommand")).toContainText("--interactive");
    await page.locator("#dialogAction").click();

    // Done, and nothing said against it: the progress dialog closes on success,
    // and the graph redraws without the dropped commit.
    await expect(rows).toHaveCount(repo.commits.length + added.length - 1);
    await expect(dialog).toBeHidden();
    await expect(rows).not.toContainText(["Add b"]);

    // git ran GING's todo: b is gone, a and c kept, in their order.
    expect(subjects()).toEqual(["Add c", "Add a", "Third commit", "Second commit", "First commit"]);
    expect(git("ls-tree", "--name-only", "HEAD").split("\n")).not.toContain("b.txt");
    expect(git("status", "--porcelain")).toBe("");

    const logged = await closeAndReadLog();
    expect(logged).not.toMatch(WEBVIEW_FAILURE);
    expect(logged).not.toContain("ERROR:");
  } finally {
    await app?.close();
    app = null;
    rmSync(repo.path, { recursive: true, force: true });
  }
});
