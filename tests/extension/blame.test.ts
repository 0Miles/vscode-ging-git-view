import * as assert from "node:assert";

import * as vscode from "vscode";

suite("inline blame", () => {
  const cfg = () => vscode.workspace.getConfiguration("ging-git-view");
  const globalValue = () => cfg().inspect<boolean>("blame.enabled")?.globalValue;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("0miles.ging-git-view");
    assert.ok(ext, "extension not found");
    await ext.activate();
  });

  teardown(async () => {
    await cfg().update("blame.enabled", undefined, vscode.ConfigurationTarget.Global);
  });

  test("is on by default", () => {
    assert.strictEqual(cfg().get("blame.enabled"), true);
  });

  test("the toggle command flips the user-level setting", async () => {
    await vscode.commands.executeCommand("ging-git-view.blame.toggle");
    assert.strictEqual(globalValue(), false);
    await vscode.commands.executeCommand("ging-git-view.blame.toggle");
    assert.strictEqual(globalValue(), true);
  });
});
