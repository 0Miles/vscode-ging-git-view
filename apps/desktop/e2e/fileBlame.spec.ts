import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";

import { diffShown, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { datedGit, isolatedGitEnv } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { answerFolderDialog, clickMenu, folderDialogs } from "./mainProcess";
import { focusedTabPage } from "./tabPages";

// A file's blame (#409), with real git behind it: shown beside the file a
// Commit Details View opens read-only (#405) once its Blame toggle is
// pressed, and beside the working tree's copy the application menu's Blame
// File… opens — the file picked in the system's dialog, which the test
// answers (ADR-0032). What only the real app shows: Monaco drawing each
// line's annotation, its hover in Markdown with the links that run through
// the main process, and a click that takes the graph to the commit. Read
// through the page, the menu and the app's log.

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: string;

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  // Spelled the long way: os.tmpdir() can be an 8.3 name on Windows.
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ging-e2e-repo-")));
  const git = datedGit(repo, env, 1_700_000_000);
  git("init", "--template=", "-b", "main");
  git("config", "core.autocrlf", "false");
  // Alice adds the notes; Bob rewrites their second line.
  writeFileSync(path.join(repo, "notes.txt"), "first\nsecond\n");
  git("add", "notes.txt");
  git("commit", "-m", "add notes\n\nWith a body only the hover shows.");
  writeFileSync(path.join(repo, "notes.txt"), "first\nSECOND\n");
  git("commit", "-am", "shout second", "--author=Bob <bob@example.com>");
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

const viewer = (page: Page) => page.locator("#diffViewer");
const commitRow = (page: Page, subject: string) =>
  page.locator("#commitTable tr.commit", { hasText: subject });
/** The annotation Monaco draws before the line reading `text`. Monaco draws
 *  a line's spaces as no-break spaces, which `\s` takes. */
const annotation = (page: Page, text: string): Locator =>
  viewer(page)
    .locator(".view-line", { hasText: new RegExp(`${text.replace(/ /g, "\\s")}$`) })
    .locator(".gingBlameAnnotation");
/** What an annotation says, as Monaco draws its spaces. */
const said = (locator: Locator) =>
  locator.evaluate((el) => (el.textContent ?? "").replace(/ /g, " ").trim());

/** The file as the commit `subject` has it, opened as a user opens it: the
 *  commit's details, then its file row's View File at this Revision. */
async function viewFileAt(page: Page, subject: string): Promise<void> {
  await commitRow(page, subject).click();
  const row = page.locator(".gitFile", { hasText: "notes.txt" });
  await row.hover();
  await row.locator(".gitFileViewRev").click();
  await diffShown(page);
}

test("a file viewed at a revision shows its blame once Blame is pressed, each line's hover with links that open its change and find its commit in the graph", async () => {
  const electronApp = await launch();
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);

  await viewFileAt(page, "shout second");
  const toggle = viewer(page).getByRole("button", { name: "Blame", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(viewer(page).locator(".gingBlameAnnotation")).toHaveCount(0);

  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => said(annotation(page, "first"))).toMatch(/^Alice, .+ • add notes$/);
  await expect.poll(() => said(annotation(page, "SECOND"))).toMatch(/^Bob, .+ • shout second$/);
  // Beside the lines, not in them: the file's text is as the commit has it.
  await expect(viewer(page).locator(".view-lines")).toContainText("first");

  // The hover: what the inline blame's says, written in full by the host —
  // the commit's whole message and its hunk — with its links. (That it waits
  // for the host's Markdown, and shows none short of it, is vitest's:
  // blameHoverRule.test.ts.)
  await annotation(page, "first").hover();
  const hover = page.locator(".monaco-hover").filter({ hasText: "add notes" });
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("With a body only the hover shows.");
  await annotation(page, "SECOND").hover();
  const bobs = page.locator(".monaco-hover").filter({ hasText: "shout second" });
  await expect(bobs).toContainText("+SECOND");
  await expect(bobs).toContainText("Locate in the GING graph");

  // Its change, at the line, in the same panel: the file gives way to the diff.
  await bobs.getByRole("link", { name: "Open this line's change" }).click();
  await expect(viewer(page).locator(".monaco-diff-editor")).toHaveCount(1);
  await expect(viewer(page).locator(".diffViewerTitle")).toContainText("↔");

  // Opened again, the toggle is as it was left: blamed at once. The
  // keyboard's way: Show Hover (Ctrl+K Ctrl+I) on the cursor's line shows
  // its blame in full, and the context menu's Find Commit in Graph (Shift+F10)
  // takes the graph to its commit, the viewer closed over it.
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await reopen(page);
  await expect.poll(() => said(annotation(page, "SECOND"))).toMatch(/^Bob, /);
  await viewer(page)
    .locator(".view-line", { hasText: /SECOND$/ })
    .locator("span", { hasText: "SECOND" })
    .last()
    .click();
  await viewer(page).locator(".diffViewerTitle").hover();
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Control+I");
  await expect(page.locator(".monaco-hover").filter({ hasText: "shout second" })).toContainText(
    "+SECOND"
  );
  await page.keyboard.press("Shift+F10");
  const find = page.getByRole("menuitem", { name: "Find Commit in Graph" });
  await expect(find).toBeVisible();
  // Chosen from the keyboard: it is the menu's first item (as #406's Stage Hunk).
  await page.keyboard.press("ArrowDown");
  await expect(find).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeHidden();
  await expect.poll(() => isLocated(commitRow(page, "shout second"))).toBe(true);

  // And a click on an annotation does the same for its line's commit.
  await reopen(page);
  await expect.poll(() => said(annotation(page, "first"))).toMatch(/^Alice, /);
  await annotation(page, "first").click();

  await expect(viewer(page)).toBeHidden();
  await expect.poll(() => isLocated(commitRow(page, "add notes"))).toBe(true);

  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});

const row = (page: Page) => page.locator(".gitFile", { hasText: "notes.txt" });

/** The file opened again from the open Commit Details View. */
async function reopen(page: Page): Promise<void> {
  await row(page).hover();
  await row(page).locator(".gitFileViewRev").click();
  await diffShown(page);
}

/** Whether the graph went to `commit`: its details opened, or the keyboard on it. */
const isLocated = (commit: Locator) =>
  commit.evaluate(
    (el) => el.classList.contains("commitDetailsOpen") || el === document.activeElement
  );

test("the menu's Blame File… shows the working tree's copy of the picked file blamed, its lines not committed said so", async () => {
  writeFileSync(path.join(repo, "notes.txt"), "first\nSECOND\nnot committed\n");
  const electronApp = await launch();
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);
  await expect(commitRow(page, "shout second")).toBeVisible();

  // The system's dialog, answered: the file, and what it was asked.
  await answerFolderDialog(electronApp, path.join(repo, "notes.txt"));
  expect(await clickMenu(electronApp, "ging.blameFile")).toBe(true);

  await diffShown(page);
  await expect(viewer(page).locator(".diffViewerTitle")).toHaveText("notes.txt (Working Tree)");
  await expect
    .poll(() => said(annotation(page, "not committed")))
    .toBe("You • Uncommitted changes");
  await expect.poll(() => said(annotation(page, "SECOND"))).toMatch(/^Bob, .+ • shout second$/);
  expect(await folderDialogs(electronApp)).toEqual([
    expect.objectContaining({ title: "Blame File", buttonLabel: "Blame", properties: ["openFile"] })
  ]);

  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});
