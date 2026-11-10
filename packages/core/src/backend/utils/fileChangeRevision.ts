import type { GitFileChangeOrigin } from "@ging/shared/backend/types";

/**
 * The revision a commit's file change is read from: the commit itself, or, for
 * a stash's untracked file, the stash's third parent — the commit `git stash
 * push --include-untracked` keeps those files in, since the stash's own tree
 * has only its tracked files. The one place a file change's `origin` becomes a
 * revision: `commitDetails` lists the untracked files from here, and every
 * reader of a CDV file (View Diff through `commitDiffView`, View File at
 * Revision, View Diff with Working) reads them from here, as Reset File to this
 * Revision restores them from here. The webview never names the revision
 * itself.
 */
export function fileChangeRevision(
  commitHash: string,
  origin: GitFileChangeOrigin | undefined
): string {
  return origin === "untracked" ? commitHash + "^3" : commitHash;
}
