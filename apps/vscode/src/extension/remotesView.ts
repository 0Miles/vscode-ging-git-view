import * as vscode from "vscode";

import type { ConfiguredRemote } from "@ging/core/backend/queries/listRemotes";
import type { RemoteTarget } from "@ging/core/extension/remoteCommands";

/** A repo's configured remotes, with their URLs; rejects when they cannot be
 *  read. */
type ListRemotes = (repo: string) => Promise<ConfiguredRemote[]>;

/** A TreeItem backed by one remote. Carries the remote and its repo so
 *  commands invoked from the context menu have everything they need. */
class RemoteItem extends vscode.TreeItem {
  constructor(
    public readonly remote: ConfiguredRemote,
    public readonly repo: string
  ) {
    super(remote.name, vscode.TreeItemCollapsibleState.None);
    this.id = repo + "::remote::" + remote.name;
    this.contextValue = "remote";
    this.iconPath = new vscode.ThemeIcon("cloud");
    this.description = remote.fetchUrl;
    // Spell out both URLs when they diverge; otherwise the one URL suffices.
    this.tooltip =
      remote.pushUrl !== remote.fetchUrl
        ? remote.name + "\nfetch: " + remote.fetchUrl + "\npush: " + remote.pushUrl
        : remote.name + "\n" + remote.fetchUrl;
  }
}

class RemotesProvider implements vscode.TreeDataProvider<RemoteItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private remotes: ConfiguredRemote[] = [];
  private repo: string | null = null;
  // Guards against an in-flight fetch being overwritten by a slower earlier one.
  private fetchId = 0;

  constructor(private readonly listRemotes: ListRemotes) {}

  getRepo(): string | null {
    return this.repo;
  }

  setRepo(repo: string | null): void {
    if (repo === this.repo) return;
    this.repo = repo;
    this.remotes = [];
    void this.reload();
  }

  refresh(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    const id = ++this.fetchId;
    const repo = this.repo;
    // Drives the two welcome texts apart: "no repo" vs "no remotes yet".
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.remotesView.hasRepo",
      repo !== null
    );
    if (repo === null) {
      this.remotes = [];
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      const remotes = await this.listRemotes(repo);
      if (id !== this.fetchId) return; // superseded by a newer fetch
      this.remotes = remotes;
    } catch {
      if (id !== this.fetchId) return;
      this.remotes = [];
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RemoteItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RemoteItem): RemoteItem[] {
    if (this.repo === null || element !== undefined) return [];
    return this.remotes.map((remote) => new RemoteItem(remote, this.repo!));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Resolve the action target from a context-menu command argument (the clicked
 *  tree item), or null when it isn't a remote item. */
export function remoteActionTarget(item: unknown): RemoteTarget | null {
  if (item instanceof RemoteItem) {
    return { repo: item.repo, name: item.remote.name, fetchUrl: item.remote.fetchUrl };
  }
  return null;
}

export type RemotesView = ReturnType<typeof createRemotesView>;

/**
 * Create and wire the Remotes side-view: a flat native TreeView listing the
 * active repo's configured remotes, read through `listRemotes`. Mutations
 * (add/edit/rename/remove) are core's `remoteCommands`, registered as commands
 * in extension.ts; the view follows whichever repo is active, exactly like the
 * Branches view.
 */
export function createRemotesView(listRemotes: ListRemotes) {
  const provider = new RemotesProvider(listRemotes);
  const treeView = vscode.window.createTreeView<RemoteItem>("ging-git-view.remotes", {
    treeDataProvider: provider
  });

  return {
    setActiveRepo: (repo: string | null): void => provider.setRepo(repo),
    getActiveRepo: (): string | null => provider.getRepo(),
    refresh: (): void => provider.refresh(),
    dispose: (): void => {
      treeView.dispose();
      provider.dispose();
    }
  };
}
