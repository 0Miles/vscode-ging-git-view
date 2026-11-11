import { describe, expect, it } from "vitest";

import { quickPickItems } from "@ging/vscode/extension/quickPickItems";

// The rows `Prompts.pick` and `pickMany` hand VS Code's QuickPick.

describe("quickPickItems", () => {
  it("leads a warning row's label with the warning icon", () => {
    expect(quickPickItems([{ label: "3333333  WIP", warning: true, value: 3 }])).toEqual([
      { label: "$(warning) 3333333  WIP", warning: true, value: 3 }
    ]);
  });

  it("leaves every other row as it is", () => {
    const rows = [
      { label: "1111111  commit: Fix", description: "HEAD@{0}", warning: false, value: 1 },
      { label: "origin", value: 2 }
    ];
    expect(quickPickItems(rows)).toEqual(rows);
  });

  it("keeps what a pickMany row starts checked with, and the value it answers", () => {
    const [row] = quickPickItems([{ label: "fork", picked: true, warning: true, value: "fork" }]);
    expect(row).toEqual({ label: "$(warning) fork", picked: true, warning: true, value: "fork" });
  });
});
