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
  /**
   * The same repos as `getSelectedRepoPaths`, as `Uri.toString()` strings. This is the form the
   * `scmProviderRootUri` context key takes, so a `when` clause can match a Source Control
   * Repositories row against the selection.
   */
  getSelectedRepoUris(): string[];
  /** Fires (debounced) when the selected-repo set changes — never for the initial selection. */
  readonly onDidChangeSelection: vscode.Event<string[]>;
  dispose(): void;
};

/** A selected repo in both forms we need: fs path for repoManager, uri string for `when` clauses. */
type SelectedRepo = { path: string; uri: string };

/**
 * Tracks VSCode's built-in git repositories and which of them is focused in the Source Control
 * view. Selection follows `Repository.ui.selected` (the same signal the GitHub PR extension reads).
 * VSCode focuses at most one repo at a time — multi-select in the repositories list changes which
 * repos are *visible*, not which is focused — so this is a 0-or-1 set; it stays a list because the
 * `scmProviderRootUri in ...` when-clause consumes one. The initial selection at startup is
 * captured silently so we don't drive the graph just because the workspace opened.
 */
export function createScmRepoTracker(): ScmRepoTracker {
  const reposEmitter = new vscode.EventEmitter<void>();
  const selectionEmitter = new vscode.EventEmitter<string[]>();
  let api: BuiltinGitApi | null = null;
  let apiSubs: vscode.Disposable[] = [];
  // Per-repo `ui.onDidChange` subscriptions; kept in sync as repos open/close.
  const uiSubs = new Map<BuiltinRepository, vscode.Disposable>();
  let selected: SelectedRepo[] = [];
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;

  const sortedPaths = (repos: readonly BuiltinRepository[]) =>
    repos.map((r) => getPathFromUri(r.rootUri)).toSorted((a, b) => a.localeCompare(b));

  function computeSelected(): SelectedRepo[] {
    if (!api) return [];
    return api.repositories
      .filter((r) => r.ui.selected)
      .map((r) => ({ path: getPathFromUri(r.rootUri), uri: r.rootUri.toString() }))
      .toSorted((a, b) => a.path.localeCompare(b.path));
  }

  function recomputeSelection(): void {
    const next = computeSelected();
    if (next.length === selected.length && next.every((r, i) => r.path === selected[i].path))
      return;
    selected = next;
    selectionEmitter.fire(selected.map((r) => r.path));
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
    getSelectedRepoPaths: () => selected.map((r) => r.path),
    getSelectedRepoUris: () => selected.map((r) => r.uri),
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
