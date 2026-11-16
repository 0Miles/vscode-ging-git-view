import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";

// Manage Pull Request Providers on the desktop host (#398): core's flow, run
// in the main process from a failed Create Pull Request. Its notices are the
// system's dialogs, answered here in their place (ADR-0032); its questions are
// asked in the graph's page, in the host prompt overlay; the provider lands in
// the app's settings file, and "Show Setting" opens the settings at its row.

const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;
const KEY = "ging-git-view.pullRequests.providers";

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

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
  cleanUp = [];
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  for (const dir of [scratch, ...cleanUp]) rmSync(dir, { recursive: true, force: true });
});

test("a provider configured from a failed Create Pull Request is asked in the page and saved to the app's settings", async () => {
  const repo = makeFixtureRepo(env);
  cleanUp.push(repo.path);
  // A self-hosted forge no built-in provider covers. Never reached: the URL
  // is only read.
  execFileSync("git", ["remote", "add", "origin", "https://git.example.com/owner/repo.git"], {
    cwd: repo.path,
    env
  });

  const electronApp = await launch("--repo", repo.path);
  const page = await electronApp.firstWindow();
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);

  // Every system box answered with its first button — "Configure a
  // Provider...", then "Show Setting" — and kept, to be read below.
  await electronApp.evaluate(({ dialog }) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedBoxes = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const askedBoxes = () =>
    electronApp.evaluate(() => (globalThis as Record<string, unknown>).askedBoxes);

  // What the branch menu's Create Pull Request sends.
  await page.evaluate((repoPath) => {
    const vscode = (
      globalThis as unknown as { acquireVsCodeApi(): { postMessage(m: unknown): void } }
    ).acquireVsCodeApi();
    vscode.postMessage({
      command: "createPullRequest",
      repo: repoPath,
      branchName: "main",
      remote: "origin"
    });
  }, repo.path);

  // Straight to the forge of the host it failed for, each with the URL it opens.
  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  const rows = overlay.locator(".hostPromptItem");
  await expect(rows.locator(".hostPromptItemLabel")).toHaveText([
    "GitHub",
    "GitLab",
    "Bitbucket",
    "Gitea / Forgejo",
    "Custom URL template"
  ]);
  await expect(rows.nth(3).locator(".hostPromptItemDetail")).toHaveText(
    "https://git.example.com/owner/repo/compare/my-branch"
  );
  await expect(page.getByPlaceholder("Which forge runs on git.example.com?")).toBeFocused();
  await page.keyboard.type("custom");
  await page.keyboard.press("Enter");

  // The URL, refused without {branch}, and asked again from it.
  const input = page.locator("#hostPromptInput");
  await expect(input).toHaveValue("https://git.example.com/{path}/compare/{branch}");
  await input.fill("https://git.example.com/{path}/pulls/new");
  await page.keyboard.press("Enter");
  await expect(overlay.locator(".hostPromptError")).toHaveText(
    "The template must contain {branch}"
  );
  await expect(input).toHaveValue("https://git.example.com/{path}/pulls/new");
  await page.keyboard.press("End");
  await page.keyboard.type("/{branch}");
  // "Show Setting" opens the settings, at the provider list.
  const settingsOpened = electronApp.waitForEvent("window");
  await page.keyboard.press("Enter");
  await expect(overlay).toBeHidden();

  const settings = await settingsOpened;
  await expect(settings.locator("html")).toHaveAttribute("data-ging-page", "settings");
  expect(new URL(settings.url()).searchParams.get("setting")).toBe(KEY);
  const row = settings.locator(`[id="${KEY}"]`);
  await expect(row).toBeInViewport();
  const saved = [
    {
      host: "git.example.com",
      type: "custom",
      urlTemplate: "https://git.example.com/{path}/pulls/new/{branch}"
    }
  ];
  expect(JSON.parse(await row.locator("textarea").inputValue())).toEqual(saved);
  expect(JSON.parse(readFileSync(path.join(scratch, "userData", "settings.json"), "utf8"))).toEqual(
    { [KEY]: saved }
  );

  expect(await askedBoxes()).toEqual([
    expect.objectContaining({
      type: "error",
      message: "No pull request provider is configured for git.example.com.",
      buttons: ["Configure a Provider...", "Cancel"]
    }),
    expect.objectContaining({
      type: "info",
      message: "Pull request provider for git.example.com saved to User settings.",
      buttons: ["Show Setting", "Cancel"]
    })
  ]);

  const logged = await closeAndReadLog();
  expect(logged).not.toMatch(/ERROR:|"reportError"/);
});
