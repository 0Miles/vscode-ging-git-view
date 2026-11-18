import { buildDesktopPage, buildHarness, DESKTOP_PAGES, ENTRIES } from "./harness";

/**
 * Every spec's pages, built once before any spec runs: the specs only load
 * them, so they can run side by side without one rewriting a page another is
 * loading. Each page is built into a folder of its own, so they are built side
 * by side too. The VS Code entry's page needs `pnpm run compile` first.
 */
export default async function globalSetup(): Promise<void> {
  await Promise.all([...ENTRIES.map(buildHarness), ...DESKTOP_PAGES.map(buildDesktopPage)]);
}
