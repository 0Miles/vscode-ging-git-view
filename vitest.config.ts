import path from "node:path";

import { defineConfig } from "vitest/config";

// Package imports resolve through the packages' own `exports`; the aliases are
// the apps' names for their own modules (see apps/*/tsconfig.json).
const appAliases = ["vscode", "desktop"].map((app) => ({
  find: new RegExp(`^@ging/${app}/`),
  replacement: path.resolve(__dirname, `apps/${app}/src`) + "/"
}));

// Two projects by environment, each collecting its suites from across the
// workspace. Nothing in the webview suites imports `vscode` (the host's strings
// reach them as the base bundle, see packages/webview/tests/setup.ts), so
// neither project aliases it; the few host suites that load a module importing
// it `vi.mock` it themselves.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: appAliases },
        test: {
          name: "backend",
          include: [
            "packages/core/tests/**/*.test.ts",
            "apps/vscode/tests/backend/**/*.test.ts",
            "apps/desktop/tests/**/*.test.ts"
          ],
          // The desktop suites that need a page run in the jsdom project.
          exclude: ["apps/desktop/tests/dom/**"],
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
        resolve: { alias: appAliases },
        test: {
          name: "webview",
          environment: "jsdom",
          include: ["packages/webview/tests/**/*.test.ts", "apps/desktop/tests/dom/**/*.test.ts"],
          setupFiles: ["packages/webview/tests/setup.ts"]
        }
      }
    ]
  }
});
