import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { diffShown, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { focusedTabPage } from "./tabPages";

// A file at a revision, read-only (#405): opened from the Commit Details View
// as a user opens it, drawn by Monaco in the diff viewer's panel over the
// Tab's graph. What only the real app can show: the file read by the main
// process at the commit, per `defaultFileEncoding`; one editor, coloured by
// the file's type, that takes no typing. Read through the page and the app's
// log (ADR-0032).

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

/** Every error the page reports on its console, and every uncaught one. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  return errors;
}

test("a file viewed at a revision opens read-only over the graph, coloured by its type and decoded as the setting says", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  // "// café" in windows-1252, committed: its é is the one byte 0xE9, which
  // utf8 would show as a replacement mark. Then changed in the working tree,
  // which is not what is shown.
  mkdirSync(path.join(fixture.path, "src"));
  const file = path.join(fixture.path, "src", "legacy.ts");
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]),
      Buffer.from("const answer = 42;\n")
    ])
  );
  git("add", "src/legacy.ts");
  git("commit", "--quiet", "-m", "Legacy file");
  const commit = git("rev-parse", "HEAD");
  writeFileSync(file, "const answer = 43;\n");

  mkdirSync(userData(), { recursive: true });
  writeFileSync(
    path.join(userData(), "settings.json"),
    JSON.stringify({ "ging-git-view.defaultFileEncoding": "win1252" })
  );
  app = await launchApp(
    ["--lang=en-US", APP_DIR, `--user-data-dir=${userData()}`, "--repo", fixture.path],
    env
  );
  const electronApp = app;
  await startTrace(electronApp);
  const page = await focusedTabPage(electronApp);
  const errors = pageErrors(page);

  // As a user gets there: the commit's details, then its file row's own
  // View File at this Revision button. The uncommitted changes' row comes
  // first, so the commit is found by subject.
  await page.locator("#commitTable tr.commit", { hasText: "Legacy file" }).click();
  const row = page.locator(".gitFile", { hasText: "legacy.ts" });
  await row.hover();
  await row.locator(".gitFileViewRev").click();

  // The page's first editor: it loads the editor's code first.
  await diffShown(page);
  const viewer = page.locator("#diffViewer");
  await expect(viewer.locator(".diffViewerTitle")).toHaveText(`legacy.ts (${commit.slice(0, 8)})`);
  // One editor, not a diff, and no layouts to switch between.
  const editor = viewer.locator(".monaco-editor");
  await expect(editor).toHaveCount(1);
  await expect(viewer.locator(".monaco-diff-editor")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Inline" })).toBeHidden();
  // The commit's text, decoded as the setting says; coloured as TypeScript,
  // as its name says.
  const lines = editor.locator(".view-lines");
  await expect(lines).toContainText("// café");
  await expect(lines).toContainText("const answer = 42;");
  // Coloured: the line's keyword, name and number drawn as tokens of their
  // own (Monaco's `mtk` classes), where plain text would be one token.
  const tokens = () =>
    editor
      .locator(".view-line", { hasText: "const answer = 42;" })
      .locator("span > span")
      .evaluateAll((spans) => [...new Set(spans.map((span) => span.className))]);
  await expect.poll(async () => (await tokens()).length).toBeGreaterThan(1);

  // Read-only: what is typed into it changes nothing.
  await lines.click();
  await page.keyboard.type("typed");
  await page.keyboard.press("Enter");
  await expect(lines).not.toContainText("typed");
  await expect(lines).toContainText("const answer = 42;");

  await viewer.getByRole("button", { name: "Close File" }).click();
  await expect(viewer).toBeHidden();
  // Over the graph, which is where it was.
  await expect(page.locator("#commitTable tr.commit", { hasText: "Legacy file" })).toBeVisible();

  expect(errors).toEqual([]);
  await electronApp.close();
  app = null;
  expect(log()).not.toContain("ERROR:");
});
