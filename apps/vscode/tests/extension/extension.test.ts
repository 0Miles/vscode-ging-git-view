import * as assert from "node:assert";

import * as vscode from "vscode";

import { isGraphWebviewTab } from "@/extension/graphPanelWindow";

/** Poll until `predicate` holds, or give up — the caller asserts either way. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50)); // eslint-disable-line no-await-in-loop
  }
}

// 本 suite 的綠燈**不代表**「current repository 跨工作階段保存」那條路徑的缺陷已修。
// CI 跑在乾淨的 runner 上,`@vscode/test-cli` 的 user-data 目錄是全新的 →
// `workspaceState` 空 → `getLastActiveRepo()` 回 `null` → `?? ""` → simple-git
// fallback 到 `process.cwd()` → activation 一路不 throw。另一層靜默來自 VS Code
// 自己:正式建置對 activation 失敗不給使用者任何訊息(只有 telemetry、extension
// host log 與 renderer DevTools console),所以「沒人回報」同樣不是沒壞的證據。
// 兩層靜默疊起來,就是那個缺陷活到今天的機制。
suite("GitGraphPanel", () => {
  /** 不要把下面那句換成 `assert.ok(ext.isActive)`:activation 失敗時 VS Code 放進
   *  activator 的 `FailedExtension` 也是一個 value,而 `isActivated()` 讀的是
   *  `Boolean(op && op.value)` —— `isActive` 照樣為 `true`,斷言它只會拿到假綠燈。
   *  失敗那一半本來就由 `await` 覆蓋:`Extension.activate()` 每次都會 reject。
   *  (兩者都是 VS Code 內部實作,而 `.vscode-test.mjs` 釘的是浮動的 `stable`。) */
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("0miles.ging-git-view");
    assert.ok(ext, "extension not found — check publisher.name and the packaged bundle");
    await ext.activate();
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

  /** Every tab in the window holding a graph webview, whoever made it. Asks the
   *  same predicate the extension reconciles with, against the real VSCode tab
   *  shape the unit tests can only imitate. */
  function graphTabs() {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isGraphWebviewTab);
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
