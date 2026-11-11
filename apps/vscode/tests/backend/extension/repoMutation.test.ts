import { describe, expect, it } from "vitest";

import { createRunRepoMutation } from "@ging/vscode/extension/repoMutation";

// The VS Code host's hook around the fetches that bypass the webview bridge.
// What matters most is the case the bridge never covered: no graph open, where
// nothing but this hook invalidates the cached read and redraws the side views.

function harness(withPanel: boolean) {
  const calls: string[] = [];
  const watcher = { mute: () => calls.push("mute"), unmute: () => calls.push("unmute") };
  const run = createRunRepoMutation({
    watcher: () => (withPanel ? watcher : undefined),
    afterMutation: () => calls.push("refresh")
  });
  return { calls, run };
}

describe("runRepoMutation", () => {
  it("runs the work inside the open graph's mute, then refreshes", async () => {
    const h = harness(true);
    await h.run("/repo", async () => {
      h.calls.push("work");
    });
    expect(h.calls).toEqual(["mute", "work", "unmute", "refresh"]);
  });

  it("refreshes with no graph open", async () => {
    const h = harness(false);
    await h.run("/repo", async () => {
      h.calls.push("work");
    });
    expect(h.calls).toEqual(["work", "refresh"]);
  });

  it("unmutes and refreshes when the work fails, then rejects with its error", async () => {
    const h = harness(true);
    const failure = new Error("fetch failed");
    await expect(
      h.run("/repo", async () => {
        h.calls.push("work");
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(h.calls).toEqual(["mute", "work", "unmute", "refresh"]);
  });

  it("unmutes the watcher it muted, though the graph closed meanwhile", async () => {
    const calls: string[] = [];
    let current: { mute(): void; unmute(): void } | undefined = {
      mute: () => calls.push("mute"),
      unmute: () => calls.push("unmute")
    };
    const run = createRunRepoMutation({
      watcher: () => current,
      afterMutation: () => calls.push("refresh")
    });
    await run("/repo", async () => {
      current = undefined;
    });
    expect(calls).toEqual(["mute", "unmute", "refresh"]);
  });
});
