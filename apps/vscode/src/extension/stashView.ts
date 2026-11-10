import * as vscode from "vscode";

import { listStashes } from "@ging/core/backend/queries/listStashes";
import type { RepoGitClients } from "@ging/core/extension/repoGitClients";
import {
  copyStashName,
  loadStashFiles,
  sameStashList,
  type StashFile,
  type StashListItem,
  stashListItems
} from "@ging/core/extension/stashList";
import { createStashViewWatch, type StashViewGit } from "@ging/core/extension/stashWatch";
import type { EditorGroup } from "@ging/vscode/config";
import { vscodeClipboard, vscodeL10n, vscodePrompts } from "@ging/vscode/hostPorts";
import * as l10n from "@ging/vscode/l10n";

import { openCommitDiff } from "./openCommitDiff";
import { watchPaths } from "./watchPaths";

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
const filesKey = (repo: string, hash: string) => repo + "\0" + hash;

class StashProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private stashes: StashNode[] = [];
  private repo: string | null = null;
  // Guards against an in-flight read being overwritten by a slower earlier one.
  private fetchId = 0;
  /** Each expanded stash's files, by repo and SHA: a stash never changes
   *  under its SHA. Kept for the stashes still listed. */
  private readonly files = new Map<string, Promise<StashFile[] | null>>();

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
    const items = stashListItems(stashes);
    const listed = new Set(items.map((stash) => filesKey(repo!, stash.hash)));
    for (const key of this.files.keys()) if (!listed.has(key)) this.files.delete(key);
    if (
      sameStashList(
        items,
        this.stashes.map((node) => node.stash)
      )
    )
      return;
    this.stashes = items.map((stash) => ({ kind: "stash", repo: repo!, stash }));
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
    const key = filesKey(node.repo, node.stash.hash);
    let load = this.files.get(key);
    if (load === undefined) {
      load = loadStashFiles(this.gitClients.gitClientFor(node.repo), node.repo, node.stash.hash);
      this.files.set(key, load);
    }
    const files = await load;
    // A stash that couldn't be read is read again next time.
    if (files === null && this.files.get(key) === load) this.files.delete(key);
    const parentId = stashNodeId(node);
    return (files ?? []).map((file) => ({ kind: "file", parentId, file }));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export type StashView = ReturnType<typeof createStashView>;

/**
 * The Stash side-view: the current repository's stashes, each expanding into
 * its files, a click opening the diff. It keeps itself current through
 * `createStashViewWatch`, graph panel open or not.
 */
export function createStashView(deps: {
  git: StashViewGit;
  gitClients: RepoGitClients;
  /** The editor group diffs open in. */
  editorGroup: () => EditorGroup;
}) {
  const provider = new StashProvider(deps.gitClients);
  const treeView = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: provider });
  const watch = createStashViewWatch({
    git: deps.git,
    // One non-recursive watch, which `files.watcherExclude` can't silence.
    watch: (target, onEvent) => watchPaths([target], onEvent),
    refresh: () => void provider.reload()
  });
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
    // #333: a stash whose position changed is refused, not redirected (see
    // `copyStashName`). Resolves to the outcome, for the tests.
    vscode.commands.registerCommand("ging-git-view.stash.copyName", (node: unknown) =>
      isStashNode(node)
        ? copyStashName(
            {
              git: deps.gitClients.gitClientFor(node.repo),
              clipboard: vscodeClipboard,
              prompts: vscodePrompts,
              l10n: vscodeL10n,
              refresh: () => void provider.reload()
            },
            node.stash
          )
        : undefined
    )
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
