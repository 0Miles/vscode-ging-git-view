import { defineConfig } from "@playwright/test";

// Electron E2E (ADR-0032): the unpackaged build in out/, so `compile` first.
export default defineConfig({
  testDir: "e2e",
  // Each test starts its own app; two at once would only compete for the CPU.
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  outputDir: "out/e2e-results"
});
