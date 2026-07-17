import type { GitCommitDetails, GitCommitNode, GitFileChange } from "@/backend/types";
import * as GG from "@/types";

declare global {
  function acquireVsCodeApi(): {
    // The real VS Code API yields undefined when no state was saved; tests'
    // mock yields null. Treat both as "no saved state".
    getState(): WebViewState | null | undefined;
    postMessage(message: GG.RequestMessage): void;
    setState(state: WebViewState): void;
  };

  var viewState: GG.GitGraphViewState;

  interface Config {
    autoCenterCommitDetailsView: boolean;
    commitDetailsViewLocation: "Inline" | "Docked to Bottom";
    branchLabelsAlignedToGraph: boolean;
    tagLabelsRightAligned: boolean;
    combineLocalAndRemoteBranchLabels: boolean;
    dialogDeleteBranchForceDelete: boolean;
    dialogCherryPickNoCommit: boolean;
    dialogAddTagType: "annotated" | "lightweight";
    dialogCreateBranchCheckOut: boolean;
    dialogMergeNoFastForward: boolean;
    dialogMergeSquash: boolean;
    dialogResetMode: "soft" | "mixed" | "hard";
    customBranchGlobPatterns: { name: string; glob: string }[];
    customEmojiShortcodeMappings: { [code: string]: string };
    enhancedAccessibility: boolean;
    fetchAvatars: boolean;
    fileTreeCompactFolders: boolean;
    fileViewType: "File Tree" | "File List";
    graphColours: string[];
    graphStyle: "rounded" | "angular";
    grid: { x: number; y: number; offsetX: number; offsetY: number; expandY: number };
    initialLoadCommits: number;
    loadMoreAutomatically: boolean;
    loadMoreCommits: number;
    markdown: boolean;
    issueLinkingRegex: string;
    issueLinkingUrl: string;
    muteCommitsNotAncestorsOfHead: boolean;
    muteMergeCommits: boolean;
    onLoadScrollToHead: boolean;
    showCurrentBranchByDefault: boolean;
    uncommittedChangesAtHead: boolean;
    showSpecificBranches: string[];
    showRemoteBranches: boolean;
    showTags: boolean;
  }

  interface ContextMenuItem {
    title: string;
    onClick: () => void;
    /** When false, the item is hidden (contextMenuActionsVisibility). */
    visible?: boolean;
  }

  type ContextMenuElement = ContextMenuItem | null;

  interface DialogTextInput {
    type: "text";
    name: string;
    default: string;
    placeholder: string | null;
  }
  interface DialogTextRefInput {
    type: "text-ref";
    name: string;
    default: string;
  }
  interface DialogSelectInput {
    type: "select";
    name: string;
    options: { name: string; value: string }[];
    default: string;
    /** When true, this option is included in the dialog's "Remember my choice"
     *  memory. Ignored unless the dialog is opened with a rememberKey. */
    remember?: boolean;
  }
  interface DialogCheckboxInput {
    type: "checkbox";
    name: string;
    value: boolean;
    /** See DialogSelectInput.remember. */
    remember?: boolean;
  }
  type DialogInput = DialogTextInput | DialogTextRefInput | DialogSelectInput | DialogCheckboxInput;
  type DialogInputValue = string | boolean;

  interface ExpandedCommit {
    id: number;
    hash: string;
    srcElem: HTMLElement | null;
    commitDetails: GitCommitDetails | null;
    fileTree: GitFolder | null;
    /** When comparing two commits: the other commit's hash / row, the
     *  resolved older→newer order, and the diff between them. NULL otherwise. */
    compareWithHash: string | null;
    compareWithSrcElem: HTMLElement | null;
    compareFromHash: string | null;
    compareToHash: string | null;
    compareFileChanges: GitFileChange[] | null;
  }

  interface GitFile {
    type: "file";
    name: string;
    index: number;
  }

  interface GitFolder {
    type: "folder";
    name: string;
    folderPath: string;
    /** Child folders/files keyed by path segment; a Map keeps insertion order. */
    children: Map<string, GitFolderOrFile>;
    open: boolean;
  }

  type GitFolderOrFile = GitFolder | GitFile;

  /** JSON-safe form of GitFolder as persisted in WebViewState: vscode.setState
   *  JSON-serializes the state, which would collapse a Map to {}. */
  interface SerializedGitFolder {
    type: "folder";
    name: string;
    folderPath: string;
    children: (SerializedGitFolder | GitFile)[];
    open: boolean;
  }

  /** ExpandedCommit as persisted in WebViewState: DOM references are dropped
   *  (they are re-bound to the freshly rendered rows on restore) and the file
   *  tree is stored in its serialized form. */
  interface SerializedExpandedCommit extends Omit<
    ExpandedCommit,
    "srcElem" | "compareWithSrcElem" | "fileTree"
  > {
    fileTree: SerializedGitFolder | null;
  }

  interface Point {
    x: number;
    y: number;
  }
  interface Line {
    p1: Point;
    p2: Point;
    lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
  }

  interface Pixel {
    x: number;
    y: number;
  }
  interface PlacedLine {
    p1: Pixel;
    p2: Pixel;
    isCommitted: boolean;
    lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
  }

  type AvatarImageCollection = { [email: string]: string };

  interface WebViewState {
    gitRepos: GG.GitRepoSet;
    gitBranches: string[];
    gitBranchHead: string | null;
    // Optional: absent in states saved by versions that didn't persist remotes.
    remotes?: string[];
    pushDefault?: string | null;
    commits: GitCommitNode[];
    commitHead: string | null;
    avatars: AvatarImageCollection;
    currentBranches: string[] | null;
    currentRepo: string;
    moreCommitsAvailable: boolean;
    maxCommits: number;
    showRemoteBranches: boolean;
    expandedCommit: SerializedExpandedCommit | null;
    columnVisibility: { date: boolean; author: boolean; commit: boolean };
    alwaysAcceptCheckoutCommit: boolean;
  }
}

export as namespace GG;
export = GG;
