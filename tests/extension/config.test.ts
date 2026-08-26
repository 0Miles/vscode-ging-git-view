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
    assert.deepStrictEqual(config.showSpecificBranches(), []);
    // On by default: scrolling to the bottom loads the next page. Flipping a
    // shipped default is exactly what this list exists to make deliberate.
    assert.strictEqual(config.loadMoreAutomatically(), true);
    // `loadMoreCount` was renamed in this same pass, so it belongs in this list
    // too — it is asserted in the test below instead, beside the other instance
    // of the rule it exercises. The assertion is the same either way: pinning it
    // to its declared 100 also proves it is not undefined.
  });

  // VS Code answers every registered key with its package.json default, so an
  // accessor's own fallback is unreachable and the two can drift apart unseen.
  // Both keys below were drifting: `loadMoreCount` declared 100 against a
  // fallback of 75, the palette declares 12 colours against a fallback of 6.
  // `loadMoreCount` has since been realigned, so it pins the number the webview
  // viewState fixtures now mirror. The palette is still apart, which is what
  // makes it the live proof that the declaration is what users actually get —
  // an assertion that only checked for a non-empty array could never have
  // caught either.
  test("the declared default wins over the accessor's own fallback", () => {
    assert.strictEqual(config.loadMoreCount(), 100);
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
