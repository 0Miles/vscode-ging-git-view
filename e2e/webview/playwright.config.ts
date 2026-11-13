import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// The webview E2E: the harness page (scripts/webview-harness.js) in Playwright's
// Chromium, one run per webview entry (ADR-0031). It drives the page alone —
// the host's half is the harness's canned answers, not a real host.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: path.resolve(__dirname, "../../out/webview-e2e"),
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
