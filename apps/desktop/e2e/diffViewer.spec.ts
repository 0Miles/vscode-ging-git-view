import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { diffShown, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The diff viewer (#404): a file's diff, opened from the Commit Details View
// as a user opens it, drawn by Monaco over the Tab's graph. What only the
// real app can show: Monaco's own bundle, worker and font loading from the
// app under the page's content security policy, with nothing from anywhere
// else; both sides read by the main process per `defaultFileEncoding`. Read
// through the page and the app's log (ADR-0032).

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  cleanUp = [];
});

test.afterEach(async () => {
  if (app !== null) await keepTraceIfFailed(app, test.info());
  await app?.close();
  app = null;
  for (const dir of [scratch, ...cleanUp]) rmSync(dir, { recursive: true, force: true });
});

const userData = () => path.join(scratch, "userData");
const log = () => readFileSync(path.join(userData(), "logs", "main.log"), "utf8");

/** Start the app on `repo`, with `settings` in its settings file. */
async function launch(repo: string, settings: Record<string, unknown> = {}) {
  mkdirSync(userData(), { recursive: true });
  writeFileSync(path.join(userData(), "settings.json"), JSON.stringify(settings));
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: ["--lang=en-US", APP_DIR, `--user-data-dir=${userData()}`, "--repo", repo],
    env: env as Record<string, string>
  });
  await startTrace(app);
  return app;
}

/** Every error the page reports on its console — a load the content
 *  security policy refused among them — and every uncaught one. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // With its stack: Monaco's own failures say little by their message alone.
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  return errors;
}

/** The lines one side of the diff editor shows of its own document; not the
 *  other side's that inline puts among them. */
const side = (page: Page, which: "original" | "modified") =>
  page.locator(`#diffViewer .monaco-diff-editor .editor.${which} .lines-content > .view-lines`);

test("a file clicked in the Commit Details View opens its diff over the graph, side by side or inline", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const electronApp = await launch(fixture.path);
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);

  // As a user gets there: the newest commit's details, then its one file.
  await page.locator("#commitTable tr.commit").first().click();
  const changed = page.locator(".gitFile", { hasText: "file.txt" });
  await changed.click();

  // The page's first diff: it loads the editor first.
  await diffShown(page);
  const viewer = page.locator("#diffViewer");
  const third = fixture.commits[0].hash.slice(0, 8);
  await expect(viewer.locator(".diffViewerTitle")).toHaveText(`file.txt (${third}^ ↔ ${third})`);
  // The commit's parent on the left, the commit on the right.
  await expect(side(page, "original")).toContainText("Second commit");
  await expect(side(page, "modified")).toContainText("Third commit");
  // Marked as changed: Monaco's worker, the app's own file, computed the diff
  // — in a worker, not in the page as Monaco falls back to when it has none.
  await expect(page.locator("#diffViewer .monaco-diff-editor .line-insert").first()).toBeAttached();
  expect(page.workers().map((worker) => worker.url())).toEqual(["ging://app/editor.worker.js"]);
  // Its font, the app's own file too.
  expect(
    await page.evaluate(async () => {
      await document.fonts.load("16px codicon");
      return [...document.fonts].some((f) => f.family.includes("codicon") && f.status === "loaded");
    })
  ).toBe(true);
  // Over the graph's area, the graph left where it was beneath it.
  // All of it, scroll bar aside, and no more: the side views' column (#399)
  // stays in view on its left; the working tree's (#403) is closed.
  const area = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  }));
  const sideViews = (await page.locator("#sideViews").boundingBox())!;
  const box = (await viewer.boundingBox())!;
  expect({
    left: Math.round(box.x),
    top: Math.round(box.y),
    right: Math.round(box.x + box.width),
    bottom: Math.round(box.y + box.height)
  }).toEqual({
    left: Math.round(sideViews.x + sideViews.width),
    top: 0,
    right: area.width,
    bottom: area.height
  });
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(fixture.commits.length);

  // One column: the removed line drawn in the right-hand editor, above the
  // line that replaces it.
  const diffEditor = page.locator("#diffViewer .monaco-diff-editor");
  const removedInline = diffEditor.locator(".editor.modified .view-zones");
  await expect(diffEditor).toHaveClass(/\bside-by-side\b/);
  await expect(removedInline).not.toContainText("Second commit");
  await viewer.getByRole("button", { name: "Inline" }).click();
  await expect(viewer.getByRole("button", { name: "Inline" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(diffEditor).not.toHaveClass(/\bside-by-side\b/);
  await expect(removedInline).toContainText("Second commit");
  await expect(side(page, "modified")).toContainText("Third commit");
  await viewer.getByRole("button", { name: "Side by Side" }).click();
  await expect(diffEditor).toHaveClass(/\bside-by-side\b/);
  await expect(removedInline).not.toContainText("Second commit");

  // Escape closes it; the Commit Details View it was opened from is still
  // open, and the keyboard back on the file.
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(changed).toBeVisible();
  await expect(changed).toBeFocused();

  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});

test("a binary file's diff says there is no text to compare, and draws no editor", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  writeFileSync(path.join(fixture.path, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  git("add", "image.png");
  git("commit", "--quiet", "-m", "Binary file");
  const commit = git("rev-parse", "HEAD");

  const electronApp = await launch(fixture.path);
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);
  await expect(page.locator("#commitTable tr.commit").first()).toBeVisible();
  // Sent as the page sends it: git lists no line counts for a binary file, so
  // its Commit Details View row offers no diff to click, but nothing stops a
  // request naming one — a file's history (#408) will not know in advance.
  await page.evaluate(
    (hash) =>
      (globalThis as unknown as { acquireVsCodeApi(): { postMessage(m: unknown): void } })
        .acquireVsCodeApi()
        .postMessage({
          command: "viewDiff",
          repo: (globalThis as { viewState?: { lastActiveRepo: string } }).viewState!
            .lastActiveRepo,
          commitHash: hash,
          oldFilePath: "image.png",
          newFilePath: "image.png",
          type: "A"
        }),
    commit
  );

  await diffShown(page);
  const viewer = page.locator("#diffViewer");
  await expect(viewer.locator(".diffViewerNotice")).toHaveText(
    "Binary file: there is no text to compare."
  );
  await expect(viewer.locator(".monaco-diff-editor")).toHaveCount(0);

  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});

test("a file at a commit against the working tree is decoded as the setting says, on both sides", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  // "café\n" in windows-1252, committed; then "cafés\n" in the working tree.
  // Its é is the one byte 0xE9, which utf8 would show as a replacement mark.
  const legacy = path.join(fixture.path, "legacy.txt");
  writeFileSync(legacy, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  git("add", "legacy.txt");
  git("commit", "--quiet", "-m", "Legacy file");
  writeFileSync(legacy, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x73, 0x0a]));

  const electronApp = await launch(fixture.path, {
    "ging-git-view.defaultFileEncoding": "win1252"
  });
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);
  // The working tree panel open, as the graph's Open Source Control View
  // opens it.
  await expect(page.locator("#commitTable tr.commit").first()).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { acquireVsCodeApi(): { postMessage(m: unknown): void } })
      .acquireVsCodeApi()
      .postMessage({ command: "openScmView" })
  );

  // The commit's file, against the working tree: its row's own button. The
  // uncommitted changes' row comes first, so the commit is found by subject.
  await page.locator("#commitTable tr.commit", { hasText: "Legacy file" }).click();
  const row = page.locator(".gitFile", { hasText: "legacy.txt" });
  await row.hover();
  await row.locator(".gitFileDiffWorking").click();

  await diffShown(page);
  const viewer = page.locator("#diffViewer");
  // Over the graph's area only: the working tree panel (#403), open beside
  // the graph, stays in view beside the diff.
  const panel = page.locator("#workingTree");
  await expect(panel).toBeVisible();
  const [viewerBox, panelBox] = [(await viewer.boundingBox())!, (await panel.boundingBox())!];
  expect(Math.round(viewerBox.x + viewerBox.width)).toBe(Math.round(panelBox.x));
  await expect(viewer.locator(".diffViewerTitle")).toContainText("legacy.txt (");
  await expect(viewer.locator(".diffViewerTitle")).toContainText("Working Tree)");
  await expect(side(page, "original")).toContainText("café");
  await expect(side(page, "modified")).toContainText("cafés");

  await viewer.getByRole("button", { name: "Close Diff" }).click();
  await expect(viewer).toBeHidden();
  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});
