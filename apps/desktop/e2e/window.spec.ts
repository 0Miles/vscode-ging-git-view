import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

let userDataDir: string;
let app: ElectronApplication;
let output: string;

/** The arguments a launch of this app gives Electron. Every launch gets its
 *  own user data directory, which is also the single-instance lock's scope, so
 *  a GING the developer has open is neither touched nor in the way. */
const appArgs = (...args: string[]) => [APP_DIR, `--user-data-dir=${userDataDir}`, ...args];

test.beforeEach(async () => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  app = await _electron.launch({ executablePath: ELECTRON, args: appArgs() });
  output = "";
  app.process().stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  app.process().stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
});

test.afterEach(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

test("the desktop window opens on the desktop entry, themed after the system", async () => {
  const page = await app.firstWindow();

  await expect(page.locator("html")).toHaveAttribute("data-ging-entry", "ging-desktop-entry");
  expect(
    await page.evaluate(() => typeof (globalThis as Record<string, unknown>).acquireVsCodeApi)
  ).toBe("function");

  const editorBackground = () =>
    page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--vscode-editor-background")
    );
  const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  expect(await editorBackground()).toBe(dark ? "#1f1f1f" : "#ffffff");
  await expect(page.locator("body")).toContainClass(dark ? "vscode-dark" : "vscode-light");

  // The system switching theme, as far as the app can tell.
  await app.evaluate(({ nativeTheme }, toDark) => {
    nativeTheme.themeSource = toDark ? "dark" : "light";
  }, !dark);
  await expect.poll(editorBackground).toBe(dark ? "#ffffff" : "#1f1f1f");
  await expect(page.locator("body")).toContainClass(dark ? "vscode-light" : "vscode-dark");
  await expect(page.locator("body")).not.toContainClass(dark ? "vscode-dark" : "vscode-light");
});

test("a second launch hands its repository to the first and exits", async () => {
  await app.firstWindow();
  const repo = path.join(userDataDir, "repo");

  // Playwright adds --no-sandbox to the launch it makes on Linux; this one
  // needs it the same way (ADR-0032).
  const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
  // A relative path, from the second launch's own working directory. The
  // unknown switch has to come back as ignored, not vanish: Electron's own
  // forwarded command line moves it out of place (LaunchCommandLine).
  const second = spawn(ELECTRON, [...sandbox, ...appArgs("--repo", "repo", "--frobnicate")], {
    cwd: userDataDir,
    stdio: "ignore"
  });
  const exitCode = await new Promise((resolve) => second.on("exit", resolve));

  expect(exitCode).toBe(0);
  await expect.poll(() => output).toContain(`launch: repository ${repo}`);
  await expect.poll(() => output).toMatch(/launch: ignored arguments .*"--frobnicate"/);
  expect(app.windows()).toHaveLength(1);
});
