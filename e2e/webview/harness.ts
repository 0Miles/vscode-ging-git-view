import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";

export const ROOT = path.resolve(__dirname, "../..");

/** The webview's entries the harness builds a page for (ADR-0031). */
export const ENTRIES = ["vscode", "desktop"] as const;
export type Entry = (typeof ENTRIES)[number];

/** The desktop entry's own pages besides the graph: its settings page (#397)
 *  and the window's page (#393), each in out/webview-harness/desktop-<page>/. */
export const DESKTOP_PAGES = ["settings", "window"] as const;
export type DesktopPage = (typeof DESKTOP_PAGES)[number];

const run = promisify(execFile);

/** Build a harness page through the script's own command line. */
async function runHarness(...args: string[]): Promise<void> {
  await run(process.execPath, [path.join(ROOT, "scripts", "webview-harness.js"), ...args]);
}

/** The file:// URL of the page the global setup built into
 *  out/webview-harness/<dir>/. */
function pageUrl(dir: string): string {
  return pathToFileURL(path.join(ROOT, "out", "webview-harness", dir, "index.html")).href;
}

/** Build the harness page for `entry` into out/webview-harness/<entry>/. */
export function buildHarness(entry: Entry): Promise<void> {
  return runHarness(`--entry=${entry}`);
}

/** The file:// URL of `entry`'s harness page, built by the global setup. */
export function harnessPage(entry: Entry): string {
  return pageUrl(entry);
}

/** Build one of the desktop entry's own pages into
 *  out/webview-harness/desktop-<page>/. */
export function buildDesktopPage(page: DesktopPage): Promise<void> {
  return runHarness("--entry=desktop", `--page=${page}`);
}

/** The file:// URL of one of the desktop entry's own pages, built by the
 *  global setup. */
export function desktopPage(page: DesktopPage): string {
  return pageUrl(`desktop-${page}`);
}

/** What goes wrong on the page from now on, thrown or logged as an error: the
 *  specs hold it to nothing, ever. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/** A message from the host, delivered to the page as the desktop preload
 *  delivers one. */
export async function hostSays(page: Page, data: unknown): Promise<void> {
  await page.evaluate((message) => {
    globalThis.dispatchEvent(new MessageEvent("message", { data: message }));
  }, data);
}

/** What the page posted to its host, in order: all of it, or only what it
 *  posted under `command`. */
export function posted(page: Page, command?: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((wanted) => {
    const { harnessRequests } = globalThis as unknown as {
      harnessRequests: Record<string, unknown>[];
    };
    return wanted === undefined
      ? harnessRequests
      : harnessRequests.filter((m) => m.command === wanted);
  }, command);
}

/** The repository the harness's graph shows. */
export function harnessRepo(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { viewState: { lastActiveRepo: string } }).viewState.lastActiveRepo
  );
}

/** The side views' column's width, as the page's stylesheet declares it. */
export function sideViewWidth(page: Page): Promise<number> {
  return page.evaluate(() =>
    parseFloat(
      globalThis
        .getComputedStyle(globalThis.document.documentElement)
        .getPropertyValue("--ging-side-view-width")
    )
  );
}
