import { afterEach, describe, expect, it, vi } from "vitest";

import { RepoFileWatcher } from "@/repoFileWatcher";

const fsWatcher = vi.hoisted(() => ({
  handlers: {} as Record<string, (uri: { fsPath: string }) => void>,
  disposed: false
}));

vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate: (h: (uri: { fsPath: string }) => void) => {
        fsWatcher.handlers.create = h;
      },
      onDidChange: (h: (uri: { fsPath: string }) => void) => {
        fsWatcher.handlers.change = h;
      },
      onDidDelete: (h: (uri: { fsPath: string }) => void) => {
        fsWatcher.handlers.delete = h;
      },
      dispose: () => {
        fsWatcher.disposed = true;
      }
    })
  }
}));

describe("RepoFileWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a change into one repoChangeCallback", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const watcher = new RepoFileWatcher(callback);
    watcher.start("/repo");
    fsWatcher.handlers.change({ fsPath: "/repo/src/a.ts" });
    fsWatcher.handlers.change({ fsPath: "/repo/src/b.ts" });
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the pending debounced refresh", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const watcher = new RepoFileWatcher(callback);
    watcher.start("/repo");
    fsWatcher.handlers.change({ fsPath: "/repo/src/a.ts" });
    // The owning panel disposes the watcher before the 750ms debounce fires;
    // the callback must not reach the now-disposed webview.
    watcher.stop();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(fsWatcher.disposed).toBe(true);
  });
});
