import * as assert from "node:assert";

import * as vscode from "vscode";

/** Poll until `predicate` holds, or give up — the caller asserts either way. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50)); // eslint-disable-line no-await-in-loop
  }
}

suite("GitGraphPanel", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("0miles.ging-git-view");
    await ext?.activate();
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await new Promise((r) => setTimeout(r, 200));
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  function isPanelOpen() {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === "GING");
  }

  /** Every tab in the window holding a `ging-git-view` webview, whoever made it. */
  function graphTabs() {
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("ging-git-view")
      );
  }

  async function openPanel() {
    await vscode.commands.executeCommand("ging-git-view.view");
    await waitUntil(isPanelOpen);
  }

  test("view command opens the panel", async () => {
    await openPanel();
    assert.ok(isPanelOpen(), "Panel should be visible after executing view command");
  });

  test("running view command a second time reveals rather than opening a new tab", async () => {
    await openPanel();
    assert.ok(isPanelOpen());

    const tabsBefore = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    await vscode.commands.executeCommand("ging-git-view.view");
    await new Promise((r) => setTimeout(r, 300));
    const tabsAfter = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;

    assert.strictEqual(tabsAfter, tabsBefore, "Second invocation should not open a new tab");
  });

  test("view command reclaims a graph tab the extension does not own", async () => {
    // A graph tab nobody in the extension holds a handle to — what an
    // extension-host restart leaves behind, since VSCode restores the tab but
    // withholds it from the serializer until it first becomes visible.
    const stray = vscode.window.createWebviewPanel(
      "ging-git-view",
      "Stray Graph",
      vscode.ViewColumn.One,
      {}
    );
    try {
      await waitUntil(() => graphTabs().length === 1);
      assert.strictEqual(graphTabs().length, 1, "The stray tab should be the only graph tab");

      await vscode.commands.executeCommand("ging-git-view.view");
      await waitUntil(() => graphTabs().every((t) => t.label !== "Stray Graph"));

      assert.strictEqual(graphTabs().length, 1, "Opening should not leave a second graph tab");
      assert.ok(isPanelOpen(), "The remaining graph tab should be the extension's own panel");
    } finally {
      stray.dispose();
    }
  });

  test("closing the panel and running view command opens a fresh panel", async () => {
    await openPanel();
    assert.ok(isPanelOpen());

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!isPanelOpen(), "Panel should be closed");

    await openPanel();
    assert.ok(isPanelOpen(), "Panel should reopen after running view command again");
  });
});
