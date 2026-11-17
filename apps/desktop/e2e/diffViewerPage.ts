import { type ElectronApplication, expect, type Page, type TestInfo } from "@playwright/test";

/**
 * How long a page's first diff may take to be shown. It loads the editors'
 * bundle (Monaco, about 3.4 MB minified, #404), and parsing it blocks the
 * page — every read of the page by the test included — for seconds on a
 * loaded machine: with the renderer's CPU throttled 6×, the default 5 s ran
 * out before the walk could read the diff's answer (#404's status record).
 * Later diffs on the page reuse the bundle, and take no budget of their own.
 */
export const FIRST_DIFF_BUDGET = 30_000;

/** The diff viewer shown, with its editor in it — or the one line it shows in
 *  place of one — once it is no longer busy making it (`aria-busy`). */
export async function diffShown(page: Page, timeout = FIRST_DIFF_BUDGET): Promise<void> {
  const viewer = page.locator("#diffViewer");
  await expect(viewer).toBeVisible({ timeout });
  await expect(viewer).not.toHaveAttribute("aria-busy", "true", { timeout });
}

/** Record what the app's pages do, for a test that fails to leave behind:
 *  Playwright's own `trace` option covers only the pages its fixtures open,
 *  and these tests launch the app themselves. */
export async function startTrace(app: ElectronApplication): Promise<void> {
  await app.context().tracing.start({ screenshots: true, snapshots: true });
}

/** Stop recording; keep the trace in the test's output folder if it failed. */
export async function keepTraceIfFailed(app: ElectronApplication, info: TestInfo): Promise<void> {
  const failed = info.status !== info.expectedStatus;
  await app
    .context()
    .tracing.stop(failed ? { path: info.outputPath("trace.zip") } : {})
    .catch(() => {});
}
