/* What a launch's repository argument opens (#388). */

import { workingTreeRoot } from "@ging/core/backend/utils/git";
import { resolveCurrentRepo } from "@ging/core/backend/utils/repoPath";

/** The repository to open, or the path that named none. */
export type RepoToOpen = { repo: string } | { unusable: string };

/**
 * The repository `requested` names: first held to the test a stored Current
 * repository is held to (`resolveCurrentRepo`: a folder that is there), then
 * to git's, which answers with the top of the working tree the folder is in.
 * So a folder inside a repository opens the repository — the graph's paths
 * are relative to its top — and comes back spelled as git spells it, which is
 * how every repository the graph knows is spelled.
 *
 * A path that fails either test is `unusable`: the webview is never handed a
 * repository it cannot load (`selectRepo` would only drop it again).
 */
export async function repoToOpen(requested: string, gitPath: string): Promise<RepoToOpen> {
  const folder = resolveCurrentRepo(requested);
  const repo = folder === null ? null : await workingTreeRoot(folder, gitPath);
  return repo === null ? { unusable: requested } : { repo };
}
