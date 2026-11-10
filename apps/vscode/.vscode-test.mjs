import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  // tests/extension/tsconfig.json compiles from the repo root, so the emitted
  // tree mirrors the workspace under tests/out/extension.
  files: "tests/out/extension/apps/vscode/tests/extension/**/*.test.js",
  // The integration tests open the repo root as their workspace.
  workspaceFolder: "../..",
  version: "stable"
});
