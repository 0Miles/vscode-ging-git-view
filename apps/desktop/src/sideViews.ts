/* The host half of a Tab's Branches and Remotes side views (#399). The page
 * draws them (packages/webview/src/desktop/sideViews/); this reads what they
 * show through core, as VS Code's side views read it, and answers what they
 * ask. One per webview instance, on its one repository.
 *
 * What it does not do is delegate branch actions to the graph: the graph is
 * in the same page as the side view, which calls it directly (ADR-0033). So
 * there is no `branchActionDelegate` here, nothing held for a reload, and no
 * head guard — that is the page's, which holds the row. */

import { relativeAge } from "@ging/core/extension/branchActivity";
import type { BranchFacts } from "@ging/core/extension/branchFacts";
import { showAllRepo } from "@ging/core/extension/branchFilter";
import type { BranchFilterStore } from "@ging/core/extension/branchFilterStore";
import {
  batchNoTargetsMessage,
  resolveSideViewToggle,
  sideViewBranchRoots
} from "@ging/core/extension/branchSideView";
import type { RemoteCommands, RemoteTarget } from "@ging/core/extension/remoteCommands";
import { type SideViewField, sideViewStateChanged } from "@ging/core/extension/repoSettings";
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
  SideViewRemote,
  SideViewRequest,
  SideViewRowText,
  SideViewStateMessage,
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
  post(message: SideViewStateMessage): void;
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
  logger: Pick<HostLogger, "logError">;
  nowMs(): number;
};

export type SideViews = {
  /** What the page's side views asked. Settles once what it started has:
   *  the reads it asked for sent to the page, the command it ran finished. */
  receive(message: SideViewRequest): Promise<void>;
  /** Read both views again, as after anything that may move a ref. */
  refresh(): void;
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

export function createSideViews(deps: SideViewsDeps): SideViews {
  const { repo, l10n, config } = deps;

  let listening = false;
  let branches: SideViewBranches | null = null;
  let remotes: SideViewRemote[] | null = null;
  // Guards against a slower earlier read overwriting a later one.
  let branchesRead = 0;
  let remotesRead = 0;

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

  const strings = (): SideViewStrings => {
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
      copyUrl: t("desktop.sideView.copyUrl")
    };
  };

  const send = () => {
    if (!listening) return;
    deps.post({
      command: "sideViewState",
      repo,
      branches,
      remotes,
      cmv: config.contextMenuActionsVisibility(),
      strings: strings()
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

  const refresh = async (hard = false) => {
    await Promise.all([readBranches(hard), readRemotes()]);
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
        if (message.repo === repo) deps.filterStore.set(repo, message.branches);
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
    }
  };

  return {
    receive,
    refresh: () => void refresh(),
    repoStateWritten: (before, after) => {
      if (sideViewStateChanged(before, after)) void readBranches();
    },
    pageLoading: () => {
      listening = false;
    },
    showAll: (requested) => {
      if (showAllRepo(repo, requested) !== null) deps.filterStore.set(repo, []);
    },
    dispose: () => {
      listening = false;
      filterSub.dispose();
    }
  };
}
