import {
  ActionRequest,
  ActionResponse,
  CommitOrdering,
  GitFileChangeType,
  QueryRequest,
  QueryResponse
} from "@/backend/types";

/** A configurable keyboard shortcut, normalised to a lowercase key char, or
 *  null when the shortcut is set to "UNASSIGNED". */
export type KeybindingConfig = {
  find: string | null;
  refresh: string | null;
  scrollToHead: string | null;
  scrollToStash: string | null;
};
/** Per-action visibility of context-menu items: each action maps to a
 *  boolean; false hides it. */
export type ContextMenuActionsVisibility = {
  commit: {
    addTag: boolean;
    createBranch: boolean;
    checkout: boolean;
    cherrypick: boolean;
    revert: boolean;
    merge: boolean;
    reset: boolean;
    rebase: boolean;
    drop: boolean;
    copyHash: boolean;
    copySubject: boolean;
  };
  branch: {
    checkout: boolean;
    rename: boolean;
    push: boolean;
    createArchive: boolean;
    delete: boolean;
    merge: boolean;
    rebase: boolean;
    copyName: boolean;
  };
  remoteBranch: {
    checkout: boolean;
    merge: boolean;
    pull: boolean;
    fetch: boolean;
    delete: boolean;
    copyName: boolean;
  };
  tag: {
    viewDetails: boolean;
    delete: boolean;
    push: boolean;
    createArchive: boolean;
    copyName: boolean;
  };
  stash: {
    apply: boolean;
    pop: boolean;
    drop: boolean;
    copyName: boolean;
  };
  uncommittedChanges: {
    openSourceControlView: boolean;
    reset: boolean;
    clean: boolean;
  };
  commitDetailsViewFile: {
    viewDiff: boolean;
    viewFileAtThisRevision: boolean;
    viewDiffWithWorkingFile: boolean;
    openFile: boolean;
    resetFileToThisRevision: boolean;
    copyFilePath: boolean;
  };
};

export type RefSpaceSubstitution = "None" | "Hyphen" | "Underscore";
export type FileViewType = "File Tree" | "File List";

export type GitRepoSet = { [repo: string]: GitRepoState };
export type GitRepoState = {
  columnWidths: number[] | null;
  /** Per-repo commit-ordering override; null/undefined uses the global setting. */
  commitOrdering?: CommitOrdering | null;
  /** Per-repo "Show Remote Branches" override; null/undefined uses the global setting. */
  showRemoteBranches?: boolean | null;
  /** Per-repo "Show Inactive Branches" override in the side-view; null/undefined
   *  uses the global default. */
  showInactiveBranches?: boolean | null;
  /** Custom display name for the repo in the Repo dropdown; empty/unset
   *  falls back to the derived folder name. */
  customName?: string | null;
  /** Remote names whose branches are hidden in the graph. */
  hiddenRemotes?: string[];
  /** Per-repo Commit Details View file layout (tree/list) chosen via the
   *  panel's toolbar; null/undefined uses the global setting. */
  fileViewType?: FileViewType | null;
  /** Inline Commit Details View height in px; unset = the default 250. */
  detailsPanelHeight?: number | null;
  /** Inline Commit Details View summary/files split, 0–1; unset = 0.45. */
  detailsDivider?: number | null;
};

export type GitGraphViewState = {
  autoCenterCommitDetailsView: boolean;
  commitDetailsViewLocation: "Inline" | "Docked to Bottom";
  referenceLabelAlignment:
    | "Normal"
    | "Branches (on the left) & Tags (on the right)"
    | "Branches (aligned to the graph) & Tags (on the right)";
  combineLocalAndRemoteBranchLabels: boolean;
  dialogDeleteBranchForceDelete: boolean;
  dialogCherryPickNoCommit: boolean;
  dialogAddTagType: "annotated" | "lightweight";
  dialogCreateBranchCheckOut: boolean;
  dialogMergeNoFastForward: boolean;
  dialogMergeSquash: boolean;
  dialogResetMode: "soft" | "mixed" | "hard";
  /** Remembered "Remember my choice" values for option-bearing dialogs,
   *  injected at load so they can be applied before any dialog opens. */
  dialogMemory: DialogMemoryStore;
  contextMenuActionsVisibility: ContextMenuActionsVisibility;
  customBranchGlobPatterns: { name: string; glob: string }[];
  customEmojiShortcodeMappings: { [code: string]: string };
  dateFormat: DateFormat;
  dateCustomFormat: string;
  defaultColumnVisibility: { date: boolean; author: boolean; commit: boolean };
  enhancedAccessibility: boolean;
  fetchAvatars: boolean;
  fileTreeCompactFolders: boolean;
  fileViewType: FileViewType;
  graphColours: string[];
  graphStyle: GraphStyle;
  initialLoadCommits: number;
  issueLinkingRegex: string;
  issueLinkingUrl: string;
  keybindings: KeybindingConfig;
  lastActiveRepo: string | null;
  loadMoreAutomatically: boolean;
  loadMoreCommits: number;
  markdown: boolean;
  muteCommitsNotAncestorsOfHead: boolean;
  muteMergeCommits: boolean;
  onLoadScrollToHead: boolean;
  referenceInputSpaceSubstitution: RefSpaceSubstitution;
  repos: GitRepoSet;
  showCurrentBranchByDefault: boolean;
  uncommittedChangesAtHead: boolean;
  showSpecificBranches: string[];
  showRemoteBranches: boolean;
  showTags: boolean;
};

export type Avatar = {
  image: string;
  timestamp: number;
  identicon: boolean;
};
export type AvatarCache = { [email: string]: Avatar };

export type DateFormat =
  | "Date & Time"
  | "Date Only"
  | "Relative"
  | "ISO Date & Time"
  | "ISO Date Only";
export type GraphStyle = "rounded" | "angular";

/* Infrastructure Request / Response Messages */

export type RequestFetchAvatar = {
  command: "fetchAvatar";
  repo: string;
  email: string;
  commits: string[];
};
export type ResponseFetchAvatar = {
  command: "fetchAvatar";
  email: string;
  image: string;
};

export type RequestSelectRepo = {
  command: "selectRepo";
  repo: string;
};

export type RequestLoadRepos = {
  command: "loadRepos";
  check: boolean;
};
export type ResponseLoadRepos = {
  command: "loadRepos";
  repos: GitRepoSet;
  lastActiveRepo: string | null;
};

export type RequestSaveRepoState = {
  command: "saveRepoState";
  repo: string;
  state: GitRepoState;
};

/** Persisted "Remember my choice" values for option-bearing confirmation
 *  dialogs. Keyed by a stable dialog key, then by each remembered input's name.
 *  Values use the same encoding the dialog form produces: "checked"/"unchecked"
 *  for checkboxes, the option value for selects. */
export type DialogMemoryStore = { [dialogKey: string]: { [inputName: string]: string } };

export type RequestSaveDialogMemory = {
  command: "saveDialogMemory";
  dialogKey: string;
  /** The values to remember, or null to forget this dialog's choices. */
  values: { [inputName: string]: string } | null;
};

export type RequestCopyToClipboard = {
  command: "copyToClipboard";
  type: string;
  data: string;
};
export type ResponseCopyToClipboard = {
  command: "copyToClipboard";
  type: string;
  success: boolean;
};

export type RequestViewDiff = {
  command: "viewDiff";
  repo: string;
  commitHash: string;
  oldFilePath: string;
  newFilePath: string;
  type: GitFileChangeType;
  /** When comparing two commits, the base commit to diff against instead
   *  of `commitHash`'s first parent. */
  fromHash?: string;
};
export type ResponseViewDiff = {
  command: "viewDiff";
  success: boolean;
};

export type RequestOpenFile = {
  command: "openFile";
  repo: string;
  filePath: string;
  /** The commit the file was viewed from, used to follow renames. */
  commitHash?: string;
};
export type ResponseOpenFile = {
  command: "openFile";
  success: boolean;
};

export type RequestOpenTerminal = {
  command: "openTerminal";
  repo: string;
};

export type RequestOpenMergeEditor = {
  command: "openMergeEditor";
  repo: string;
  filePath: string;
};

export type RequestFetch = {
  command: "fetch";
  repo: string;
};
export type ResponseFetch = {
  command: "fetch";
  status: string | null;
};

export type RequestOpenExternalUrl = {
  command: "openExternalUrl";
  url: string;
};

/** Open the provider's pre-filled pull-request page for a branch. */
export type RequestCreatePullRequest = {
  command: "createPullRequest";
  repo: string;
  branchName: string;
  remote: string;
};

export type RequestOpenScmView = {
  command: "openScmView";
};

export type RequestViewFileAtRevision = {
  command: "viewFileAtRevision";
  repo: string;
  commitHash: string;
  filePath: string;
};
export type ResponseViewFileAtRevision = {
  command: "viewFileAtRevision";
  success: boolean;
};

export type RequestViewDiffWithWorking = {
  command: "viewDiffWithWorking";
  repo: string;
  commitHash: string;
  filePath: string;
};
export type ResponseViewDiffWithWorking = {
  command: "viewDiffWithWorking";
  success: boolean;
};

export type RequestCreateArchive = {
  command: "createArchive";
  repo: string;
  ref: string;
};
export type ResponseCreateArchive = {
  command: "createArchive";
  success: boolean;
};

export type RequestExportPatch = {
  command: "exportPatch";
  repo: string;
  commitHash: string;
};
export type ResponseExportPatch = {
  command: "exportPatch";
  success: boolean;
};

export type ResponseRefresh = {
  command: "refresh";
};

export type ResponseSetRepo = {
  command: "setRepo";
  repo: string;
};

/** Push a new branch filter into the graph (driven by the Branches side-view).
 *  An empty array means "show all branches". */
export type ResponseSetBranchFilter = {
  command: "setBranchFilter";
  branches: string[];
};

/** Push the "Show Remote Branches" state into the graph (driven by the Branches
 *  side-view's toggle, which is now the sole control). */
export type ResponseSetShowRemoteBranches = {
  command: "setShowRemoteBranches";
  value: boolean;
};

/** A branch action the Branches side-view delegates to the graph webview, so
 *  the exact same context-menu flow (dialogs included) runs there. */
export type RefAction =
  | "checkout"
  | "rename"
  | "delete"
  | "merge"
  | "rebase"
  | "fastForward"
  | "push"
  | "createArchive"
  | "createPullRequest"
  | "pull"
  | "fetchIntoLocal"
  | "deleteRemote";

export type ResponseRunRefAction = {
  command: "runRefAction";
  repo: string;
  /** Webview-format ref: "main" for local, "origin/feature" for remote
   *  (the "remotes/" prefix already stripped). */
  ref: string;
  isRemote: boolean;
  action: RefAction;
  /** Monotonic per-session sequence number. The webview ignores a message whose
   *  seq it has already executed, so the host may deliver the same action over
   *  two paths (direct post + post-reload flush) without it running twice. */
  seq: number;
};

export type RequestMessage =
  | ActionRequest
  | QueryRequest
  | RequestFetchAvatar
  | RequestSelectRepo
  | RequestLoadRepos
  | RequestSaveRepoState
  | RequestCopyToClipboard
  | RequestViewDiff
  | RequestOpenFile
  | RequestViewFileAtRevision
  | RequestViewDiffWithWorking
  | RequestOpenTerminal
  | RequestOpenMergeEditor
  | RequestOpenExternalUrl
  | RequestOpenScmView
  | RequestFetch
  | RequestCreateArchive
  | RequestExportPatch
  | RequestSaveDialogMemory
  | RequestCreatePullRequest;

export type ResponseMessage =
  | ActionResponse
  | QueryResponse
  | ResponseFetchAvatar
  | ResponseLoadRepos
  | ResponseCopyToClipboard
  | ResponseViewDiff
  | ResponseOpenFile
  | ResponseViewFileAtRevision
  | ResponseViewDiffWithWorking
  | ResponseFetch
  | ResponseCreateArchive
  | ResponseExportPatch
  | ResponseRefresh
  | ResponseSetRepo
  | ResponseSetBranchFilter
  | ResponseSetShowRemoteBranches
  | ResponseRunRefAction;
