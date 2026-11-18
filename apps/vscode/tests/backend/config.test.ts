import { describe, expect, it, vi } from "vitest";

import { config } from "@ging/vscode/config";

// `HostConfig.update` in VS Code (#397): the user's (Global) settings, through
// the configuration that is not scoped to a section or a folder, so the key is
// written as the caller spells it.

const vscodeMock = vi.hoisted(() => ({
  sections: [] as unknown[][],
  updates: [] as unknown[][]
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: (...args: unknown[]) => {
      vscodeMock.sections.push(args);
      return {
        update: async (...updateArgs: unknown[]) => {
          vscodeMock.updates.push(updateArgs);
        }
      };
    }
  }
}));

describe("VS Code's config.update", () => {
  it("writes the key as given to the Global settings", async () => {
    await config.update("ging-git-view.autoFetch.intervalMinutes", 5);

    expect(vscodeMock.sections).toEqual([[]]);
    expect(vscodeMock.updates).toEqual([["ging-git-view.autoFetch.intervalMinutes", 5, 1]]);
  });
});
