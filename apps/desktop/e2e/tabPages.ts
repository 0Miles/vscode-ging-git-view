import { type ElectronApplication, expect, type Page } from "@playwright/test";

/**
 * The pages of the desktop window (#393), as Playwright sees them: every
 * `webContents` is a page of the app's, the window's own — the tab strip and
 * the Welcome page — and each Tab's view's. They are told apart by URL, which
 * is the product's own: `ging://app/` for the window's, `ging://app/tab?id=N`
 * for Tab N's (ADR-0032: E2E reads only what the product has).
 */

/** The app's path a page's URL names — `/`, `/tab`, `/settings` — and the
 *  Tab id it carries, if any. */
function addressOf(url: string): { path: string; tab: number | null } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "ging:") return null;
  const id = parsed.searchParams.get("id");
  return { path: parsed.pathname, tab: id === null ? null : Number(id) };
}

/** The first page whose address `matches`, once there is one: pages appear
 *  in no particular order, so the first window may be any of them. */
async function pageAt(
  app: ElectronApplication,
  matches: (address: { path: string; tab: number | null }) => boolean
): Promise<Page> {
  const find = () =>
    app.windows().find((page) => {
      const address = addressOf(page.url());
      return address !== null && matches(address);
    });
  await expect.poll(() => find() !== undefined).toBe(true);
  return find()!;
}

/** The window's own page: the tab strip over the Welcome page. */
export async function windowPage(app: ElectronApplication): Promise<Page> {
  const page = await pageAt(app, ({ path }) => path === "/");
  await expect(page.locator("html")).toHaveAttribute("data-ging-page", "window");
  return page;
}

/** The page of Tab `id`, once its view has it. */
export function tabPage(app: ElectronApplication, id: number): Promise<Page> {
  return pageAt(app, ({ path, tab }) => path === "/tab" && tab === id);
}

/** The strip's entries: each Tab's id and title, and which one is focused. */
export async function stripTabs(
  window: Page
): Promise<{ id: number; title: string; focused: boolean }[]> {
  return window.locator("#tabStrip .tab").evaluateAll((tabs) =>
    tabs.map((tab) => ({
      id: Number((tab as HTMLElement).dataset.tabId),
      title: tab.querySelector(".tabTitle")?.textContent ?? "",
      focused: tab.classList.contains("focused")
    }))
  );
}

/** The focused Tab's page, once the strip shows `count` Tabs. */
export async function focusedTabPage(app: ElectronApplication, count = 1): Promise<Page> {
  const window = await windowPage(app);
  await expect(window.locator("#tabStrip .tab")).toHaveCount(count);
  const id = Number(await window.locator("#tabStrip .tab.focused").getAttribute("data-tab-id"));
  return tabPage(app, id);
}
