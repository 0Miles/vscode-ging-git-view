import * as vscode from "vscode";

import { RepoFileWatcher } from "@/repoFileWatcher";
import { RequestMessage, ResponseMessage } from "@/types";

export function webviewBridgeFactory(webview: vscode.Webview, repoFileWatcher: RepoFileWatcher) {
  const handlers = new Map<
    string,
    { handler: (msg: RequestMessage) => void | Promise<void>; mutatesRepo: boolean }
  >();

  webview.onDidReceiveMessage(async (msg: RequestMessage) => {
    const entry = handlers.get(msg.command);
    if (!entry) return;
    // Only repo-mutating handlers mute the watcher (and arm its post-unmute
    // quiet period): their own git side-effects would otherwise bounce straight
    // back as a redundant refresh. Query handlers must NOT mute — while a CLI
    // operation (e.g. `git rebase`) is in progress the webview keeps sending
    // queries, and muting for each of them would swallow the very fs events
    // that signal the operation finished (issue #26).
    if (entry.mutatesRepo) repoFileWatcher.mute();
    await entry.handler(msg);
    if (entry.mutatesRepo) repoFileWatcher.unmute();
  });

  return {
    post: (msg: ResponseMessage) => webview.postMessage(msg),
    onMessage: <T extends RequestMessage["command"]>(
      command: T,
      handler: (msg: Extract<RequestMessage, { command: T }>) => void | Promise<void>,
      options?: { mutatesRepo: boolean }
    ) => {
      handlers.set(command, {
        handler: handler as (msg: RequestMessage) => void | Promise<void>,
        mutatesRepo: options?.mutatesRepo ?? false
      });
    }
  };
}

export type WebviewBridge = ReturnType<typeof webviewBridgeFactory>;
