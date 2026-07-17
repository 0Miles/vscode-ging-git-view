// Repo-relative paths whose creation/change/deletion should refresh the graph:
// key .git ref/state files — including the in-progress-operation markers
// (MERGE_HEAD/REVERT_HEAD/CHERRY_PICK_HEAD/REBASE_HEAD and the rebase-merge/
// rebase-apply dirs) that drive the conflict banner — plus any working-tree
// file, plus root .git* files (.gitignore/.gitattributes/.gitmodules).
export const watchedRepoPathRegex =
  /(^\.git\/(config|index|HEAD|MERGE_HEAD|REVERT_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|rebase-merge\/.*|rebase-apply\/.*|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*)$)|(^(?!\.git).*$)|(^\.git[^/]+$)/;

/** Whether a repo-relative path change should trigger a graph refresh. */
export function isWatchedRepoPath(relativePath: string): boolean {
  return watchedRepoPathRegex.test(relativePath);
}
