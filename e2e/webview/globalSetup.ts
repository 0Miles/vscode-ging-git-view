import { buildHarness, ENTRIES } from "./harness";

/**
 * Every spec's pages, built once before any spec runs: the specs only load
 * them, so they can run side by side without one rewriting a page another is
 * loading. The VS Code entry's page needs `pnpm run compile` first.
 */
export default function globalSetup(): void {
  for (const entry of ENTRIES) buildHarness(entry);
}
