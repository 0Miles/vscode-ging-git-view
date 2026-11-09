import * as vscode from "vscode";

import type { GitCommandHandler } from "@/backend/gitSpawn";
import {
  BLAME_TIMEOUT_MS,
  type BlameGit,
  type BlameLine,
  blameFile,
  readUserEmail
} from "@/backend/queries/blameFile";
import { findGitDirs, gitDirWatchPaths } from "@/backend/queries/gitDirs";
import { getPathFromUri } from "@/backend/utils/path";
import { config } from "@/config";
import * as l10n from "@/l10n";

import { blameAnnotationText } from "./blameAnnotation";
import { createBlameCache } from "./blameCache";
import { createBlameRepoWatchers } from "./blameRepoWatchers";
import { updateDelay } from "./blameSchedule";
import { type BlameTarget, blameTarget, spansLines } from "./blameTarget";
import { blameToggle } from "./blameToggle";

const SECTION = "ging-git-view";
const ENABLED_KEY = "blame.enabled";
const COLOR_ID = "ging-git-view.blameAnnotationForeground";

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

/** Every document an editor tab (or a visible editor) still shows. */
function openDocumentKeys(): Set<string> {
  const keys = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const { input } of group.tabs) {
      if (input instanceof vscode.TabInputText) keys.add(input.uri.toString());
      else if (input instanceof vscode.TabInputTextDiff) {
        keys.add(input.original.toString());
        keys.add(input.modified.toString());
      }
    }
  }
  for (const editor of vscode.window.visibleTextEditors) keys.add(cacheKey(editor.document));
  return keys;
}

/**
 * Watch what moves a repository's blame — its HEAD and branches, where git
 * really keeps them (see `gitDirWatchPaths`). Null when git can't say where
 * that is.
 */
async function watchGitDir(git: BlameGit, onChange: () => void): Promise<vscode.Disposable | null> {
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
}): vscode.Disposable {
  const decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor(COLOR_ID), margin: "0 0 0 3em" }
  });
  const cache = createBlameCache<Promise<FileBlame | null>>();
  // A commit or checkout changes the blame of every file in the repository.
  // The repository's blames are dropped too once nothing watches it: a closed
  // tab can leave its document alive, at the same version, to be reopened
  // after a commit nothing saw.
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
  function gitIn(repo: string): BlameGit {
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
    // Unsaved edits go to git on stdin, so the lines match the editor's.
    const contents = document.isDirty ? document.getText() : undefined;
    const blame = Promise.all([
      blameFile({ ...git, filePath: target.filePath, contents }),
      readUserEmail(git)
    ]).then(
      ([lines, userEmail]): FileBlame | null => (lines === null ? null : { lines, userEmail }),
      () => null
    );
    cache.set(key, stamp, blame);
    return blame;
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
    const text = blameAnnotationText(line, {
      now: Date.now(),
      locale: vscode.env.language,
      userEmail: blame?.userEmail ?? "",
      labels: { you: l10n.t("blame.you"), uncommitted: l10n.t("blame.uncommitted") }
    });
    if (decorated !== undefined && decorated !== editor) decorated.setDecorations(decoration, []);
    const end = editor.document.lineAt(target.line).range.end;
    editor.setDecorations(decoration, [
      { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }
    ]);
    decorated = editor;
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
      repoWatchers.keepOnly(openDocumentKeys());
    }),
    // Tabs and visible editors are updated separately, in no fixed order, so
    // either can be the last to drop a closed editor.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed.length > 0) repoWatchers.keepOnly(openDocumentKeys());
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => repoWatchers.keepOnly(openDocumentKeys())),
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
      cache.clear();
    }
  };
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
