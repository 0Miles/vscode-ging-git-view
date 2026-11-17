import { defineConfig } from "@playwright/test";

// Electron E2E (ADR-0032): the unpackaged build in out/, so `compile` first.
export default defineConfig({
  testDir: "e2e",
  // Each test starts its own app; two at once would only compete for the CPU.
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  // Not under out/: `compile` empties out/ first, and with it the results of
  // the run that failed (#404).
  outputDir: "e2e-results",
  // What a failure leaves to look at: every step's page, and the main
  // process's calls. Kept only for a test that failed.
  use: { trace: "retain-on-failure" }
});
