import * as fs from "node:fs";

import * as vscode from "vscode";

import { AvatarManager } from "@/avatarManager";
import { createArchive } from "@/backend/actions/archive";
import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  deleteBranches,
  deleteRemoteBranch,
  fastForwardBranch,
  fastForwardBranches,
  fetchIntoLocalBranch,
  pullBranch,
  pushBranch,
  pushBranches,
  renameBranch
} from "@/backend/actions/branch";
import {
  checkoutCommit,
  cherrypickCommit,
  dropCommit,
  resetFileToRevision,
  resetToCommit,
  revertCommit
} from "@/backend/actions/commit";
import { fetchFromRemotes } from "@/backend/actions/fetch";
import { mergeBranch, mergeCommit } from "@/backend/actions/merge";
import { abortOperation, continueOperation, markResolved } from "@/backend/actions/operation";
import { exportPatch } from "@/backend/actions/patch";
import { rebaseOn, rebaseOnto } from "@/backend/actions/rebase";
import { getRemoteUrl } from "@/backend/actions/remote";
import { applyStash, dropStash, popStash, renameStash } from "@/backend/actions/stash";
import { addTag, deleteTag, pushTag } from "@/backend/actions/tag";
import { cleanUntrackedFiles, resetUncommittedChanges } from "@/backend/actions/workingTree";
import { GitClient } from "@/backend/gitClient";
import { checkBranchRedundancy } from "@/backend/queries/branchRedundancy";
import { loadBranchSearchIndex } from "@/backend/queries/branchSearch";
import { commitDetails } from "@/backend/queries/commitDetails";
import { compareCommits } from "@/backend/queries/compareCommits";
import { loadCommits } from "@/backend/queries/loadCommits";
import { loadRemotes } from "@/backend/queries/loadRemotes";
import { operationState } from "@/backend/queries/operationState";
import { predictConflicts } from "@/backend/queries/predictConflicts";
import { getNewPathOfRenamedFile } from "@/backend/queries/renamedFilePath";
import { tagDetails } from "@/backend/queries/tagDetails";
import type {
  ActionResponseExtra,
  BatchActionRequest,
  BatchRefResult,
  BranchSearchEntry
} from "@/backend/types";
import { GitFileChangeType } from "@/backend/types";
import { formatGitError, isNotFullyMergedError } from "@/backend/utils/gitError";
import { parseRemoteUrl, pullRequestCreateUrl } from "@/backend/utils/pullRequest";
import { abbrevCommit } from "@/backend/utils/string";
import { Config } from "@/config";
import { encodeDiffDocUri } from "@/diffDocProvider";
import { copyToClipboard } from "@/extension/utils/clipboard";
import { ExtensionState } from "@/extensionState";
import * as l10n from "@/l10n";
import { RepoFileWatcher } from "@/repoFileWatcher";
import { RequestMessage, ResponseMessage } from "@/types";

import { resolveCleanupCandidates } from "./branchCleanup";
import { type BranchCleanup } from "./branchCleanupService";
import { type BranchFacts } from "./branchFacts";
import { BranchFilterStore } from "./branchFilterStore";
import { type Logger } from "./logger";
import { RepoManager } from "./repoManager";
import { WebviewBridge } from "./webviewBridge";
import { createWebviewErrorSink } from "./webviewErrorSink";

function viewDiff(
  repo: string,
  commitHash: string,
  oldFilePath: string,
  newFilePath: string,
  type: GitFileChangeType,
  viewColumn: vscode.ViewColumn,
  // When comparing two commits, diff against `fromHash` instead of the
  // commit's first parent; otherwise the left side is `commitHash^`.
  fromHash?: string
): Promise<boolean> {
  const abbrevHash = abbrevCommit(commitHash);
  const leftRev = fromHash !== undefined ? fromHash : commitHash + "^";
  const pathComponents = newFilePath.split("/");
  const title =
    pathComponents[pathComponents.length - 1] +
    " (" +
    (type === "A"
      ? l10n.t("diff.addedIn", abbrevHash)
      : type === "D"
        ? l10n.t("diff.deletedIn", abbrevHash)
        : (fromHash !== undefined ? abbrevCommit(fromHash) : abbrevCommit(commitHash) + "^") +
          " ↔ " +
          abbrevCommit(commitHash)) +
    ")";
  return new Promise<boolean>((resolve) => {
    vscode.commands
      .executeCommand(
        "vscode.diff",
        encodeDiffDocUri(repo, oldFilePath, leftRev),
        encodeDiffDocUri(repo, newFilePath, commitHash),
        title,
        { preview: true, viewColumn }
      )
      .then(
        () => resolve(true),
        () => resolve(false)
      );
  });
}

export function registerMessageHandlers(
  bridge: WebviewBridge,
  deps: {
    config: Config;
    gitClient: GitClient;
    repoManager: RepoManager;
    extensionState: ExtensionState;
    avatarManager: AvatarManager;
    repoFileWatcher: RepoFileWatcher;
    branchFilterStore: BranchFilterStore;
    /** The shared classification facts, consumed by `loadBranches` and by the
     *  Branches side-view alike. */
    branchFacts: BranchFacts;
    /** Builds the cleanup dialog's payload. Shared with the side-view command,
     *  which opens the same dialog from the other direction (ADR-0017). */
    branchCleanup: BranchCleanup;
    /** The repo's "show remote branches" state. The webview no longer sends its
     *  own copy: it was a one-way echo of this and could only be staler. */
    resolveShowRemote: (repo: string) => boolean;
    /** The GING Output Channel, which is also where the webview's own failures
     *  are written down (ADR-0016). */
    logger: Logger;
    /** Called when the webview switches repo, so the Branches side-view can
     *  follow the same repo. */
    onSelectRepo: (repo: string) => void;
  }
) {
  const {
    config,
    gitClient,
    repoManager,
    extensionState,
    avatarManager,
    repoFileWatcher,
    branchFilterStore,
    branchFacts,
    branchCleanup,
    resolveShowRemote,
    logger,
    onSelectRepo
  } = deps;

  let currentRepo: string | null = null;

  // Push filter changes (from the side-view / "Show All") into the graph, but
  // only those for the repo this panel is showing.
  const filterSub = branchFilterStore.onDidChangeFilter(({ repo, branches }) => {
    if (repo === currentRepo) bridge.post({ command: "setBranchFilter", branches });
  });

  function registerAction<T extends RequestMessage["command"]>(
    command: T,
    handler: (msg: Extract<RequestMessage, { command: T }>) => Promise<void>,
    /** Response fields beyond `status`, derived from the raw error the handler
     *  threw (null when it succeeded). Classification that needs git's full
     *  output belongs here: `status` is only the one line `formatGitError`
     *  picked out, so markers on any other line are gone by the time the
     *  webview sees it. Required for the actions that declare extras, absent
     *  for the rest — the response is posted through a cast, so this parameter
     *  is what keeps a declared field from being silently dropped. */
    ...classify: [ActionResponseExtra<T>] extends [never]
      ? []
      : [(error: unknown) => ActionResponseExtra<T>]
  ) {
    const [classifyError] = classify as [((error: unknown) => object) | undefined];
    bridge.onMessage(
      command,
      async (msg) => {
        let status: string | null = null;
        let error: unknown = null;
        try {
          await handler(msg);
        } catch (e: unknown) {
          error = e;
          status = formatGitError(e);
        }
        bridge.post({ command, status, ...classifyError?.(error) } as ResponseMessage);
      },
      { mutatesRepo: true }
    );
  }

  /** The batch counterpart of `registerAction`. It cannot reuse that wrapper:
   *  that one collapses the outcome into a single `status`, whereas a batch's
   *  whole point is that each ref succeeds or fails on its own. The batch
   *  actions therefore never throw — they report per ref. */
  function registerBatchAction<T extends BatchActionRequest["command"]>(
    command: T,
    handler: (msg: Extract<RequestMessage, { command: T }>) => Promise<BatchRefResult[]>
  ) {
    bridge.onMessage(
      command,
      async (msg) => {
        const results = await handler(msg);
        bridge.post({ command, results } as ResponseMessage);
      },
      { mutatesRepo: true }
    );
  }

  // --- Action handlers ---

  registerAction("addTag", (msg) => addTag(gitClient.getInstance(), msg, config.signTags()));
  registerAction("deleteTag", (msg) => deleteTag(gitClient.getInstance(), msg));
  registerAction("pushTag", (msg) => pushTag(gitClient.getInstance(), msg));
  registerAction("createBranch", (msg) => createBranch(gitClient.getInstance(), msg));
  registerAction(
    "deleteBranch",
    (msg) => deleteBranch(gitClient.getInstance(), msg),
    (error) => ({ notFullyMerged: isNotFullyMergedError(error) })
  );
  registerAction("deleteRemoteBranch", (msg) => deleteRemoteBranch(gitClient.getInstance(), msg));

  registerBatchAction("deleteBranches", (msg) => deleteBranches(gitClient.getInstance(), msg));
  registerBatchAction("pushBranches", (msg) => pushBranches(gitClient.getInstance(), msg));
  registerBatchAction("fastForwardBranches", (msg) =>
    fastForwardBranches(gitClient.getInstance(), msg)
  );
  registerAction("fetchIntoLocalBranch", (msg) =>
    fetchIntoLocalBranch(gitClient.getInstance(), msg)
  );
  registerAction("pushBranch", (msg) => pushBranch(gitClient.getInstance(), msg));
  registerAction("pullBranch", (msg) => pullBranch(gitClient.getInstance(), msg));
  registerAction("renameBranch", (msg) => renameBranch(gitClient.getInstance(), msg));
  registerAction("checkoutBranch", (msg) => checkoutBranch(gitClient.getInstance(), msg));
  registerAction("checkoutCommit", (msg) => checkoutCommit(gitClient.getInstance(), msg));
  registerAction("cherrypickCommit", (msg) =>
    cherrypickCommit(gitClient.getInstance(), msg, config.signCommits())
  );
  registerAction("dropCommit", (msg) => dropCommit(gitClient.getInstance(), msg));
  registerAction("resetFileToRevision", (msg) => resetFileToRevision(gitClient.getInstance(), msg));
  registerAction("revertCommit", (msg) =>
    revertCommit(gitClient.getInstance(), msg, config.signCommits())
  );
  registerAction("resetToCommit", (msg) => resetToCommit(gitClient.getInstance(), msg));
  registerAction("mergeBranch", (msg) =>
    mergeBranch(
      gitClient.getInstance(),
      msg,
      config.squashMergeMessageFormat(),
      config.signCommits()
    )
  );
  registerAction("mergeCommit", (msg) =>
    mergeCommit(
      gitClient.getInstance(),
      msg,
      config.squashMergeMessageFormat(),
      config.signCommits()
    )
  );
  registerAction("rebaseOn", (msg) => rebaseOn(gitClient.getInstance(), msg, config.signCommits()));
  registerAction("rebaseOnto", (msg) =>
    rebaseOnto(gitClient.getInstance(), msg, config.signCommits())
  );
  registerAction("applyStash", (msg) => applyStash(gitClient.getInstance(), msg));
  registerAction("popStash", (msg) => popStash(gitClient.getInstance(), msg));
  registerAction("dropStash", (msg) => dropStash(gitClient.getInstance(), msg));
  registerAction("renameStash", (msg) => renameStash(gitClient.getInstance(), msg));
  registerAction("fastForwardBranch", (msg) => fastForwardBranch(gitClient.getInstance(), msg));
  registerAction("resetUncommittedChanges", () => resetUncommittedChanges(gitClient.getInstance()));
  registerAction("cleanUntrackedFiles", () => cleanUntrackedFiles(gitClient.getInstance()));
  registerAction("continueOperation", () => continueOperation(gitClient.getInstance()));
  registerAction("abortOperation", () => abortOperation(gitClient.getInstance()));
  registerAction("markResolved", (msg) => markResolved(gitClient.getInstance(), msg));

  // --- Query handlers ---

  bridge.onMessage(
    "branchSearch",
    async (msg) => {
      let branches: BranchSearchEntry[] = [];
      let status: string | null = null;
      try {
        ({ branches } = await loadBranchSearchIndex(gitClient.getInstance(), {
          branchNames: msg.branchNames,
          showRemoteBranches: resolveShowRemote(currentRepo!),
          commitOrder: msg.commitOrder ?? config.commitOrder(),
          onlyFollowFirstParent: config.onlyFollowFirstParent(),
          showCommitsOnlyReferencedByTags: config.showCommitsOnlyReferencedByTags(),
          includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs(),
          hiddenRemotes: msg.hiddenRemotes ?? []
        }));
      } catch (error: unknown) {
        status = formatGitError(error);
      }
      bridge.post({
        command: "branchSearch",
        branches,
        token: msg.token,
        status
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "loadCommits",
    async (msg) => {
      bridge.post({
        command: "loadCommits",
        ...(await loadCommits(gitClient.getInstance(), {
          branchNames: msg.branchNames,
          maxCommits: msg.maxCommits,
          showRemoteBranches: resolveShowRemote(currentRepo!),
          hard: msg.hard,
          dateType: config.dateType(),
          showUncommittedChanges: config.showUncommittedChanges(),
          // A per-repo override (from the column-header menu) wins over the setting.
          commitOrder: msg.commitOrder ?? config.commitOrder(),
          onlyFollowFirstParent: config.onlyFollowFirstParent(),
          showUntrackedFiles: config.showUntrackedFiles(),
          showCommitsOnlyReferencedByTags: config.showCommitsOnlyReferencedByTags(),
          showRemoteHeads: config.showRemoteHeads(),
          includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs(),
          showSignatureStatus: config.showSignatureStatus(),
          showStashes: config.showStashes(),
          useMailmap: config.useMailmap(),
          hiddenRemotes: msg.hiddenRemotes ?? []
        }))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "loadBranches",
    async (msg) => {
      // The side-view reads the very same facts, so the two surfaces cannot
      // reach different verdicts — the filter resolution and seeding, the
      // exemptions and the merged classification all live in one place now
      // (ADR-0013). `hard` is the user asking for a real read, so it bypasses
      // the coalescing window.
      const facts = await branchFacts.facts(currentRepo!, { hard: msg.hard });
      bridge.post({
        command: "loadBranches",
        branches: [...facts.branches],
        head: facts.head,
        hard: msg.hard,
        isRepo: facts.isRepo,
        filter: facts.filter,
        // Only the merged half of `hidable` reaches the graph: inactivity is a
        // side-view noise-reduction concept, and the graph hides nothing.
        dimmedBranches: [...facts.merged.hidable],
        // The candidate set does carry inactive branches, but purely to gate one
        // context-menu item — the graph still neither dims nor hides them
        // (ADR-0017).
        cleanupCandidates: resolveCleanupCandidates({
          branches: facts.branches,
          head: facts.head,
          defaultBranch: facts.defaultBranch,
          dates: facts.dates,
          merged: facts.merged,
          inactive: facts.inactive,
          patterns: config.inactiveBranchAlwaysShow()
        }).candidates.map((c) => c.ref)
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "loadRemotes",
    async () => {
      bridge.post({
        command: "loadRemotes",
        ...(await loadRemotes(gitClient.getInstance()))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "operationState",
    async () => {
      // Like loadBranches/loadCommits, this reads the gitClient's current repo
      // (switched by the selectRepo message), so msg.repo is unused here.
      bridge.post({
        command: "operationState",
        ...(await operationState(gitClient.getInstance()))
      });
    },
    { mutatesRepo: false }
  );

  // Writes the archive file — often into the watched working tree.
  bridge.onMessage(
    "createArchive",
    async (msg) => {
      let success = true;
      try {
        const safeRef = msg.ref.replace(/[^a-zA-Z0-9-_.]/g, "-");
        const uri = await vscode.window.showSaveDialog({
          saveLabel: l10n.t("action.createArchive"),
          filters: { Archives: ["zip", "tar"] },
          defaultUri: vscode.Uri.file(`${msg.repo}/${safeRef}.zip`)
        });
        // No uri means the user cancelled — not an error.
        if (uri !== undefined) {
          await createArchive(gitClient.getInstance(), { ref: msg.ref, outputPath: uri.fsPath });
        }
      } catch {
        success = false;
      }
      bridge.post({ command: "createArchive", success });
    },
    { mutatesRepo: true }
  );

  // Writes the patch file — often into the watched working tree.
  bridge.onMessage(
    "exportPatch",
    async (msg) => {
      let success = true;
      try {
        const uri = await vscode.window.showSaveDialog({
          saveLabel: l10n.t("action.exportPatch"),
          filters: { Patches: ["patch"] },
          defaultUri: vscode.Uri.file(`${msg.repo}/${abbrevCommit(msg.commitHash)}.patch`)
        });
        // No uri means the user cancelled — not an error.
        if (uri !== undefined) {
          await exportPatch(gitClient.getInstance(), {
            commitHash: msg.commitHash,
            outputPath: uri.fsPath
          });
        }
      } catch {
        success = false;
      }
      bridge.post({ command: "exportPatch", success });
    },
    { mutatesRepo: true }
  );

  bridge.onMessage(
    "tagDetails",
    async (msg) => {
      bridge.post({
        command: "tagDetails",
        ...(await tagDetails(gitClient.getInstance(), { tagName: msg.tagName }))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "commitDetails",
    async (msg) => {
      bridge.post({
        command: "commitDetails",
        ...(await commitDetails(gitClient.getInstance(), {
          commitHash: msg.commitHash,
          useMailmap: config.useMailmap(),
          isStash: msg.isStash
        }))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "compareCommits",
    async (msg) => {
      bridge.post({
        command: "compareCommits",
        fromHash: msg.fromHash,
        toHash: msg.toHash,
        ...(await compareCommits(gitClient.getInstance(), {
          fromHash: msg.fromHash,
          toHash: msg.toHash
        }))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "branchRedundancy",
    async (msg) => {
      bridge.post({
        command: "branchRedundancy",
        branch: msg.branch,
        token: msg.token,
        result: await checkBranchRedundancy(gitClient.getInstance(), {
          branch: msg.branch,
          useMailmap: config.useMailmap(),
          dateType: config.dateType()
        })
      });
    },
    { mutatesRepo: false }
  );

  // Bumped by every cancel, and read between a scan's branches so the dialog's
  // Stop button lands without waiting for the whole scan. A generation rather
  // than a boolean so a cancel that arrives with no scan running cannot go on to
  // kill the next one.
  let cleanupScanGeneration = 0;

  bridge.onMessage(
    "branchCleanupOpen",
    async (msg) => {
      let fetchFailed = false;
      if (msg.fetch) {
        try {
          await fetchFromRemotes(gitClient.getInstance(), {
            prune: config.fetchAndPrune(),
            pruneTags: config.fetchAndPruneTags()
          });
        } catch {
          // Report it and answer anyway: a pre-fetch list the user knows is
          // pre-fetch beats an error dialog that leaves them with nothing.
          fetchFailed = true;
        }
      }
      // `hard` after a fetch because the refs just moved; also on a plain open,
      // where the user asked for this answer now.
      const built = await branchCleanup.build(msg.repo, { hard: true });
      bridge.post({
        command: "branchCleanupOpen",
        token: msg.token,
        payload: built.payload,
        fetchFailed
      });
    },
    { mutatesRepo: true }
  );

  bridge.onMessage(
    "branchCleanupScan",
    async (msg) => {
      const startedAt = cleanupScanGeneration;
      const { payload, cancelled } = await branchCleanup.scan(msg.repo, {
        isCancelled: () => cleanupScanGeneration !== startedAt,
        onProgress: (done, total) =>
          bridge.post({ command: "branchCleanupScanProgress", token: msg.token, done, total })
      });
      bridge.post({ command: "branchCleanupScan", token: msg.token, payload, cancelled });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "branchCleanupScanCancel",
    () => {
      cleanupScanGeneration++;
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "redundancyCommitDetails",
    async (msg) => {
      bridge.post({
        command: "redundancyCommitDetails",
        commitHash: msg.commitHash,
        ...(await commitDetails(gitClient.getInstance(), {
          commitHash: msg.commitHash,
          useMailmap: config.useMailmap()
        }))
      });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "predictConflicts",
    async (msg) => {
      bridge.post({
        command: "predictConflicts",
        token: msg.token,
        ...(await predictConflicts(gitClient.getInstance(), {
          ours: msg.ours,
          theirs: msg.theirs
        }))
      });
    },
    { mutatesRepo: false }
  );

  // --- Infrastructure handlers ---

  bridge.onMessage(
    "selectRepo",
    (msg) => {
      if (msg.repo === currentRepo) return;
      currentRepo = msg.repo;
      gitClient.setRepo(msg.repo);
      extensionState.setLastActiveRepo(msg.repo);
      repoFileWatcher.start(msg.repo);
      onSelectRepo(msg.repo);
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "loadRepos",
    async (msg) => {
      if (!msg.check || !(await repoManager.checkReposExist())) {
        bridge.post({
          command: "loadRepos",
          repos: repoManager.getRepos(),
          lastActiveRepo: extensionState.getLastActiveRepo()
        });
      }
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "fetchAvatar",
    (msg) => {
      avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.commits);
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "saveRepoState",
    (msg) => {
      repoManager.setRepoState(msg.repo, msg.state);
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "saveDialogMemory",
    (msg) => {
      extensionState.saveDialogMemory(msg.dialogKey, msg.values);
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "copyToClipboard",
    async (msg) => {
      bridge.post({
        command: "copyToClipboard",
        type: msg.type,
        success: await copyToClipboard(msg.data)
      });
    },
    { mutatesRepo: false }
  );

  // Updates remote refs (and prunes) in .git.
  bridge.onMessage(
    "fetch",
    async () => {
      let status: string | null = null;
      try {
        await fetchFromRemotes(gitClient.getInstance(), {
          prune: config.fetchAndPrune(),
          pruneTags: config.fetchAndPruneTags()
        });
      } catch (e: unknown) {
        status = formatGitError(e);
      }
      bridge.post({ command: "fetch", status });
    },
    { mutatesRepo: true }
  );

  bridge.onMessage(
    "openTerminal",
    (msg) => {
      const name = msg.repo.split("/").findLast((s) => s !== "") ?? msg.repo;
      const terminal = vscode.window.createTerminal({ cwd: msg.repo, name: `GING: ${name}` });
      terminal.show();
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "openExternalUrl",
    (msg) => {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "createPullRequest",
    async (msg) => {
      // Build the provider's pre-filled PR-create URL from the remote and open it
      // externally. With no provider for the remote's host, the error offers the
      // one thing that fixes it — configuring that very host — rather than
      // leaving the user to find the setting.
      const remoteUrl = await getRemoteUrl(gitClient.getInstance(), msg.remote);
      const remote = remoteUrl === "" ? null : remoteUrl;
      const url = pullRequestCreateUrl(remote, msg.branchName, config.pullRequestProviders());
      if (url !== null) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      const host = parseRemoteUrl(remote)?.host ?? null;
      const configure = l10n.t("pullRequest.configureProvider");
      const message =
        host !== null
          ? l10n.t("pullRequest.noProviderForHost", host)
          : l10n.t("pullRequest.unsupported");
      const choice = await vscode.window.showErrorMessage(
        message,
        ...(host !== null ? [configure] : [])
      );
      if (choice === configure) {
        void vscode.commands.executeCommand("ging-git-view.managePullRequestProviders", host);
      }
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "openScmView",
    () => {
      void vscode.commands.executeCommand("workbench.view.scm");
    },
    { mutatesRepo: false }
  );

  // The graph's filter chip clears the filter through the very command the
  // Branches side-view's title button runs. Writing `branchFilterStore` here
  // instead would only do half the job — the tree's visual selection would stay
  // highlighted while the graph showed everything.
  bridge.onMessage(
    "clearBranchFilter",
    () => {
      void vscode.commands.executeCommand("ging-git-view.branches.showAll");
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "openMergeEditor",
    (msg) => {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(msg.repo), msg.filePath);
      // The built-in git extension's 3-way merge editor; fall back to a plain
      // open if it (or the command) isn't available.
      void Promise.resolve(vscode.commands.executeCommand("git.openMergeEditor", uri)).then(
        undefined,
        () => vscode.commands.executeCommand("vscode.open", uri)
      );
    },
    { mutatesRepo: false }
  );

  // Resolve a file's current working-tree path: if it no longer exists at
  // `filePath` and was renamed since `commitHash`, follow the rename.
  async function resolveWorkingFilePath(
    repo: string,
    filePath: string,
    commitHash: string | undefined
  ): Promise<string> {
    if (commitHash === undefined || fs.existsSync(`${repo}/${filePath}`)) return filePath;
    const renamed = await getNewPathOfRenamedFile(gitClient.getInstance(), commitHash, filePath);
    return renamed ?? filePath;
  }

  bridge.onMessage(
    "openFile",
    async (msg) => {
      let success = true;
      try {
        const filePath = await resolveWorkingFilePath(msg.repo, msg.filePath, msg.commitHash);
        const uri = vscode.Uri.file(`${msg.repo}/${filePath}`);
        await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
      } catch {
        success = false;
      }
      bridge.post({ command: "openFile", success });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "viewDiffWithWorking",
    async (msg) => {
      let success = true;
      try {
        const workingFilePath = await resolveWorkingFilePath(
          msg.repo,
          msg.filePath,
          msg.commitHash
        );
        const components = workingFilePath.split("/");
        const title =
          components[components.length - 1] +
          " (" +
          abbrevCommit(msg.commitHash) +
          l10n.t("diff.workingTreeSep") +
          ")";
        await vscode.commands.executeCommand(
          "vscode.diff",
          encodeDiffDocUri(msg.repo, msg.filePath, msg.commitHash),
          vscode.Uri.file(`${msg.repo}/${workingFilePath}`),
          title,
          { preview: true }
        );
      } catch {
        success = false;
      }
      bridge.post({ command: "viewDiffWithWorking", success });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "viewFileAtRevision",
    async (msg) => {
      let success = true;
      try {
        // Open the file's content as of the given commit (read-only) via the diff
        // document provider, which resolves to `git show <commit>:<path>`.
        const uri = encodeDiffDocUri(msg.repo, msg.filePath, msg.commitHash);
        await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
      } catch {
        success = false;
      }
      bridge.post({ command: "viewFileAtRevision", success });
    },
    { mutatesRepo: false }
  );

  bridge.onMessage(
    "viewDiff",
    async (msg) => {
      // EditorGroup values are vscode.ViewColumn enum keys (Active, Beside, One..Nine).
      const viewColumn = vscode.ViewColumn[config.openNewTabEditorGroup()];
      bridge.post({
        command: "viewDiff",
        success: await viewDiff(
          msg.repo,
          msg.commitHash,
          msg.oldFilePath,
          msg.newFilePath,
          msg.type,
          viewColumn,
          msg.fromHash
        )
      });
    },
    { mutatesRepo: false }
  );

  // The webview's failures have nowhere else to go: it has no Output Channel of
  // its own, and its console is behind "Developer: Open Webview Developer
  // Tools", which no bug report ever comes from (ADR-0016).
  const reportWebviewError = createWebviewErrorSink({
    log: logger.logError,
    notify: async () => {
      const choice = await vscode.window.showErrorMessage(
        l10n.t("error.webviewFailed"),
        l10n.t("error.showLog")
      );
      if (choice !== undefined) logger.reveal();
    }
  });
  bridge.onMessage("reportError", (msg) => reportWebviewError(msg.report), { mutatesRepo: false });

  return {
    onPanelShown: () => {
      currentRepo = null;
    },
    dispose: () => filterSub.dispose()
  };
}
