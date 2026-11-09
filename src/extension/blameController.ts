import * as vscode from "vscode";

import type { GitRunOptions } from "@/backend/gitRun";
import type { GitCommandHandler } from "@/backend/gitSpawn";
import { blameCommitChange, hunkAt } from "@/backend/queries/blameCommitChange";
import {
  BLAME_TIMEOUT_MS,
  type BlameLine,
  blameFile,
  readUserEmail
} from "@/backend/queries/blameFile";
import { findGitDirs, gitDirWatchPaths } from "@/backend/queries/gitDirs";
import { getPathFromUri } from "@/backend/utils/path";
import { abbrevCommit } from "@/backend/utils/string";
import { config } from "@/config";
import * as l10n from "@/l10n";

import { type BlameAnnotationContext, blameAnnotationText } from "./blameAnnotation";
import { type BlameAvatarDeps, createBlameAvatars } from "./blameAvatars";
import { createBlameCache } from "./blameCache";
import { createBlameChanges } from "./blameChanges";
import {
  type BlameHoverDetails,
  blameHoverMarkdown,
  copyableSha,
  createLastHoverDetails
} from "./blameHover";
import { createBlameRepoWatchers } from "./blameRepoWatchers";
import { updateDelay } from "./blameSchedule";
import { type BlameTarget, blameTarget, spansLines } from "./blameTarget";
import { blameToggle } from "./blameToggle";
import { openDocumentKeys, type TabContents } from "./openDocuments";

const SECTION = "ging-git-view";
const ENABLED_KEY = "blame.enabled";
const COLOR_ID = "ging-git-view.blameAnnotationForeground";
/** The hidden command a hover's SHA links run. */
const COPY_SHA_COMMAND = "ging-git-view.blame.copySha";
/** How many commits' changes the hovers keep. */
const CHANGE_CACHE_SIZE = 100;
/** How long the status bar says a SHA was copied. */
const COPIED_MESSAGE_MS = 3000;

type FileBlame = { lines: BlameLine[]; userEmail: string };

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
  const watchers = gitDirWatchPaths(dirs).map(({ base, glob }) =>
    vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(base), glob)
    )
  );
  return vscode.Disposable.from(
    ...watchers.flatMap((w) => [
      w.onDidCreate(onChange),
      w.onDidChange(onChange),
      w.onDidDelete(onChange)
    ]),
    ...watchers
  );
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
  /** Each commit's change to a file, for the hovers; only the latest request's
   *  git runs, the one before it aborted (see `createBlameChanges`). */
  const changes = createBlameChanges({
    load: ({ sha, filename, previous }, repo, signal) =>
      blameCommitChange({ ...gitIn(repo), signal, sha, filename, previous }),
    size: CHANGE_CACHE_SIZE
  });
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
    changes.cancel();
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
    const [change, avatar] = await Promise.all([
      changes.changeOf(line, repo),
      avatarOf(line, repo).catch(() => null)
    ]);
    return {
      message: change?.message ?? null,
      hunk: change === null ? null : hunkAt(change.hunks, line.originalLine),
      avatar
    };
  }

  function hoverMessage(
    line: BlameLine,
    details: BlameHoverDetails,
    context: BlameAnnotationContext
  ): vscode.MarkdownString {
    const markdown = blameHoverMarkdown(line, details, {
      ...context,
      labels: {
        ...context.labels,
        changes: l10n.t("blame.hover.changes"),
        copyHash: l10n.t("blame.hover.copyHash")
      },
      copyShaCommand: COPY_SHA_COMMAND
    });
    const hover = new vscode.MarkdownString(markdown, true);
    // The SHA links, and nothing else, may run a command.
    hover.isTrusted = { enabledCommands: [COPY_SHA_COMMAND] };
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
          hoverMessage: hoverMessage(line, details, context),
          renderOptions: { after: { contentText: text } }
        }
      ]);
    draw(lastDetails.for(target.repo, line));
    decorated = editor;
    if (line.uncommitted) {
      // Nothing to look up — and whatever the line before wanted is stale.
      changes.cancel();
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
      changes.cancel();
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
