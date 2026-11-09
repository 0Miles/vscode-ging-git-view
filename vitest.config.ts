import path from "node:path";

import { defineConfig } from "vitest/config";

// Package imports resolve through the packages' own `exports`; the one alias is
// the extension's name for its own modules (see apps/vscode/tsconfig.json).
const appAlias = {
  find: /^@ging\/vscode\//,
  replacement: path.resolve(__dirname, "apps/vscode/src") + "/"
};

// Two projects by environment, each collecting its suites from across the
// workspace. The webview suites still live in apps/vscode: their fixture renders
// the host's markup with the host's strings, and `getWebviewLocalizedStrings`
// reads `vscode.l10n` until #294 moves it into @ging/webview.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: [appAlias] },
        test: {
          name: "backend",
          include: [
            "packages/core/tests/**/*.test.ts",
            // the stylesheet locks: node, because jsdom gives `import.meta.url` no file to resolve
            "packages/webview/tests/**/*.test.ts",
            "apps/vscode/tests/backend/**/*.test.ts"
          ],
          setupFiles: ["packages/core/tests/setup.ts"],
          // These suites drive real git child processes, many of them in
          // parallel. The 5s/10s defaults are comfortably exceeded on a loaded
          // machine (Windows especially, where process spawn and on-access virus
          // scanning are slower), so give them room rather than flaking.
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      },
      {
        resolve: {
          alias: [
            appAlias,
            {
              find: "vscode",
              replacement: path.resolve(__dirname, "apps/vscode/tests/webview/__mocks__/vscode.ts")
            }
          ]
        },
        test: {
          name: "webview",
          environment: "jsdom",
          include: ["apps/vscode/tests/webview/**/*.test.ts"],
          setupFiles: ["apps/vscode/tests/webview/setup.ts"]
        }
      }
    ]
  }
});
