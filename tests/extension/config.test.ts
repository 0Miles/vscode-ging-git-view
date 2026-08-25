import * as assert from "node:assert";

import * as vscode from "vscode";

import { config } from "@/config";

// Guards the settings regroup/rename: every renamed accessor must still return
// its default (never undefined), and each accessor must be wired to the grouped
// key registered in package.json.
suite("config settings", () => {
  const cfg = () => vscode.workspace.getConfiguration("ging-git-view");
  const G = vscode.ConfigurationTarget.Global;
  const touched = ["show.remoteBranches", "graph.edgeStyle"];

  teardown(async () => {
    for (const k of touched) {
      await cfg().update(k, undefined, G); // eslint-disable-line no-await-in-loop
    }
  });

  test("renamed accessors return their defaults (never undefined)", () => {
    assert.strictEqual(config.showRemoteBranches(), true);
    assert.strictEqual(config.showTags(), true);
    assert.strictEqual(config.showUncommittedChanges(), true);
    assert.strictEqual(config.commitOrder(), "date");
    assert.strictEqual(config.graphStyle(), "rounded");
    assert.strictEqual(config.dateType(), "Author Date");
    assert.strictEqual(config.dateFormat(), "Date & Time");
    assert.strictEqual(config.dateCustomFormat(), "DD MMM YYYY");
    assert.strictEqual(config.initialLoadCommits(), 300);
    assert.strictEqual(config.loadMoreCount(), 100);
    assert.deepStrictEqual(config.showSpecificBranches(), []);
  });

  // VS Code answers every registered key with its package.json default, so an
  // accessor's own fallback is unreachable and the two can drift apart unseen.
  // The palette still diverges: `graphColours` falls back to 6 colours while
  // package.json declares 12. Deep-comparing against those declared 12 (and
  // passing) is what proves the declaration is what users get — an assertion
  // that only checked for a non-empty array could never have caught the drift.
  test("the declared default wins over the accessor's own fallback", () => {
    assert.deepStrictEqual(config.graphColours(), [
      "#0085d9",
      "#d9008f",
      "#00d90a",
      "#d98500",
      "#a300d9",
      "#ff0000",
      "#00d9cc",
      "#e138e8",
      "#85d900",
      "#dc5b23",
      "#6f24d6",
      "#ffcc00"
    ]);
  });

  // A fresh install prunes on fetch, so a branch the host deleted on merge stops
  // being drawn on the graph (#34). Pruning tags stays opt-in (ADR-0012).
  test("fetch prunes deleted remote-tracking refs by default, but not tags", () => {
    assert.strictEqual(config.fetchAndPrune(), true);
    assert.strictEqual(config.fetchAndPruneTags(), false);
  });

  test("accessors read the grouped keys registered in package.json", async () => {
    await cfg().update("show.remoteBranches", false, G);
    assert.strictEqual(config.showRemoteBranches(), false);
    await cfg().update("graph.edgeStyle", "angular", G);
    assert.strictEqual(config.graphStyle(), "angular");
  });
});
