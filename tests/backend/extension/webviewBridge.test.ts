import { describe, expect, it, vi } from "vitest";

import { webviewBridgeFactory } from "@/extension/webviewBridge";
import type { RepoFileWatcher } from "@/repoFileWatcher";
import type { RequestMessage } from "@/types";

// `vi.mock` is hoisted above the imports, so the bridge's `import "vscode"`
// resolves to this stub even though the mock is declared after it.
vi.mock("vscode", () => ({}));

function makeHarness() {
  let receive: (msg: RequestMessage) => Promise<void>;
  const webview = {
    onDidReceiveMessage: (h: (msg: RequestMessage) => Promise<void>) => {
      receive = h;
    },
    postMessage: vi.fn()
  };
  const watcher = { mute: vi.fn(), unmute: vi.fn() };
  const onRepoMutated = vi.fn();
  const bridge = webviewBridgeFactory(
    webview as never,
    watcher as unknown as RepoFileWatcher,
    onRepoMutated
  );
  return { bridge, watcher, onRepoMutated, receive: (msg: RequestMessage) => receive(msg) };
}

describe("webviewBridge watcher muting", () => {
  it("does not mute the watcher for query messages (issue #26)", async () => {
    const { bridge, watcher, receive } = makeHarness();
    const handler = vi.fn();
    bridge.onMessage("operationState", handler, { mutatesRepo: false });
    // While a CLI `git rebase` runs, the webview keeps sending queries; muting
    // (and the post-unmute quiet period) for those would swallow the fs events
    // that signal the rebase finished, leaving the conflict banner stuck.
    await receive({ command: "operationState", repo: "/repo" } as RequestMessage);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(watcher.mute).not.toHaveBeenCalled();
    expect(watcher.unmute).not.toHaveBeenCalled();
  });

  it("mutes the watcher around repo-mutating handlers", async () => {
    const { bridge, watcher, receive } = makeHarness();
    const order: string[] = [];
    watcher.mute.mockImplementation(() => order.push("mute"));
    watcher.unmute.mockImplementation(() => order.push("unmute"));
    bridge.onMessage(
      "mergeBranch",
      async () => {
        order.push("handler");
      },
      { mutatesRepo: true }
    );
    await receive({ command: "mergeBranch" } as RequestMessage);
    expect(order).toEqual(["mute", "handler", "unmute"]);
  });
});

describe("webviewBridge cache invalidation", () => {
  it("reports a mutation so cached repo reads can be dropped", async () => {
    // The file watcher cannot carry this: it is muted across exactly these
    // handlers and discards their own fs events (ADR-0013).
    const { bridge, onRepoMutated, receive } = makeHarness();
    bridge.onMessage("deleteBranch", async () => {}, { mutatesRepo: true });
    await receive({ command: "deleteBranch" } as RequestMessage);
    expect(onRepoMutated).toHaveBeenCalledTimes(1);
  });

  it("does not report a mutation for query messages", async () => {
    const { bridge, onRepoMutated, receive } = makeHarness();
    bridge.onMessage("operationState", async () => {}, { mutatesRepo: false });
    await receive({ command: "operationState" } as RequestMessage);
    expect(onRepoMutated).not.toHaveBeenCalled();
  });

  it("still reports (and unmutes) when the handler throws", async () => {
    // A git operation can fail half-way — the refs it did change are changed,
    // and a permanently muted watcher would be the second casualty.
    const { bridge, watcher, onRepoMutated, receive } = makeHarness();
    bridge.onMessage(
      "deleteBranch",
      async () => {
        throw new Error("boom");
      },
      { mutatesRepo: true }
    );
    await expect(receive({ command: "deleteBranch" } as RequestMessage)).rejects.toThrow("boom");
    expect(watcher.unmute).toHaveBeenCalledTimes(1);
    expect(onRepoMutated).toHaveBeenCalledTimes(1);
  });
});
