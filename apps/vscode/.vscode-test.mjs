import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  // tests/extension/tsconfig.json compiles from the repo root, so the emitted
  // tree mirrors the workspace under tests/out/extension.
  files: "tests/out/extension/apps/vscode/tests/extension/**/*.test.js",
  // The repo root, as before the extension moved into apps/vscode.
  workspaceFolder: "../..",
  version: "stable"
});
