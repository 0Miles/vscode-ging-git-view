/* The host half of a Tab's Branches, Remotes and Stash side views (#399,
 * #400). The page draws them (packages/webview/src/desktop/sideViews/); this
 * reads what they show through core, as VS Code's side views read it, and
 * answers what they ask. One per webview instance, on its one repository.
 *
 * What it does not do is delegate branch actions to the graph: the graph is
 * in the same page as the side view, which calls it directly (ADR-0033). So
 * there is no `branchActionDelegate` here, nothing held for a reload, and no
 * head guard — that is the page's, which holds the row.
 *
 * A stash's actions are run here, as VS Code's Stash view runs them in its
 * host: the graph's stash dialogs find their stash among the rows it has
 * loaded, and this view lists the stashes it has not (ADR-0029). They are
 * core's own (`LISTED_STASH_ACTIONS`), asked in the page's host prompt
 * overlay, on the stash as it was listed here. */

import { relativeAge } from "@ging/core/extension/branchActivity";
import type { BranchFacts } from "@ging/core/extension/branchFacts";
import { showAllRepo } from "@ging/core/extension/branchFilter";
import type { BranchFilterStore } from "@ging/core/extension/branchFilterStore";
import {
  batchNoTargetsMessage,
  resolveSideViewToggle,
  sideViewBranchRoots
} from "@ging/core/extension/branchSideView";
import type { CommitDiffRequest } from "@ging/core/extension/commitDiff";
import type { RemoteCommands, RemoteTarget } from "@ging/core/extension/remoteCommands";
import { type SideViewField, sideViewStateChanged } from "@ging/core/extension/repoSettings";
import {
  LISTED_STASH_ACTIONS,
  type ListedStashHost,
  loadStashFiles,
  loadStashList,
  type StashFile,
  type StashListItem
} from "@ging/core/extension/stashList";
import { createStashViewWatch } from "@ging/core/extension/stashWatch";
import type {
  Clipboard,
  HostConfig,
  HostLogger,
  L10n,
  Prompts,
  RepoSource
} from "@ging/core/host/ports";
import { displayRef } from "@ging/shared/backend/utils/branchRef";
import type { BranchTreeNode } from "@ging/shared/backend/utils/branchTree";
import type { GitRepoState } from "@ging/shared/types";
import type {
  SideViewBranches,
  SideViewMessage,
  SideViewRemote,
  SideViewRequest,
  SideViewRowText,
  SideViewStash,
  SideViewStashFile,
  SideViewStrings,
  SideViewToggleField
} from "@ging/webview/desktop/sideViews/protocol";

/** The page's toggle fields are core's, and core's the page's. */
const SAME_FIELDS: [SideViewField, SideViewToggleField] extends [SideViewToggleField, SideViewField]
  ? true
  : false = true;
void SAME_FIELDS;

export type SideViewsDeps = {
  /** The Tab's repository: the one the views show, and the only one. */
  repo: string;
  /** Into the Tab's page. */
  post(message: SideViewMessage): void;
  branchFacts: Pick<BranchFacts, "facts">;
  filterStore: Pick<BranchFilterStore, "set" | "onDidChangeFilter">;
  repoSource: Pick<RepoSource, "getRepos" | "updateRepoState">;
  config: Pick<
    HostConfig,
    | "showRemoteBranches"
    | "repoSettingDefaults"
    | "inactiveBranchAlwaysShow"
    | "contextMenuActionsVisibility"
  >;
  l10n: L10n;
  prompts: Pick<Prompts, "showInformation">;
  clipboard: Clipboard;
  remoteCommands: Pick<RemoteCommands, "list" | "add" | "editUrl" | "rename" | "remove">;
  /** Fetch one remote, as the Remotes view's Fetch does in VS Code. */
  fetchRemote(repo: string, remote: string): PromiseLike<void>;
  managePullRequestProviders(): void;
  /** Tell the graph whether the repo's remote branches are shown now: it
   *  decides which refs its `git log` walks. */
  setShowRemoteBranches(value: boolean): void;
  /** What core's stash actions run on (#400): the repository's git, and where
   *  they ask — the Tab's host prompt overlay. The list they re-read is this
   *  view's. */
  stash: Omit<ListedStashHost, "refresh">;
  /** How the Stash view watches the repository's stash log, as VS Code's
   *  does (`createStashViewWatch`): git to find the common dir with, and one
   *  non-recursive watch; the rest as `createStashViewWatch` defaults them. */
  stashWatch: Pick<
    Parameters<typeof createStashViewWatch>[0],
    "git" | "watch" | "debounceMs" | "findCommonDir"
  >;
  /** Open a stash file's diff (`Opener.openCommitDiff`); false when it could
   *  not be. */
  openCommitDiff(request: CommitDiffRequest): PromiseLike<boolean>;
  /** A stash's date, as its tooltip shows it. */
  formatDate(unixSec: number): string;
  logger: Pick<HostLogger, "logError">;
  nowMs(): number;
};

export type SideViews = {
  /** What the page's side views asked. Settles once what it started has:
   *  the reads it asked for sent to the page, the command it ran finished. */
  receive(message: SideViewRequest): Promise<void>;
  /** Read both views again, as after anything that may move a ref. */
  refresh(): void;
  /** A setting was written: redraw what is read off the settings — the
   *  branches' thresholds and "always show", the menus' visibility — which
   *  is the branches and the message's own; remotes and stashes read none. */
  settingChanged(): void;
  /** The repo state was written, by the views' toggles or by the graph's
   *  Repository Settings drawer (#183): redraw if a toggle moved. */
  repoStateWritten(before: GitRepoState | undefined, after: GitRepoState): void;
  /** The page is loading anew: nothing is sent until it says it listens. */
  pageLoading(): void;
  /** Show All for `requested` — the graph's filter chip, through the
   *  dispatch's `showAllBranches` hook (#399): the empty filter, for this
   *  repository and no other (`showAllRepo`). */
  showAll(requested: string): void;
  dispose(): void;
};

/** A stash file's row, as VS Code's TreeItem has it: its tooltip is its
 *  path, or where it was renamed from and to. */
const fileRow = ({ name, dir, badge, diff }: StashFile): SideViewStashFile => ({
  path: diff.newFilePath,
  name,
  dir,
  badge,
  tooltip:
    diff.oldFilePath !== diff.newFilePath
      ? diff.oldFilePath + " → " + diff.newFilePath
      : diff.newFilePath
});

export function createSideViews(deps: SideViewsDeps): SideViews {
  const { repo, l10n, config } = deps;

  let listening = false;
  /** The last filter the page asked for that this has taken (its `seq`). */
  let filterSeq = 0;
  let branches: SideViewBranches | null = null;
  let remotes: SideViewRemote[] | null = null;
  /** The stashes as last listed: what the page's requests name by `id`, and
   *  what an action binds to (ADR-0029). */
  let stashes: StashListItem[] | null = null;
  /** Each expanded stash's files, by SHA: a stash never changes under its
   *  SHA. Kept for the stashes still listed. */
  const stashFiles = new Map<string, Promise<StashFile[] | null>>();
  // Guards against a slower earlier read overwriting a later one.
  let branchesRead = 0;
  let remotesRead = 0;
  let stashesRead = 0;

  const toggles = (): Record<SideViewToggleField, boolean> => {
    const state = deps.repoSource.getRepos()[repo];
    const defaults = config.repoSettingDefaults();
    return {
      showRemoteBranches: resolveSideViewToggle(
        state,
        "showRemoteBranches",
        config.showRemoteBranches()
      ),
      showInactiveBranches: resolveSideViewToggle(
        state,
        "showInactiveBranches",
        defaults.showInactiveBranches
      ),
      showMergedBranches: resolveSideViewToggle(
        state,
        "showMergedBranches",
        defaults.showMergedBranches
      )
    };
  };

  const strings: SideViewStrings = (() => {
    const t = (key: string) => l10n.t(key);
    return {
      branches: t("desktop.sideView.branches"),
      remotes: t("desktop.sideView.remotes"),
      groupRemote: t("branchView.group.remote"),
      groupLocal: t("branchView.group.local"),
      noBranches: t("desktop.sideView.noBranches"),
      noRemotes: t("desktop.sideView.noRemotes"),
      more: t("desktop.sideView.more"),
      showAll: t("desktop.sideView.showAll"),
      refresh: t("desktop.sideView.refresh"),
      showRemoteBranches: t("desktop.sideView.showRemoteBranches"),
      showInactive: t("desktop.sideView.showInactive"),
      showMerged: t("desktop.sideView.showMerged"),
      collapseAll: t("desktop.sideView.collapseAll"),
      cleanup: t("desktop.sideView.cleanup"),
      deleteSelected: t("desktop.sideView.deleteSelected"),
      pushSelected: t("desktop.sideView.pushSelected"),
      fastForwardSelected: t("desktop.sideView.fastForwardSelected"),
      copyNameSelected: t("desktop.sideView.copyNameSelected"),
      addRemote: t("desktop.sideView.addRemote"),
      managePullRequestProviders: t("desktop.sideView.managePullRequestProviders"),
      fetchRemote: t("desktop.sideView.fetchRemote"),
      editUrl: t("desktop.sideView.editUrl"),
      renameRemote: t("desktop.sideView.renameRemote"),
      removeRemote: t("desktop.sideView.removeRemote"),
      copyUrl: t("desktop.sideView.copyUrl"),
      stashes: t("desktop.sideView.stashes"),
      noStashes: t("desktop.sideView.noStashes")
    };
  })();

  /** A stash's row, as VS Code's TreeItem has it: its message, its selector
   *  beside it, and the two with its date in its tooltip. */
  const stashRow = ({ id, selector, message, date }: StashListItem): SideViewStash => ({
    id,
    selector,
    message,
    tooltip: [selector, message, ...(date === null ? [] : [deps.formatDate(date)])].join("\n")
  });

  const send = () => {
    if (!listening) return;
    deps.post({
      command: "sideViewState",
      repo,
      branches,
      remotes,
      stashes: stashes?.map(stashRow) ?? null,
      filterSeq,
      cmv: config.contextMenuActionsVisibility(),
      strings
    });
  };

  /** A leaf's words, as VS Code's TreeItem has them: "current" and the age
   *  of an inactive branch after its name; the ref, and what it was merged
   *  into, in its tooltip. */
  const rowTexts = (
    roots: readonly BranchTreeNode[],
    defaultBranch: string | null
  ): Record<string, SideViewRowText> => {
    const nowSec = Math.floor(deps.nowMs() / 1000);
    const rows: Record<string, SideViewRowText> = {};
    const walk = (nodes: readonly BranchTreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== "leaf") {
          walk(node.children);
          continue;
        }
        const description: string[] = [];
        if (node.isHead) description.push(l10n.t("branchView.current"));
        if (node.isInactive && node.lastActivitySec !== undefined) {
          const age = relativeAge(node.lastActivitySec, nowSec);
          description.push(l10n.t("branchView.age." + age.unit, age.value));
        }
        rows[node.branch] = {
          description: description.join(" · "),
          tooltip:
            node.isMerged && defaultBranch !== null
              ? node.branch + "\n" + l10n.t("branchView.mergedInto", displayRef(defaultBranch))
              : node.branch
        };
      }
    };
    walk(roots);
    return rows;
  };

  /** `hard` past the coalescing window: the user asked for it now. */
  const readBranches = async (hard = false) => {
    const read = ++branchesRead;
    const shown = toggles();
    try {
      const facts = await deps.branchFacts.facts(repo, { hard });
      if (read !== branchesRead) return;
      const roots = sideViewBranchRoots(
        facts,
        { showInactive: shown.showInactiveBranches, showMerged: shown.showMergedBranches },
        config.inactiveBranchAlwaysShow()
      );
      branches = {
        roots,
        rows: rowTexts(roots, facts.defaultBranch),
        filter: facts.filter,
        toggles: shown
      };
    } catch (e: unknown) {
      if (read !== branchesRead) return;
      deps.logger.logError(`side views: cannot read the branches of ${repo}: ${String(e)}`);
      branches = null;
    }
    send();
  };

  const readRemotes = async () => {
    const read = ++remotesRead;
    try {
      const listed = await deps.remoteCommands.list(repo);
      if (read !== remotesRead) return;
      remotes = listed;
    } catch (e: unknown) {
      if (read !== remotesRead) return;
      deps.logger.logError(`side views: cannot read the remotes of ${repo}: ${String(e)}`);
      remotes = null;
    }
    send();
  };

  /** The stash read started last: the one whose list is sent, a read started
   *  before it sending nothing. */
  let latestStashRead: Promise<void> = Promise.resolve();
  const readStashes = (): Promise<void> => {
    latestStashRead = readStashesOnce();
    return latestStashRead;
  };
  /** Settles once the stash list a read sent is the latest: a read that a
   *  newer one superseded sends nothing, so this waits for that newer one,
   *  and for any started while it ran. */
  const stashesSent = async (): Promise<void> => {
    const read = latestStashRead;
    await read;
    if (read !== latestStashRead) await stashesSent();
  };

  const readStashesOnce = async () => {
    const read = ++stashesRead;
    try {
      const listed = await loadStashList(deps.stash.git);
      if (read !== stashesRead) return;
      stashes = listed;
      const kept = new Set(listed.map((stash) => stash.hash));
      for (const hash of stashFiles.keys()) if (!kept.has(hash)) stashFiles.delete(hash);
    } catch (e: unknown) {
      if (read !== stashesRead) return;
      deps.logger.logError(`side views: cannot read the stashes of ${repo}: ${String(e)}`);
      stashes = null;
    }
    send();
  };

  const refresh = async (hard = false) => {
    await Promise.all([readBranches(hard), readRemotes(), readStashes().then(stashesSent)]);
  };

  // The Stash view keeps itself current while the page listens, as VS Code's
  // does while shown: the stash log is not among what the graph's watcher
  // takes (`isWatchedRepoPath`), and a drop below the top changes nothing else.
  const stashWatch = createStashViewWatch({
    ...deps.stashWatch,
    refresh: () => void readStashes()
  });
  stashWatch.setRepo(repo);

  /** What core's stash actions are handed: the list they re-read is this. */
  const stashHost: ListedStashHost = { ...deps.stash, refresh: () => void readStashes() };

  /** The stash a request names, as it was listed. */
  const listedStash = (id: string): StashListItem | null =>
    stashes?.find((stash) => stash.id === id) ?? null;

  /** The files of `stash`, read once per SHA; a read that failed is tried
   *  again next time. */
  const filesOf = async (stash: StashListItem): Promise<StashFile[] | null> => {
    let load = stashFiles.get(stash.hash);
    if (load === undefined) {
      load = loadStashFiles(deps.stash.git, repo, stash.hash).catch(() => null);
      stashFiles.set(stash.hash, load);
    }
    const files = await load;
    if (files === null && stashFiles.get(stash.hash) === load) stashFiles.delete(stash.hash);
    return files;
  };

  // A filter written anywhere — this view, the graph's filter chip, a locate —
  // moves the highlight, and the dimming with it: the filter exempts what it
  // holds from hiding.
  const filterSub = deps.filterStore.onDidChangeFilter((change) => {
    if (change.repo === repo) void readBranches();
  });

  /** The remote a request names, as it was listed: the URL its Edit starts
   *  from is the one the view showed. */
  const listed = (name: string): RemoteTarget | null => {
    const remote = remotes?.find((r) => r.name === name);
    return remote === undefined ? null : { repo, name, fetchUrl: remote.fetchUrl };
  };

  const remoteActions: Record<
    Extract<SideViewRequest, { command: "sideViewRemote" }>["action"],
    (target: RemoteTarget) => PromiseLike<void>
  > = {
    fetch: (target) => deps.fetchRemote(target.repo, target.name),
    editUrl: (target) => deps.remoteCommands.editUrl(target),
    rename: (target) => deps.remoteCommands.rename(target),
    remove: (target) => deps.remoteCommands.remove(target),
    copyUrl: (target) => deps.clipboard.writeText(target.fetchUrl)
  };

  const receive = async (message: SideViewRequest): Promise<void> => {
    switch (message.command) {
      case "sideViewReady":
        listening = true;
        send();
        stashWatch.setVisible(true);
        await refresh();
        break;
      case "sideViewRefresh":
        await refresh(true);
        break;
      case "sideViewToggle": {
        const state = deps.repoSource.getRepos()[repo];
        if (state === undefined) return;
        const next = !toggles()[message.field];
        // Redraws through `repoStateWritten`, which the drawer's writes take
        // too; the broadcast reaches the drawer, which draws from it.
        deps.repoSource.updateRepoState(repo, { [message.field]: next });
        if (message.field === "showRemoteBranches") deps.setShowRemoteBranches(next);
        break;
      }
      case "sideViewSetFilter":
        // Only its own repository's: a page is not to be taken at its word.
        if (message.repo !== repo) break;
        filterSeq = message.seq;
        // A filter that moved is read again, and sent with this number; one
        // that did not still owes the page word that its ask was taken.
        if (!deps.filterStore.set(repo, message.branches)) send();
        break;
      case "sideViewNoTargets":
        void deps.prompts.showInformation(batchNoTargetsMessage(l10n, message.skipped));
        break;
      case "sideViewAddRemote":
        await deps.remoteCommands.add(repo);
        break;
      case "sideViewManagePullRequestProviders":
        deps.managePullRequestProviders();
        break;
      case "sideViewRemote": {
        const target = listed(message.name);
        if (target !== null) await remoteActions[message.action](target);
        break;
      }
      case "sideViewStash": {
        // Bound to the stash as listed: core refuses it once that moved.
        const stash = listedStash(message.id);
        if (stash === null) break;
        // `cmv.stash.*` is not checked again here: the page leaves a hidden
        // action off its menu, and VS Code's stash commands do not check it
        // either — the setting hides an action, it does not forbid it.
        await LISTED_STASH_ACTIONS[message.action](stashHost, stash);
        // Settles once the list the action asked for — or a newer one — is
        // sent: the page is not left on the list from before it.
        await stashesSent();
        break;
      }
      case "sideViewStashFiles": {
        const stash = listedStash(message.id);
        if (stash === null) break;
        const files = await filesOf(stash);
        if (listening) {
          deps.post({
            command: "sideViewStashFiles",
            repo,
            id: message.id,
            files: files?.map(fileRow) ?? null
          });
        }
        break;
      }
      case "sideViewStashDiff": {
        const stash = listedStash(message.id);
        const file =
          stash === null
            ? undefined
            : (await filesOf(stash))?.find((f) => f.diff.newFilePath === message.path);
        if (file === undefined) break;
        if (!(await deps.openCommitDiff(file.diff))) {
          void deps.stash.prompts.showError(l10n.t("error.unableToViewDiff"));
        }
        break;
      }
    }
  };

  return {
    receive,
    refresh: () => void refresh(),
    settingChanged: () => void readBranches(),
    repoStateWritten: (before, after) => {
      if (sideViewStateChanged(before, after)) void readBranches();
    },
    pageLoading: () => {
      listening = false;
      stashWatch.setVisible(false);
      // The new page counts its asks from 1 again.
      filterSeq = 0;
    },
    showAll: (requested) => {
      if (showAllRepo(repo, requested) !== null) deps.filterStore.set(repo, []);
    },
    dispose: () => {
      listening = false;
      stashWatch.dispose();
      filterSub.dispose();
    }
  };
}
