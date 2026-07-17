import type { GitFileChange } from "@/backend/types";

import { escapeHtml } from "./html";
import { svgIcons } from "./icons";

function newFolder(name: string, folderPath: string): GitFolder {
  return { type: "folder", name, folderPath, children: new Map(), open: true };
}

/** Compare two nodes by name in code-point order (matches the flat File List view). */
function byName(a: GitFolderOrFile, b: GitFolderOrFile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Build a nested folder/file tree from a flat list of file changes. Each file's
 * `newFilePath` is split into path segments; the final segment becomes a leaf
 * that remembers its index back into `gitFiles`, and the preceding segments are
 * realised as nested folders (created lazily the first time they are seen).
 */
export function generateGitFileTree(gitFiles: GitFileChange[]): GitFolder {
  const root = newFolder("", "");
  for (let index = 0; index < gitFiles.length; index++) {
    const segments = gitFiles[index].newFilePath.split("/");
    const fileName = segments.pop() ?? gitFiles[index].newFilePath;
    let folder = root;
    for (let depth = 0; depth < segments.length; depth++) {
      const segment = segments[depth];
      const existing = folder.children.get(segment);
      if (existing !== undefined && existing.type === "folder") {
        folder = existing;
      } else {
        const created = newFolder(segment, segments.slice(0, depth + 1).join("/"));
        folder.children.set(segment, created);
        folder = created;
      }
    }
    folder.children.set(fileName, { type: "file", name: fileName, index });
  }
  return root;
}

/**
 * Collapse runs of single-child folders into one node, so e.g. `a` -> `b` -> `c`
 * (where each only contains the next) renders as a single `a/b/c` row. A
 * collapsed node keeps its key in the parent but adopts the deepest folder's
 * `folderPath` and `children`; its `name` becomes the joined path. The root
 * folder (name "") is never merged into.
 */
export function compactGitFileTree(folder: GitFolder): void {
  for (const child of folder.children.values()) {
    if (child.type !== "folder") continue;
    while (child.children.size === 1) {
      const onlyChild = child.children.values().next().value as GitFolderOrFile;
      if (onlyChild.type !== "folder") break;
      child.name = child.name + "/" + onlyChild.name;
      child.folderPath = onlyChild.folderPath;
      child.children = onlyChild.children;
    }
    compactGitFileTree(child);
  }
}

/**
 * Convert a file tree to the JSON-safe form persisted in WebViewState:
 * vscode.setState JSON-serializes the state, which would collapse the Map of
 * children to {} and lose the tree.
 */
export function serializeGitFileTree(folder: GitFolder): SerializedGitFolder {
  const children: (SerializedGitFolder | GitFile)[] = [];
  for (const child of folder.children.values()) {
    children.push(child.type === "folder" ? serializeGitFileTree(child) : child);
  }
  return {
    type: "folder",
    name: folder.name,
    folderPath: folder.folderPath,
    children,
    open: folder.open
  };
}

/**
 * Rebuild a file tree from its persisted form. Returns NULL when the value
 * isn't a valid serialized tree — in particular for states saved by versions
 * that persisted the Map directly (JSON collapsed it to {}) — so callers fall
 * back to re-requesting the commit details instead of crashing on restore.
 */
export function deserializeGitFileTree(
  folder: SerializedGitFolder | null | undefined
): GitFolder | null {
  if (!folder || folder.type !== "folder" || !Array.isArray(folder.children)) return null;
  const children = new Map<string, GitFolderOrFile>();
  for (const child of folder.children) {
    if (!child || typeof child.name !== "string") return null;
    if (child.type === "folder") {
      const sub = deserializeGitFileTree(child);
      if (sub === null) return null;
      children.set(child.name, sub);
    } else if (child.type === "file" && typeof child.index === "number") {
      children.set(child.name, child);
    } else {
      return null;
    }
  }
  return {
    type: "folder",
    name: folder.name,
    folderPath: folder.folderPath,
    children,
    open: folder.open !== false
  };
}

/** Order a folder's children: sub-folders first, then files, each group sorted
 *  by name (code-point order, matching the flat File List view). */
function sortedChildren(folder: GitFolder): GitFolderOrFile[] {
  const folders: GitFolder[] = [];
  const files: GitFile[] = [];
  for (const child of folder.children.values()) {
    if (child.type === "folder") folders.push(child);
    else files.push(child);
  }
  folders.sort(byName);
  files.sort(byName);
  return [...folders, ...files];
}

/**
 * Render a file-tree folder (and its descendants) to HTML. When
 * `enhancedAccessibility` is true, each file is prefixed with a textual
 * indicator of its change type (A/M/D/R/U) so the meaning isn't conveyed by
 * colour/icon alone.
 */
export function generateGitFileTreeHtml(
  folder: GitFolder,
  gitFiles: GitFileChange[],
  enhancedAccessibility: boolean
): string {
  let html =
    (folder.name !== ""
      ? '<span class="gitFolder" data-folderpath="' +
        encodeURIComponent(folder.folderPath) +
        '"><span class="gitFolderIcon">' +
        (folder.open ? svgIcons.openFolder : svgIcons.closedFolder) +
        '</span><span class="gitFolderName">' +
        escapeHtml(folder.name) +
        "</span></span>"
      : "") +
    '<ul class="gitFolderContents' +
    (!folder.open ? " hidden" : "") +
    '">';
  for (const child of sortedChildren(folder)) {
    if (child.type === "folder") {
      html +=
        "<li" +
        (!child.open ? ' class="closed"' : "") +
        ">" +
        generateGitFileTreeHtml(child, gitFiles, enhancedAccessibility) +
        "</li>";
    } else {
      html += renderGitFileRow(gitFiles[child.index], child.name, enhancedAccessibility);
    }
  }
  return html + "</ul>";
}

/** Render a single file row `<li>` for the Commit Details file tree/list. `label`
 *  is the displayed text (a file name in tree view, the full path in list view). */
function renderGitFileRow(
  gitFile: GitFileChange,
  label: string,
  enhancedAccessibility: boolean
): string {
  return (
    '<li class="gitFile ' +
    gitFile.type +
    (gitFile.additions !== null && gitFile.deletions !== null ? " gitDiffPossible" : "") +
    '" data-oldfilepath="' +
    encodeURIComponent(gitFile.oldFilePath) +
    '" data-newfilepath="' +
    encodeURIComponent(gitFile.newFilePath) +
    '" data-type="' +
    gitFile.type +
    '"' +
    (gitFile.additions === null || gitFile.deletions === null
      ? ' title="' + l10n.tooltipBinaryFile + '"'
      : "") +
    '><span class="gitFileIcon">' +
    svgIcons.file +
    "</span>" +
    (enhancedAccessibility
      ? '<span class="gitFileChangeTypeIndicator">' + gitFile.type + "</span> "
      : "") +
    escapeHtml(label) +
    (gitFile.type === "R"
      ? ' <span class="gitFileRename" title="' +
        escapeHtml(gitFile.oldFilePath + l10n.tooltipRenamedTo + gitFile.newFilePath) +
        '">R</span>'
      : "") +
    (gitFile.type !== "A" &&
    gitFile.type !== "D" &&
    gitFile.additions !== null &&
    gitFile.deletions !== null
      ? '<span class="gitFileAddDel">(<span class="gitFileAdditions" title="' +
        gitFile.additions +
        (gitFile.additions !== 1 ? l10n.tooltipAdditions : l10n.tooltipAddition) +
        '">+' +
        gitFile.additions +
        '</span>|<span class="gitFileDeletions" title="' +
        gitFile.deletions +
        (gitFile.deletions !== 1 ? l10n.tooltipDeletions : l10n.tooltipDeletion) +
        '">-' +
        gitFile.deletions +
        "</span>)</span>"
      : "") +
    (gitFile.type !== "D"
      ? '<span class="gitFileDiffWorking" title="' +
        l10n.viewDiffWithWorking +
        '" data-filepath="' +
        encodeURIComponent(gitFile.newFilePath) +
        '">' +
        svgIcons.compare +
        "</span>"
      : "") +
    (gitFile.type !== "D"
      ? '<span class="gitFileViewRev" title="' +
        l10n.viewFileAtRevision +
        '" data-filepath="' +
        encodeURIComponent(gitFile.newFilePath) +
        '">' +
        svgIcons.viewRevision +
        "</span>"
      : "") +
    (gitFile.type !== "D"
      ? '<span class="gitFileOpen" title="' +
        l10n.openFile +
        '" data-filepath="' +
        encodeURIComponent(gitFile.newFilePath) +
        '">' +
        svgIcons.openFile +
        "</span>"
      : "") +
    '<span class="gitFileCopyPath" title="' +
    l10n.copyFilePath +
    '" data-filepath="' +
    encodeURIComponent(gitFile.newFilePath) +
    '">' +
    svgIcons.copy +
    "</span>" +
    "</li>"
  );
}

/** Render the file changes as a flat, path-sorted list (the "File List" view)
 *  instead of a nested folder tree. */
export function generateGitFileListHtml(
  gitFiles: GitFileChange[],
  enhancedAccessibility: boolean
): string {
  const sorted = gitFiles.toSorted((a, b) =>
    a.newFilePath < b.newFilePath ? -1 : a.newFilePath > b.newFilePath ? 1 : 0
  );
  let html = '<ul class="gitFileList">';
  for (const gitFile of sorted) {
    html += renderGitFileRow(gitFile, gitFile.newFilePath, enhancedAccessibility);
  }
  return html + "</ul>";
}

/** Depth-first search for the folder whose `folderPath` equals `folderPath`. */
function findGitFolder(folder: GitFolder, folderPath: string): GitFolder | null {
  if (folder.folderPath === folderPath) return folder;
  for (const child of folder.children.values()) {
    if (child.type === "folder") {
      const found = findGitFolder(child, folderPath);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Set the open/closed state of the folder identified by `folderPath`. Matches
 * by `folderPath` (not by walking path segments), so it works regardless of
 * folder compaction.
 */
export function alterGitFileTree(folder: GitFolder, folderPath: string, open: boolean): void {
  const target = findGitFolder(folder, folderPath);
  if (target !== null) target.open = open;
}
