import * as vscode from "vscode";

import { RepoFileWatcher } from "@/repoFileWatcher";
import { RequestMessage, ResponseMessage } from "@/types";

export function webviewBridgeFactory(
  webview: vscode.Webview,
  repoFileWatcher: RepoFileWatcher,
  /** Called after every repo-mutating handler. This — not the file watcher — is
   *  the reliable signal that refs changed: the watcher is muted across exactly
   *  these handlers and discards their own fs events, so hanging cache
   *  invalidation off it would leave the cache holding pre-mutation state
   *  (ADR-0013). Every branch mutation reaches here, including the side-view's,
   *  which are delegated to the webview (ADR-0010).
   *
   *  Deliberately carries no repo: action requests address the panel's current
   *  repo rather than naming one, so there is nothing here to pass on. The
   *  listener drops every cached repo instead. */
  onRepoMutated: () => void
) {
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
    try {
      await entry.handler(msg);
    } finally {
      // Invalidate even when the handler threw: a git operation can fail
      // half-way (a batch delete that removed three of five branches) and the
      // refs it did change are still changed.
      if (entry.mutatesRepo) {
        repoFileWatcher.unmute();
        onRepoMutated();
      }
    }
  });

  return {
    post: (msg: ResponseMessage) => webview.postMessage(msg),
    onMessage: <T extends RequestMessage["command"]>(
      command: T,
      handler: (msg: Extract<RequestMessage, { command: T }>) => void | Promise<void>,
      // Required on purpose: a silently-defaulted `false` is exactly how a
      // mutating handler would sneak past unmuted (or a query handler muted),
      // re-creating the echo-refresh / swallowed-event bugs the flag exists to
      // prevent. Every registration must state which side it is on.
      options: { mutatesRepo: boolean }
    ) => {
      handlers.set(command, {
        handler: handler as (msg: RequestMessage) => void | Promise<void>,
        mutatesRepo: options.mutatesRepo
      });
    }
  };
}

export type WebviewBridge = ReturnType<typeof webviewBridgeFactory>;
