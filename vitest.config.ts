import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

// Package imports resolve through the packages' own `exports`; the one alias is
// the extension's name for its own modules (see apps/vscode/tsconfig.json).
const appAlias = {
  find: /^@ging\/vscode\//,
  replacement: path.resolve(__dirname, "apps/vscode/src") + "/"
};

// The webview package's stylesheet locks read main.css off disk, which needs node:
// jsdom gives `import.meta.url` no file to resolve. The one line between its two
// projects, named once: the backend project takes these, the webview project
// everything else in the package's tests.
const WEBVIEW_STYLE_LOCKS = "packages/webview/tests/styles/**/*.test.ts";

// Two projects by environment, each collecting its suites from across the
// workspace. Nothing in the webview suites imports `vscode` (the host's strings
// reach them as the base bundle, see packages/webview/tests/setup.ts), so
// neither project aliases it; the few host suites that load a module importing
// it `vi.mock` it themselves.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: [appAlias] },
        test: {
          name: "backend",
          include: [
            "packages/core/tests/**/*.test.ts",
            WEBVIEW_STYLE_LOCKS,
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
        test: {
          name: "webview",
          environment: "jsdom",
          include: ["packages/webview/tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, WEBVIEW_STYLE_LOCKS],
          setupFiles: ["packages/webview/tests/setup.ts"]
        }
      }
    ]
  }
});
