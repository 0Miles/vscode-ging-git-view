import path from "node:path";

import { defineConfig } from "vitest/config";

const alias = [
  { find: /^@\//, replacement: path.resolve(__dirname, "src") + "/" },
  { find: /^@tests\//, replacement: path.resolve(__dirname, "tests") + "/" }
];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "backend",
          include: ["tests/backend/**/*.test.ts"],
          setupFiles: ["tests/backend/setup.ts"],
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
            ...alias,
            {
              find: "vscode",
              replacement: path.resolve(__dirname, "tests/webview/__mocks__/vscode.ts")
            }
          ]
        },
        test: {
          name: "webview",
          environment: "jsdom",
          include: ["tests/webview/**/*.test.ts"],
          setupFiles: ["tests/webview/setup.ts"]
        }
      }
    ]
  }
});
