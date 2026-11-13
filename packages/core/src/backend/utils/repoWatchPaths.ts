// Repo-relative paths whose creation/change/deletion should refresh the graph:
// key .git ref/state files — including the in-progress-operation markers
// (MERGE_HEAD/REVERT_HEAD/CHERRY_PICK_HEAD/REBASE_HEAD and the rebase-merge/
// rebase-apply dirs) that drive the conflict banner — plus any working-tree
// file, plus root .git* files (.gitignore/.gitattributes/.gitmodules).
// The rebase dirs must match with AND without a trailing path: when a rebase
// finishes, VS Code's watcher often reports only the deletion of the directory
// itself (".git/rebase-merge"), and that event is what clears the banner.
export const watchedRepoPathRegex =
  /(^\.git\/(config|index|HEAD|MERGE_HEAD|REVERT_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|rebase-merge(\/.*)?|rebase-apply(\/.*)?|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*)$)|(^(?!\.git).*$)|(^\.git[^/]+$)/;

/** Whether a repo-relative path change should trigger a graph refresh. */
export function isWatchedRepoPath(relativePath: string): boolean {
  return watchedRepoPathRegex.test(relativePath);
}

/** How long a repository's watched files must stay quiet before what shows
 *  them re-reads: the graph's watcher and the Stash side-view's alike. */
export const REPO_CHANGE_DEBOUNCE_MS = 750;

/** How long after the graph's watcher is unmuted it still ignores changes.
 *  GING's own git command has finished by then, but the file system may still
 *  be reporting what it did. */
export const REPO_RESUME_GRACE_MS = 1500;
