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
    assert.ok(Array.isArray(config.graphColours()) && config.graphColours().length > 0);
  });

  test("accessors read the grouped keys registered in package.json", async () => {
    await cfg().update("show.remoteBranches", false, G);
    assert.strictEqual(config.showRemoteBranches(), false);
    await cfg().update("graph.edgeStyle", "angular", G);
    assert.strictEqual(config.graphStyle(), "angular");
  });
});
