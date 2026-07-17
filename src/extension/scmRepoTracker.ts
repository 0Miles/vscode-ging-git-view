import * as vscode from "vscode";

import { getPathFromUri } from "@/backend/utils/path";

import {
  BuiltinGitApi,
  BuiltinRepository,
  onBuiltinGitEnabled,
  tryAcquireBuiltinGitApi
} from "./builtinGitApi";

export type ScmRepoTracker = {
  /** fs paths of every repo the built-in git extension currently knows about. */
  getRepoPaths(): string[];
  /** Fires when the set of known repos changes (a repo opened or closed). */
  readonly onDidChangeRepos: vscode.Event<void>;
  /** fs paths of the repos currently selected in the native Source Control view (`ui.selected`). */
  getSelectedRepoPaths(): string[];
  /** Fires (debounced) when the selected-repo set changes — never for the initial selection. */
  readonly onDidChangeSelection: vscode.Event<string[]>;
  dispose(): void;
};

/**
 * Tracks VSCode's built-in git repositories and which of them are selected in the Source Control
 * view. Selection follows `Repository.ui.selected` (the same signal the GitHub PR extension reads);
 * multiple repos can be selected at once. The initial selection at startup is captured silently so
 * we don't drive the graph just because the workspace opened.
 */
export function createScmRepoTracker(): ScmRepoTracker {
  const reposEmitter = new vscode.EventEmitter<void>();
  const selectionEmitter = new vscode.EventEmitter<string[]>();
  let api: BuiltinGitApi | null = null;
  let apiSubs: vscode.Disposable[] = [];
  // Per-repo `ui.onDidChange` subscriptions; kept in sync as repos open/close.
  const uiSubs = new Map<BuiltinRepository, vscode.Disposable>();
  let selected: string[] = [];
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;

  const sortedPaths = (repos: readonly BuiltinRepository[]) =>
    repos.map((r) => getPathFromUri(r.rootUri)).toSorted((a, b) => a.localeCompare(b));

  function computeSelected(): string[] {
    return api ? sortedPaths(api.repositories.filter((r) => r.ui.selected)) : [];
  }

  function recomputeSelection(): void {
    const next = computeSelected();
    if (next.length === selected.length && next.every((p, i) => p === selected[i])) return;
    selected = next;
    selectionEmitter.fire(selected);
  }

  // Switching the SC selection flips several repos' `ui.selected` in one burst; coalesce them so we
  // emit the final set once instead of firing through transient intermediate selections.
  function scheduleSelectionRecompute(): void {
    if (selectionTimer !== null) return;
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      recomputeSelection();
    }, 50);
  }

  function watchRepo(repo: BuiltinRepository): void {
    if (uiSubs.has(repo)) return;
    uiSubs.set(repo, repo.ui.onDidChange(scheduleSelectionRecompute));
  }
  function unwatchRepo(repo: BuiltinRepository): void {
    uiSubs.get(repo)?.dispose();
    uiSubs.delete(repo);
  }

  function bindApi(found: BuiltinGitApi): void {
    api = found;
    apiSubs.push(
      found.onDidOpenRepository((r) => {
        watchRepo(r);
        reposEmitter.fire();
        scheduleSelectionRecompute();
      })
    );
    apiSubs.push(
      found.onDidCloseRepository((r) => {
        unwatchRepo(r);
        reposEmitter.fire();
        scheduleSelectionRecompute();
      })
    );
    for (const repo of found.repositories) watchRepo(repo);
    // Capture the startup selection silently — only later changes should drive the graph.
    selected = computeSelected();
    reposEmitter.fire();
  }

  const enableSub = onBuiltinGitEnabled(() => {
    if (api !== null) return;
    void tryAcquireBuiltinGitApi().then((found) => {
      if (api === null && found) bindApi(found);
    });
  });
  void tryAcquireBuiltinGitApi().then((found) => {
    if (api === null && found) bindApi(found);
  });

  return {
    onDidChangeRepos: reposEmitter.event,
    onDidChangeSelection: selectionEmitter.event,
    getRepoPaths: () => (api ? sortedPaths(api.repositories) : []),
    getSelectedRepoPaths: () => selected.slice(),
    dispose: () => {
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      enableSub.dispose();
      for (const sub of apiSubs) sub.dispose();
      apiSubs = [];
      for (const sub of uiSubs.values()) sub.dispose();
      uiSubs.clear();
      reposEmitter.dispose();
      selectionEmitter.dispose();
    }
  };
}
