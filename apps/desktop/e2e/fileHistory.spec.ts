import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { diffShown, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { datedGit, isolatedGitEnv } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { answerFolderDialog, clickMenu, folderDialogs } from "./mainProcess";
import { focusedTabPage } from "./tabPages";

// A file's history (#408), with real git behind it: opened from the
// application menu's File History… — the file picked in the system's dialog,
// which the test answers (ADR-0032) — and from a Commit Details View file's
// context menu, as a user opens them. Its entries name the path the file had
// at each commit, and an entry from before a rename opens the old path's diff
// in the diff viewer (#404), beside the list. Read through the page, the
// menu and the app's log.

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: string;

/** The repository's commits, newest first, by subject. */
const SUBJECTS = ["change new", "rename to new", "change old", "add old"];

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  // Spelled the long way: os.tmpdir() can be an 8.3 name on Windows.
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ging-e2e-repo-")));
  const git = datedGit(repo, env, 1_700_000_000);
  git("init", "--template=", "-b", "main");
  git("config", "core.autocrlf", "false");
  const write = (file: string, text: string) => writeFileSync(path.join(repo, file), text);
  write("old.txt", "first\n");
  git("add", "old.txt");
  git("commit", "-m", "add old");
  write("old.txt", "first\nsecond\n");
  git("commit", "-am", "change old");
  git("mv", "old.txt", "new.txt");
  git("commit", "-m", "rename to new");
  write("new.txt", "first\nsecond\nthird\n");
  git("commit", "-am", "change new");
});

test.afterEach(async () => {
  if (app !== null) await keepTraceIfFailed(app, test.info());
  await app?.close();
  app = null;
  for (const dir of [scratch, repo]) rmSync(dir, { recursive: true, force: true });
});

const userData = () => path.join(scratch, "userData");
const log = () => readFileSync(path.join(userData(), "logs", "main.log"), "utf8");

async function launch(): Promise<ElectronApplication> {
  mkdirSync(userData(), { recursive: true });
  app = await launchApp(
    ["--lang=en-US", APP_DIR, `--user-data-dir=${userData()}`, "--repo", repo],
    env
  );
  await startTrace(app);
  return app;
}

/** Every error the page reports on its console, and every uncaught one. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  return errors;
}

const panel = (page: Page) => page.locator("#fileHistory");
const entries = (page: Page) => panel(page).locator(".fhEntry");
const entry = (page: Page, subject: string) =>
  entries(page).filter({ has: page.locator(".fhSubject", { hasText: subject }) });

/** The lines one side of the diff editor shows of its own document. */
const side = (page: Page, which: "original" | "modified") =>
  page.locator(`#diffViewer .monaco-diff-editor .editor.${which} .lines-content > .view-lines`);

test("the menu's File History… lists the picked file's commits across its rename, and opens one from before it as the old path's diff, beside the list", async () => {
  const electronApp = await launch();
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(SUBJECTS.length);

  // The system's dialog, answered: the file, and what it was asked.
  await answerFolderDialog(electronApp, path.join(repo, "new.txt"));
  expect(await clickMenu(electronApp, "ging.fileHistory")).toBe(true);

  await expect(panel(page)).toBeVisible();
  expect(await folderDialogs(electronApp)).toEqual([
    {
      title: "File History",
      buttonLabel: "Show History",
      defaultPath: path.normalize(repo),
      properties: ["openFile"]
    }
  ]);
  await expect(panel(page).locator(".fhTitle")).toHaveText("History of new.txt");
  await expect(entries(page).locator(".fhSubject")).toHaveText(SUBJECTS);
  // The path the file had at each commit.
  await expect(entry(page, "rename to new").locator(".fhNote")).toHaveText("Renamed from old.txt");
  await expect(entry(page, "change old").locator(".fhNote")).toHaveText("As old.txt");
  await expect(entry(page, "add old").locator(".fhNote")).toHaveText("Added · As old.txt");

  // From before the rename: the old path, at that commit and its parent.
  await entry(page, "change old").click();
  await diffShown(page);
  const changed = (await entry(page, "change old").getAttribute("data-hash"))!.slice(0, 8);
  await expect(page.locator("#diffViewer .diffViewerTitle")).toHaveText(
    `old.txt (${changed}^ ↔ ${changed})`
  );
  await expect(side(page, "original")).toHaveText("first");
  await expect(side(page, "modified")).toContainText("second");

  // Side by side: the side views, then the list, then the diff to the right.
  const sideViews = (await page.locator("#sideViews").boundingBox())!;
  const list = (await panel(page).boundingBox())!;
  const diff = (await page.locator("#diffViewer").boundingBox())!;
  expect(Math.round(list.x)).toBe(Math.round(sideViews.x + sideViews.width));
  expect(Math.round(diff.x)).toBe(Math.round(list.x + list.width));
  await expect(entry(page, "change old")).toHaveAttribute("aria-selected", "true");

  expect(errors).toEqual([]);
  expect(log()).not.toContain("ERROR:");
});

test("a Commit Details View file's context menu opens its history up to that commit", async () => {
  const electronApp = await launch();
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);

  // The rename's details, then its one file's menu.
  await page.locator("#commitTable tr.commit", { hasText: "rename to new" }).click();
  await page.locator(".gitFile", { hasText: "new.txt" }).click({ button: "right" });
  await page.locator("#contextMenu .contextMenuItem", { hasText: "View File History" }).click();

  await expect(panel(page)).toBeVisible();
  await expect(entries(page).locator(".fhSubject")).toHaveText(SUBJECTS.slice(1));
  const rename = (await entry(page, "rename to new").getAttribute("data-hash"))!;
  await expect(panel(page).locator(".fhPath")).toHaveText(`new.txt · up to ${rename.slice(0, 7)}`);
  // The keyboard on the newest entry; Escape gives the page back.
  await expect(entries(page).first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(SUBJECTS.length);

  expect(errors).toEqual([]);
  expect(log()).not.toContain("ERROR:");
});
