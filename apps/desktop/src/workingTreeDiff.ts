/* A working tree file's diff, as a Tab's working tree panel opens it (#460),
 * and its hunks staged or unstaged one at a time from the diff viewer
 * (#406). The sides are the ones VS Code's source control view diffs: the
 * index against the working tree for an unstaged change, HEAD against the
 * index for a staged one. Apart from Electron, so the tests drive it as the
 * page does. */

import path from "node:path";

import type { HunkOutcome, WorkingTreeService } from "@ging/core/extension/workingTreeService";
import type { L10n } from "@ging/core/host/ports";
import type { FileHunks, HunkArea, NoHunksReason } from "@ging/shared/backend/types";
import type { DiffHunkRequest } from "@ging/webview/desktop/diff/protocol";
import type { WorkingTreeShowDiffRequest } from "@ging/webview/desktop/workingTree/protocol";

import type { DiffSource, HunkRead, ShowDiff } from "./diffViewer";

export type WorkingTreeDiffs = {
  /** Show the change the panel's row names, in the Tab's diff viewer. */
  show(request: WorkingTreeShowDiffRequest, said?: string): Promise<boolean>;
  /** Stage or unstage the hunk the diff viewer names, then show the file's
   *  diff anew: the hunk gone from it, or, should the diff have changed
   *  since it was shown, the diff as it is now and why nothing was done. */
  hunk(request: DiffHunkRequest): Promise<boolean>;
};

type WorkingTreeDiffDeps = {
  service: Pick<WorkingTreeService, "head" | "hunks" | "applyHunk">;
  showDiff: ShowDiff;
  l10n: Pick<L10n, "t">;
  /** The Tab's repository. */
  repo: () => string;
};

/** Why a diff offers no hunk, said over it; nothing for a diff with nothing
 *  to stage, or a binary one, which the viewer says itself. */
function whyNoHunks(reason: NoHunksReason, l10n: Pick<L10n, "t">): string | null {
  switch (reason) {
    case "unchanged":
    case "binary":
    case "conflicted":
      return null;
    case "added":
    case "deleted":
    case "renamed":
    case "notText":
      return l10n.t("desktop.diff.wholeFile");
  }
}

export function createWorkingTreeDiffs(deps: WorkingTreeDiffDeps): WorkingTreeDiffs {
  const { service, showDiff, l10n, repo } = deps;

  const hunkRead = (file: string, area: HunkArea) => async (): Promise<HunkRead> => {
    const read: FileHunks = await service.hunks(file, area);
    if (read.kind === "none") return { why: whyNoHunks(read.reason, l10n) };
    return {
      hunks: {
        path: file,
        area,
        token: read.token,
        hunks: read.hunks,
        label: l10n.t(area === "unstaged" ? "desktop.diff.stageHunk" : "desktop.diff.unstageHunk")
      }
    };
  };

  /** The diff of `request`'s file, revealing `revealLine` of its right side. */
  const show = async (
    request: WorkingTreeShowDiffRequest,
    said?: string,
    revealLine?: number
  ): Promise<boolean> => {
    const root = repo();
    const { path: file, oldPath, area } = request;
    const index: DiffSource = { revision: { repo: root, commit: ":0", filePath: file } };
    const named = oldPath === undefined ? file : `${oldPath} → ${file}`;
    let original: DiffSource;
    let modified: DiffSource;
    let title: string;
    if (area === "unstaged") {
      original = index;
      modified = { workingFile: path.join(root, file), repo: root };
      title = l10n.t("desktop.diff.workingTree", named);
    } else {
      // HEAD by its hash, as the viewer reads only hashes; nothing at all on
      // a branch with no commit yet.
      const head = await service.head();
      const before = oldPath ?? file;
      original =
        head === null
          ? { empty: before }
          : { revision: { repo: root, commit: head, filePath: before } };
      modified = index;
      title = l10n.t("desktop.diff.index", named);
    }
    return showDiff({
      title,
      original,
      modified,
      ...(revealLine !== undefined && { revealLine }),
      hunks: hunkRead(file, area),
      ...(said !== undefined && { said })
    });
  };

  /** What became of a hunk, said over the diff shown after it. */
  const outcomeSaid = (outcome: HunkOutcome): string | undefined => {
    switch (outcome.kind) {
      case "applied":
        return undefined;
      case "stale":
        return l10n.t("desktop.diff.stale");
      case "none":
        return whyNoHunks(outcome.reason, l10n) ?? l10n.t("desktop.diff.stale");
      case "failed":
        return l10n.t("desktop.diff.hunkFailed", outcome.error);
    }
  };

  return {
    show: (request, said) => show(request, said),
    hunk: async ({ path: file, area, token, hunk }) => {
      const outcome = await service.applyHunk({ path: file, area, token, hunk });
      // Shown where the hunk was: the next one, or what is left, is there.
      const line =
        outcome.kind === "applied" ? Math.max(outcome.hunk.modified.start, 1) : undefined;
      return show({ command: "workingTreeShowDiff", path: file, area }, outcomeSaid(outcome), line);
    }
  };
}
