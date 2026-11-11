import * as vscode from "vscode";

import type { GitRunOptions } from "@ging/core/backend/gitRun";
import type { GitCommandHandler } from "@ging/core/backend/gitSpawn";
import {
  type BlamedCommit,
  blameCommitChange,
  blameLineExcerpt,
  type CommitChange,
  type HunkExcerpt,
  hunkAt
} from "@ging/core/backend/queries/blameCommitChange";
import {
  BLAME_TIMEOUT_MS,
  type BlameLine,
  blameFile,
  readUserEmail
} from "@ging/core/backend/queries/blameFile";
import { findGitDirs, gitDirWatchPaths } from "@ging/core/backend/queries/gitDirs";
import { abbrevCommit } from "@ging/core/backend/utils/string";
import {
  type BlameAnnotationContext,
  blameAnnotationText
} from "@ging/core/extension/blameAnnotation";
import { type BlameAvatarDeps, createBlameAvatars } from "@ging/core/extension/blameAvatars";
import { createBlameCache } from "@ging/core/extension/blameCache";
import {
  type BlameHoverDetails,
  blameHoverMarkdown,
  copyableSha,
  createLastHoverDetails
} from "@ging/core/extension/blameHover";
import { lineChangeArgs, lineChangeDiff } from "@ging/core/extension/blameLineChange";
import { type CommitLocation, commitLocationArgs } from "@ging/core/extension/blameLocate";
import { createBlameRepoWatchers } from "@ging/core/extension/blameRepoWatchers";
import { updateDelay } from "@ging/core/extension/blameSchedule";
import { type BlameTarget, blameTarget, spansLines } from "@ging/core/extension/blameTarget";
import { blameToggle } from "@ging/core/extension/blameToggle";
import { createLatestLoads } from "@ging/core/extension/latestLoads";
import { openDocumentKeys, type TabContents } from "@ging/core/extension/openDocuments";
import { getPathFromUri } from "@ging/vscode/backend/utils/uri";
import { config } from "@ging/vscode/config";
import * as l10n from "@ging/vscode/l10n";

import { openCommitDiff } from "./openCommitDiff";
import { watchPaths } from "./watchPaths";

const SECTION = "ging-git-view";
const ENABLED_KEY = "blame.enabled";
const COLOR_ID = "ging-git-view.blameAnnotationForeground";
/** The hidden command a hover's SHA links run. */
const COPY_SHA_COMMAND = "ging-git-view.blame.copySha";
/** The hidden command a hover's link to the line's change runs. */
const OPEN_LINE_CHANGE_COMMAND = "ging-git-view.blame.openLineChange";
/** The hidden command a hover's link to the commit's place in the graph runs. */
const LOCATE_COMMIT_COMMAND = "ging-git-view.blame.locateCommit";
/** How many commits' changes the hovers keep. */
const CHANGE_CACHE_SIZE = 100;
/** How many excerpts of hunks too big to keep whole the hovers keep. */
const EXCERPT_CACHE_SIZE = 200;
/** How long the status bar says a SHA was copied. */
const COPIED_MESSAGE_MS = 3000;

type FileBlame = { lines: BlameLine[]; userEmail: string };

/** A hover lookup: a blamed line's commit, in a repository. */
type HoverLookup = { commit: BlamedCommit; repo: string };
const lookupKey = ({ commit, repo }: HoverLookup) =>
  JSON.stringify([
    repo,
    commit.sha,
    commit.filename,
    commit.previous?.sha,
    commit.previous?.filename
  ]);

const cacheKey = (document: vscode.TextDocument) => document.uri.toString();
const lineSpans = (selections: readonly vscode.Selection[]) =>
  selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));

/** Where `editor` is annotated now, or null for nowhere. */
function targetOf(editor: vscode.TextEditor, knownRepos: string[]): BlameTarget | null {
  const { document } = editor;
  return blameTarget(
    {
      scheme: document.uri.scheme,
      filePath: getPathFromUri(document.uri),
      selections: lineSpans(editor.selections),
      cursorLine: editor.selection.active.line
    },
    knownRepos
  );
}

function tabContents({ input }: vscode.Tab): TabContents {
  if (input instanceof vscode.TabInputText) return { kind: "text", uri: input.uri.toString() };
  if (input instanceof vscode.TabInputTextDiff) {
    return {
      kind: "diff",
      original: input.original.toString(),
      modified: input.modified.toString()
    };
  }
  return { kind: "other" };
}

/** Every document an editor tab (or a visible editor) still holds open. */
function openDocuments(): Set<string> {
  return openDocumentKeys(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs.map(tabContents)),
    vscode.window.visibleTextEditors.map((editor) => cacheKey(editor.document))
  );
}

/**
 * Watch what moves a repository's blame — its HEAD and branches, where git
 * really keeps them (see `gitDirWatchPaths`). Null when git can't say where
 * that is.
 */
async function watchGitDir(
  git: GitRunOptions,
  onChange: () => void
): Promise<vscode.Disposable | null> {
  const dirs = await findGitDirs(git);
  if (dirs === null) return null;
  return watchPaths(gitDirWatchPaths(dirs), onChange);
}

const sameTarget = (a: BlameTarget | null, b: BlameTarget) =>
  a !== null && a.line === b.line && a.repo === b.repo && a.filePath === b.filePath;

/**
 * The end-of-line blame annotation on the active editor's cursor line — the
 * VS Code wiring around `blameTarget`, `blameFile` and `blameAnnotationText`.
 *
 * The file is blamed in the known repository that contains it, never in the
 * current repository the graph shows. Each file is blamed once per document
 * version and repository; moving the cursor only reads that result. Unsaved
 * edits are blamed as the editor shows them, and the repository's branches
 * and HEAD are watched while a blamed file of it is open, so a commit or
 * checkout shows up straight away. Anything that can't be blamed just shows
 * nothing.
 */
export function createBlameController(deps: {
  knownRepos: () => string[];
  gitPath: () => string;
  gitEnv: () => NodeJS.ProcessEnv;
  onCommand: GitCommandHandler;
  /** Fires when the set of known repositories may have grown. */
  onDidChangeKnownRepos: vscode.Event<unknown>;
  /** Where the hover's avatars come from; see `createBlameAvatars`. */
  avatars: BlameAvatarDeps;
}): vscode.Disposable {
  const decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor(COLOR_ID), margin: "0 0 0 3em" }
  });
  const cache = createBlameCache<Promise<FileBlame | null>>();
  // What the hovers look up, each kept bounded; only the latest request of each
  // runs git, the one before it aborted (see `createLatestLoads`).
  /** Each commit's change to a file. */
  const changes = createLatestLoads<HoverLookup, CommitChange>({
    key: lookupKey,
    load: ({ commit: { sha, filename, previous }, repo }, signal) =>
      blameCommitChange({ ...gitIn(repo), signal, sha, filename, previous }),
    size: CHANGE_CACHE_SIZE
  });
  /** The excerpt for one line of a hunk too big for its change to keep. */
  const excerpts = createLatestLoads<HoverLookup & { line: number }, HunkExcerpt>({
    key: (lookup) => `${lookupKey(lookup)}:${lookup.line}`,
    load: ({ commit: { sha, filename, previous }, repo, line }, signal) =>
      blameLineExcerpt({ ...gitIn(repo), signal, sha, filename, previous, line }),
    size: EXCERPT_CACHE_SIZE
  });
  const cancelLookups = () => {
    changes.cancel();
    excerpts.cancel();
  };
  const avatarOf = createBlameAvatars(deps.avatars);
  // A commit or checkout changes the blame of every file in the repository, and
  // so does one that may have landed before its watcher was up (reported as a
  // change too). The repository's blames are dropped as well whenever nothing
  // watches it — let go, or it couldn't be watched: a closed tab can leave its
  // document alive, at the same version, to be reopened after a commit nothing
  // saw.
  const repoWatchers = createBlameRepoWatchers({
    watch: (repo, onChange) => watchGitDir(gitIn(repo), onChange),
    onChange: (repo) => {
      cache.deleteRepo(repo);
      schedule();
    },
    onRelease: (repo) => cache.deleteRepo(repo)
  });
  /** When each document was last edited, to hold the annotation while typing. */
  const editedAt = new WeakMap<vscode.TextDocument, number>();
  let decorated: vscode.TextEditor | undefined;
  const lastDetails = createLastHoverDetails();
  let timer: NodeJS.Timeout | undefined;
  // Bumped by every change that makes an in-flight update stale: a result that
  // comes back after one is dropped rather than drawn.
  let generation = 0;

  function cancelPending() {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
  }

  function hide() {
    cancelPending();
    // No annotation, no hover to look anything up for.
    cancelLookups();
    decorated?.setDecorations(decoration, []);
    decorated = undefined;
  }

  /** Update after `delay` ms; by default once the cursor has settled and any
   *  typing in the active document has stopped. */
  function schedule(delay?: number) {
    cancelPending();
    const document = vscode.window.activeTextEditor?.document;
    const wait =
      delay ??
      updateDelay({
        now: Date.now(),
        lastEditAt: document === undefined ? undefined : editedAt.get(document)
      });
    timer = setTimeout(() => void update(), wait);
  }

  /** Where and how a git run in `repo` happens; its deadline starts now. */
  function gitIn(repo: string): GitRunOptions {
    return {
      gitPath: deps.gitPath(),
      repoPath: repo,
      deadline: Date.now() + BLAME_TIMEOUT_MS,
      onCommand: deps.onCommand,
      gitEnv: deps.gitEnv()
    };
  }

  function blameFor(document: vscode.TextDocument, target: BlameTarget) {
    const key = cacheKey(document);
    repoWatchers.blaming(key, target.repo);
    const stamp = { version: document.version, repo: target.repo };
    const cached = cache.get(key, stamp);
    if (cached !== undefined) return cached;
    // One deadline for every git run of the lookup, user.email included.
    const git = gitIn(target.repo);
    // The lines must be those of the version on screen: unsaved edits, and a
    // clean document that a checkout changed on disk before VS Code reloaded
    // it, go to git on stdin; any other clean one is blamed from disk (see
    // `blameSource`).
    const blame = Promise.all([
      blameFile({
        ...git,
        filePath: target.filePath,
        contents: document.getText(),
        editorIsClean: !document.isDirty
      }),
      readUserEmail(git)
    ]).then(
      ([lines, userEmail]): FileBlame | null => (lines === null ? null : { lines, userEmail }),
      () => null
    );
    cache.set(key, stamp, blame);
    return blame;
  }

  /** What the hover of a committed line shows beyond its blame. */
  async function hoverDetails(line: BlameLine, repo: string): Promise<BlameHoverDetails> {
    const lookup = { commit: line, repo };
    const [change, avatar] = await Promise.all([
      changes.get(lookup),
      avatarOf(line, repo).catch(() => null)
    ]);
    const found = change === null ? null : hunkAt(change, line.originalLine);
    // A hunk too big for the change to keep is looked up again, for this line.
    const hunk =
      found === "left out" ? await excerpts.get({ ...lookup, line: line.originalLine }) : found;
    return { message: change?.message ?? null, hunk, avatar };
  }

  function hoverMessage(
    line: BlameLine,
    repo: string,
    details: BlameHoverDetails,
    context: BlameAnnotationContext
  ): vscode.MarkdownString {
    const markdown = blameHoverMarkdown(line, details, {
      ...context,
      labels: {
        ...context.labels,
        changes: l10n.t("blame.hover.changes"),
        copyHash: l10n.t("blame.hover.copyHash"),
        openLineChange: l10n.t("blame.hover.openLineChange"),
        locateCommit: l10n.t("blame.hover.locateCommit")
      },
      repo,
      copyShaCommand: COPY_SHA_COMMAND,
      openLineChangeCommand: OPEN_LINE_CHANGE_COMMAND,
      locateCommitCommand: LOCATE_COMMIT_COMMAND,
      // Theme icons: the MarkdownString below is made with `supportThemeIcons`.
      icons: { account: "$(account)", lineChange: "$(diff)", locateCommit: "$(git-commit)" }
    });
    const hover = new vscode.MarkdownString(markdown, true);
    // The SHA links, the line's change link and the graph link, and nothing
    // else, may run a command.
    hover.isTrusted = {
      enabledCommands: [COPY_SHA_COMMAND, OPEN_LINE_CHANGE_COMMAND, LOCATE_COMMIT_COMMAND]
    };
    return hover;
  }

  async function update() {
    const token = ++generation;
    const editor = vscode.window.activeTextEditor;
    const target = editor === undefined ? null : targetOf(editor, deps.knownRepos());
    if (editor === undefined || target === null || !config.blameEnabled(editor.document.uri)) {
      hide();
      return;
    }
    const version = editor.document.version;
    const blame = await blameFor(editor.document, target);
    // Anything may have moved while git ran: draw only if this is still the
    // latest update, and the editor still shows the same version of the
    // document with the cursor on the same line.
    if (token !== generation || editor !== vscode.window.activeTextEditor) return;
    if (editor.document.version !== version) return;
    if (!sameTarget(targetOf(editor, deps.knownRepos()), target)) return;
    const line = blame?.lines[target.line];
    if (line === undefined) {
      hide();
      return;
    }
    const context: BlameAnnotationContext = {
      now: Date.now(),
      locale: vscode.env.language,
      userEmail: blame?.userEmail ?? "",
      labels: { you: l10n.t("blame.you"), uncommitted: l10n.t("blame.uncommitted") }
    };
    const text = blameAnnotationText(line, context);
    if (decorated !== undefined && decorated !== editor) decorated.setDecorations(decoration, []);
    const end = editor.document.lineAt(target.line).range.end;
    // The hover belongs to the annotation alone — a decoration's hover, not a
    // hover provider over the line — so hovering the code shows only the
    // language's own. A decoration's hover is fixed when it is drawn, so the
    // annotation is drawn at once with what the blame says, and drawn again
    // once the commit's message, hunk and avatar are in (see `hoverDetails`).
    const draw = (details: BlameHoverDetails) =>
      editor.setDecorations(decoration, [
        {
          range: new vscode.Range(end, end),
          hoverMessage: hoverMessage(line, target.repo, details, context),
          renderOptions: { after: { contentText: text } }
        }
      ]);
    draw(lastDetails.for(target.repo, line));
    decorated = editor;
    if (line.uncommitted) {
      // Nothing to look up — and whatever the line before wanted is stale.
      cancelLookups();
      return;
    }
    const details = await hoverDetails(line, target.repo);
    // Whatever moved the cursor, changed the document or hid the annotation
    // meanwhile bumped the generation; the update it scheduled draws instead.
    if (token !== generation || editor !== decorated) return;
    lastDetails.remember(target.repo, line, details);
    draw(details);
  }

  const subscriptions: vscode.Disposable[] = [
    decoration,
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      // A selection across lines drops the annotation at once; a cursor move
      // waits until the cursor settles.
      if (spansLines(lineSpans(e.selections))) hide();
      else schedule();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      hide();
      schedule();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      // Typing leaves the document dirty; a reload from disk (a checkout, say)
      // leaves it clean and can be blamed without waiting for typing to stop.
      if (e.document.isDirty) editedAt.set(e.document, Date.now());
      else editedAt.delete(e.document);
      const active = e.document === vscode.window.activeTextEditor?.document;
      if (!active && e.document !== decorated?.document) return;
      // New content: drop the annotation and any lookup still running for the
      // old version, and blame the new one once typing stops.
      hide();
      if (active) schedule();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      cache.delete(cacheKey(document));
      if (document === vscode.window.activeTextEditor?.document) schedule();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.delete(cacheKey(document));
      repoWatchers.keepOnly(openDocuments());
    }),
    // Tabs and visible editors are updated separately, in no fixed order, so
    // either can be the last to drop a closed editor.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed.length > 0) repoWatchers.keepOnly(openDocuments());
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => repoWatchers.keepOnly(openDocuments())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${SECTION}.${ENABLED_KEY}`)) return;
      // Clear everywhere and let every watcher go, then let the active editor
      // show (and watch) again at once if the setting, as it applies to its
      // file, is still on.
      hide();
      repoWatchers.keepOnly(new Set());
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(decoration, []);
      }
      schedule(0);
    }),
    deps.onDidChangeKnownRepos(() => schedule())
  ];
  schedule(0);

  return {
    dispose() {
      cancelPending();
      for (const s of subscriptions) s.dispose();
      repoWatchers.dispose();
      cancelLookups();
      cache.clear();
    }
  };
}

/** `ging-git-view.blame.copySha`, the hover's SHA links: copy the full commit
 *  hash and say so in the status bar for a moment. Hidden from the Command
 *  Palette. */
export function registerBlameCopySha(): vscode.Disposable {
  return vscode.commands.registerCommand(COPY_SHA_COMMAND, async (arg: unknown) => {
    const sha = copyableSha(arg);
    if (sha === null) return;
    await vscode.env.clipboard.writeText(sha);
    vscode.window.setStatusBarMessage(
      l10n.t("blame.copiedHash", abbrevCommit(sha)),
      COPIED_MESSAGE_MS
    );
  });
}

/** `ging-git-view.blame.openLineChange`, the hover's link to the line's change:
 *  open the commit's change to the file in a diff editor, at the line (see
 *  `lineChangeDiff`). Hidden from the Command Palette. */
export function registerBlameOpenLineChange(deps: {
  knownRepos: () => string[];
}): vscode.Disposable {
  return vscode.commands.registerCommand(OPEN_LINE_CHANGE_COMMAND, async (arg: unknown) => {
    // Arguments that don't check out — the repository is no longer known since
    // the hover was drawn, say — are reported like a diff that failed to open,
    // rather than doing nothing.
    const change = lineChangeArgs(arg, deps.knownRepos());
    // The same editor group as a diff opened from the graph.
    const opened =
      change !== null &&
      (await openCommitDiff(lineChangeDiff(change), config.openNewTabEditorGroup()));
    if (!opened) void vscode.window.showErrorMessage(l10n.t("error.unableToViewDiff"));
  });
}

/** `ging-git-view.blame.locateCommit`, the hover's link to the commit's place
 *  in the graph (#310): `locate` opens the graph on the blamed file's
 *  repository and has it select the commit. Hidden from the Command Palette. */
export function registerBlameLocateCommit(deps: {
  knownRepos: () => string[];
  locate: (location: CommitLocation) => Promise<void>;
}): vscode.Disposable {
  return vscode.commands.registerCommand(LOCATE_COMMIT_COMMAND, async (arg: unknown) => {
    // As with the line's change: a repository no longer known since the hover
    // was drawn is reported, rather than the click doing nothing.
    const location = commitLocationArgs(arg, deps.knownRepos());
    if (location === null) {
      void vscode.window.showErrorMessage(l10n.t("blame.locate.failed"));
      return;
    }
    await deps.locate(location);
  });
}

/** `ging-git-view.blame.toggle`: see `blameToggle` for what it decides. */
export function registerBlameToggle(): vscode.Disposable {
  return vscode.commands.registerCommand("ging-git-view.blame.toggle", async () => {
    // Inspect for the active file, so a folder-level value is seen too; with no
    // editor open only the user and workspace values can apply.
    const scope = vscode.window.activeTextEditor?.document.uri;
    const settings = vscode.workspace.getConfiguration(SECTION, scope);
    const inspected = settings.inspect<boolean>(ENABLED_KEY);
    const { next, overriddenByWorkspace } = blameToggle({
      effective: config.blameEnabled(scope),
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue
    });
    await settings.update(ENABLED_KEY, next, vscode.ConfigurationTarget.Global);
    if (overriddenByWorkspace) {
      void vscode.window.showInformationMessage(
        l10n.t(next ? "blame.workspaceKeepsOff" : "blame.workspaceKeepsOn")
      );
    }
  });
}
