import type { SimpleGit } from "simple-git";
import * as vscode from "vscode";

import { getUserDetails } from "@/backend/actions/userDetails";
import type { GitCommandHandler } from "@/backend/gitSpawn";
import { BLAME_TIMEOUT_MS, type BlameLine, blameFile } from "@/backend/queries/blameFile";
import { getPathFromUri } from "@/backend/utils/path";
import { blameLocation } from "@/backend/utils/repoMatch";
import { config } from "@/config";
import * as l10n from "@/l10n";

import { blameAnnotationText } from "./blameAnnotation";
import { blameToggle } from "./blameToggle";

const SECTION = "ging-git-view";
const ENABLED_KEY = "blame.enabled";
const COLOR_ID = "ging-git-view.blameAnnotationForeground";
/** How long the cursor has to rest before the annotation follows it. */
const CURSOR_SETTLE_MS = 150;

type FileBlame = { lines: BlameLine[]; userEmail: string };

const cacheKey = (document: vscode.TextDocument) => document.uri.toString();
const spansLines = (selections: readonly vscode.Selection[]) =>
  selections.some((s) => !s.isSingleLine);

/**
 * The end-of-line blame annotation on the active editor's cursor line.
 *
 * The file is blamed in the known repository that contains it — the deepest
 * one, so a submodule or worktree file is blamed in its own repository — and
 * never in the current repository the graph shows. Each file is blamed once per
 * document version; moving the cursor only reads that result. Anything that
 * can't be blamed (outside every known repository, untracked, binary, too big,
 * too slow) just shows nothing.
 */
export function createBlameController(deps: {
  knownRepos: () => string[];
  gitPath: () => string;
  gitEnv: () => NodeJS.ProcessEnv;
  onCommand: GitCommandHandler;
  gitClientFor: (repo: string) => SimpleGit;
  /** Fires when the set of known repositories may have grown. */
  onDidChangeKnownRepos: vscode.Event<unknown>;
}): vscode.Disposable {
  const decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor(COLOR_ID), margin: "0 0 0 3em" }
  });
  const cache = new Map<string, { version: number; blame: Promise<FileBlame | null> }>();
  let decorated: vscode.TextEditor | undefined;
  let timer: NodeJS.Timeout | undefined;
  // Bumped by every change that makes an in-flight update stale.
  let generation = 0;

  function hide() {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    decorated?.setDecorations(decoration, []);
    decorated = undefined;
  }

  function schedule(delay = CURSOR_SETTLE_MS) {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void update(), delay);
  }

  function blameFor(document: vscode.TextDocument, repo: string, filePath: string) {
    const key = cacheKey(document);
    const cached = cache.get(key);
    if (cached?.version === document.version) return cached.blame;
    const blamed = Promise.all([
      blameFile({
        gitPath: deps.gitPath(),
        repoPath: repo,
        filePath,
        onCommand: deps.onCommand,
        gitEnv: deps.gitEnv()
      }),
      getUserDetails(deps.gitClientFor(repo))
    ]).then(
      ([lines, user]): FileBlame | null =>
        lines === null ? null : { lines, userEmail: user.email },
      () => null
    );
    // The query bounds its own git runs; this bounds the whole lookup, the
    // user.email read included, so a slow repository gives up in time too.
    let budget: NodeJS.Timeout | undefined;
    const blame = Promise.race([
      blamed,
      new Promise<null>((resolve) => {
        budget = setTimeout(() => resolve(null), BLAME_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(budget));
    cache.set(key, { version: document.version, blame });
    return blame;
  }

  async function update() {
    const token = ++generation;
    const editor = vscode.window.activeTextEditor;
    const target = editor === undefined ? null : annotationTarget(editor, deps.knownRepos());
    if (editor === undefined || target === null || !config.blameEnabled()) {
      hide();
      return;
    }
    const { document } = editor;
    const version = document.version;
    const blame = await blameFor(document, target.repo, target.filePath);
    if (token !== generation || document.version !== version) return;
    const line = blame?.lines[target.line];
    if (line === undefined) {
      hide();
      return;
    }
    const text = blameAnnotationText(line, {
      now: Date.now(),
      locale: vscode.env.language,
      userEmail: blame?.userEmail ?? "",
      uncommittedText: l10n.t("blame.uncommitted")
    });
    if (decorated !== undefined && decorated !== editor) decorated.setDecorations(decoration, []);
    const end = document.lineAt(target.line).range.end;
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
      if (spansLines(e.selections)) hide();
      else schedule();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      hide();
      schedule();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Edited text no longer matches the blamed lines; it is shown again once
      // the document is saved.
      if (e.contentChanges.length > 0 && e.document === decorated?.document) hide();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      cache.delete(cacheKey(document));
      if (document === vscode.window.activeTextEditor?.document) schedule();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => cache.delete(cacheKey(document))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${SECTION}.${ENABLED_KEY}`)) return;
      if (config.blameEnabled()) {
        schedule(0);
      } else {
        hide();
        for (const editor of vscode.window.visibleTextEditors) {
          editor.setDecorations(decoration, []);
        }
      }
    }),
    deps.onDidChangeKnownRepos(() => schedule())
  ];
  schedule(0);

  return {
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
      cache.clear();
    }
  };
}

/** The line to annotate and where to blame it, or null when the editor shows
 *  nothing to annotate. */
function annotationTarget(
  editor: vscode.TextEditor,
  knownRepos: string[]
): { line: number; repo: string; filePath: string } | null {
  const { document, selection } = editor;
  // Unsaved edits no longer line up with what git blames on disk.
  if (document.uri.scheme !== "file" || document.isDirty) return null;
  if (spansLines(editor.selections)) return null;
  const location = blameLocation(getPathFromUri(document.uri), knownRepos);
  return location === null ? null : { line: selection.active.line, ...location };
}

/** `ging-git-view.blame.toggle`: see `blameToggle` for what it decides. */
export function registerBlameToggle(): vscode.Disposable {
  return vscode.commands.registerCommand("ging-git-view.blame.toggle", async () => {
    const settings = vscode.workspace.getConfiguration(SECTION);
    const inspected = settings.inspect<boolean>(ENABLED_KEY);
    const { next, overriddenByWorkspace } = blameToggle({
      effective: config.blameEnabled(),
      workspaceValue: inspected?.workspaceFolderValue ?? inspected?.workspaceValue
    });
    await settings.update(ENABLED_KEY, next, vscode.ConfigurationTarget.Global);
    if (overriddenByWorkspace) {
      void vscode.window.showInformationMessage(
        l10n.t(next ? "blame.workspaceKeepsOff" : "blame.workspaceKeepsOn")
      );
    }
  });
}
