import * as fs from "node:fs";

import * as vscode from "vscode";

import { type GitCommandHandler } from "@ging/core/backend/gitClient";
import { findGitDirs } from "@ging/core/backend/queries/gitDirs";
import { listStashes } from "@ging/core/backend/queries/listStashes";
import type { RepoGitClients } from "@ging/core/extension/repoGitClients";
import {
  loadStashFiles,
  selectorOfStash,
  type StashFile,
  type StashListItem,
  stashListItems
} from "@ging/core/extension/stashList";
import { createStashLogWatch, createStashViewWatch } from "@ging/core/extension/stashWatch";
import type { EditorGroup } from "@ging/vscode/config";
import * as l10n from "@ging/vscode/l10n";

import { openCommitDiff } from "./openCommitDiff";

const VIEW_ID = "ging-git-view.stash";
const OPEN_FILE_DIFF_COMMAND = "ging-git-view.stash.openFileDiff";

/** Scheme of the opaque per-file URIs that give a stash's file its icon (by
 *  name) and its change badge (by query), without picking up the working
 *  tree's own decorations as a `file:` URI would. */
const FILE_SCHEME = "ging-stash-file";

const BADGE_COLORS: Record<StashFile["badge"], string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  U: "gitDecoration.untrackedResourceForeground"
};

type StashNode = { kind: "stash"; repo: string; stash: StashListItem };
type FileNode = { kind: "file"; parentId: string; file: StashFile };
type Node = StashNode | FileNode;

const stashNodeId = (node: StashNode) => node.repo + "::stash::" + node.stash.id;

/**
 * Watch the stash log under `commonDir` with VS Code's file watcher, one
 * non-recursive watch at a time (see `createStashLogWatch`). Non-recursive, so
 * `files.watcherExclude` — often set to `**\/.git/**` — can't silence it.
 */
export function watchStashLog(commonDir: string, onChange: () => void): vscode.Disposable {
  const watch = createStashLogWatch({
    commonDir,
    isDirectory: (dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    watch: ({ base, glob }, onEvent) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(base), glob)
      );
      return vscode.Disposable.from(
        watcher.onDidCreate(onEvent),
        watcher.onDidChange(onEvent),
        watcher.onDidDelete(onEvent),
        watcher
      );
    },
    onChange
  });
  return new vscode.Disposable(() => watch.dispose());
}

/** How the Stash side-view runs git outside of `simple-git`. */
export type StashGitDeps = {
  gitPath: () => string;
  gitEnv?: () => NodeJS.ProcessEnv;
  onCommand?: GitCommandHandler;
};

/** The Stash side-view's watch (`createStashViewWatch`), wired to git and to
 *  VS Code's file watcher. */
export function createStashRefreshWatch(deps: StashGitDeps & { refresh: () => void }) {
  return createStashViewWatch({
    findCommonDir: async (repo) =>
      (
        await findGitDirs({
          gitPath: deps.gitPath(),
          repoPath: repo,
          gitEnv: deps.gitEnv?.(),
          onCommand: deps.onCommand
        })
      )?.commonDir ?? null,
    watchStashLog,
    refresh: deps.refresh
  });
}

class StashProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private stashes: StashNode[] = [];
  private repo: string | null = null;
  // Guards against an in-flight read being overwritten by a slower earlier one.
  private fetchId = 0;

  constructor(private readonly gitClients: RepoGitClients) {}

  getRepo(): string | null {
    return this.repo;
  }

  /** List `repo`'s stashes from now on; the list is read by `reload`. */
  setRepo(repo: string | null): void {
    this.repo = repo;
    this.stashes = [];
    this.fetchId++;
    // Drives the two welcome texts apart: "no repo" vs "no stashes".
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.stashView.hasRepo",
      repo !== null
    );
    this._onDidChangeTreeData.fire();
  }

  async reload(): Promise<void> {
    const id = ++this.fetchId;
    const repo = this.repo;
    const stashes = repo === null ? [] : await listStashes(this.gitClients.gitClientFor(repo));
    if (id !== this.fetchId) return; // superseded by a newer read
    this.stashes = stashListItems(stashes).map((stash) => ({ kind: "stash", repo: repo!, stash }));
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "stash") {
      const { selector, message, date } = node.stash;
      const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = stashNodeId(node);
      item.contextValue = "stash";
      item.iconPath = new vscode.ThemeIcon("archive");
      item.description = selector;
      item.tooltip = [
        selector,
        message,
        date === null ? null : new Date(date * 1000).toLocaleString()
      ]
        .filter((line) => line !== null)
        .join("\n");
      return item;
    }
    const { name, dir, badge, diff } = node.file;
    const item = new vscode.TreeItem(
      vscode.Uri.from({ scheme: FILE_SCHEME, path: "/" + diff.newFilePath, query: badge }),
      vscode.TreeItemCollapsibleState.None
    );
    item.id = node.parentId + "::" + badge + "::" + diff.newFilePath;
    item.label = name;
    item.description = dir;
    item.iconPath = vscode.ThemeIcon.File;
    item.tooltip =
      diff.oldFilePath !== diff.newFilePath
        ? diff.oldFilePath + " → " + diff.newFilePath
        : diff.newFilePath;
    item.command = {
      command: OPEN_FILE_DIFF_COMMAND,
      title: l10n.t("action.viewDiff"),
      arguments: [diff]
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) return this.stashes;
    if (node.kind === "file") return [];
    const files = await loadStashFiles(
      this.gitClients.gitClientFor(node.repo),
      node.repo,
      node.stash.hash
    );
    const parentId = stashNodeId(node);
    return (files ?? []).map((file) => ({ kind: "file", parentId, file }));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export type StashView = ReturnType<typeof createStashView>;

/**
 * Create and wire the Stash side-view: the current repository's stashes,
 * newest first, each expanding into the files it changed, a click on one
 * opening its diff. Read-only but for copying a stash's name. It keeps itself
 * current with its own watch over the stash log while visible (see
 * `createStashViewWatch`), whether or not the graph panel is open.
 */
export function createStashView(
  deps: StashGitDeps & {
    gitClients: RepoGitClients;
    /** The editor group diffs open in. */
    editorGroup: () => EditorGroup;
  }
) {
  const provider = new StashProvider(deps.gitClients);
  const treeView = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: provider });
  const watch = createStashRefreshWatch({ ...deps, refresh: () => void provider.reload() });
  watch.setVisible(treeView.visible);

  const subscriptions = [
    treeView,
    provider,
    treeView.onDidChangeVisibility(({ visible }) => watch.setVisible(visible)),
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) => {
        if (uri.scheme !== FILE_SCHEME) return undefined;
        const badge = uri.query as StashFile["badge"];
        const color = BADGE_COLORS[badge];
        return color === undefined ? undefined : { badge, color: new vscode.ThemeColor(color) };
      }
    }),
    vscode.commands.registerCommand("ging-git-view.stash.refresh", () => provider.reload()),
    vscode.commands.registerCommand(OPEN_FILE_DIFF_COMMAND, async (request) => {
      if (!(await openCommitDiff(request, deps.editorGroup()))) {
        void vscode.window.showErrorMessage(l10n.t("error.unableToViewDiff"));
      }
    }),
    // The stash is named by its SHA; its selector is looked up now, since the
    // one on screen may have moved since the list was read, and copying it
    // would hand out the name of whichever stash sits there now.
    vscode.commands.registerCommand("ging-git-view.stash.copyName", async (node: unknown) => {
      if (!isStashNode(node)) return;
      const stashes = await listStashes(deps.gitClients.gitClientFor(node.repo));
      const selector = selectorOfStash(stashes, node.stash.hash);
      if (selector === null) {
        void vscode.window.showWarningMessage(l10n.t("stashView.stashGone"));
        void provider.reload();
        return;
      }
      await vscode.env.clipboard.writeText(selector);
    })
  ];

  return {
    setActiveRepo: (repo: string | null): void => {
      if (repo === provider.getRepo()) return;
      provider.setRepo(repo);
      watch.setRepo(repo);
    },
    getActiveRepo: (): string | null => provider.getRepo(),
    dispose: (): void => {
      watch.dispose();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

function isStashNode(node: unknown): node is StashNode {
  return typeof node === "object" && node !== null && (node as Partial<StashNode>).kind === "stash";
}
