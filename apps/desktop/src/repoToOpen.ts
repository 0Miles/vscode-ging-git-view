/* What a launch's repository argument opens (#388), and a folder the user
 * points at (#394). */

import { gitFolderPlaceFor, workingTreeRoot } from "@ging/core/backend/utils/git";
import { isUsableRepoPathAsync } from "@ging/core/backend/utils/repoPath";

/** Why a path opens no repository: it is not a folder that is there (deleted,
 *  or on a disk not mounted now — nothing tells the two apart); it is one,
 *  in no repository; or it is a repository with no working tree to show (a
 *  bare one, or a `.git` folder). */
export type Unusable = "missing" | "notRepository" | "noWorkTree";

/** The repository to open, or the path that named none and why. */
export type RepoToOpen = { repo: string } | { unusable: string; why: Unusable };

/**
 * The repository `requested` names: first held to the test a stored Current
 * repository is held to (`resolveCurrentRepo`: a folder that is there —
 * asked without holding the main process, as the recent list asks it), then
 * to git's, which answers with the top of the working tree the folder is in.
 * So a folder inside a repository opens the repository — the graph's paths
 * are relative to its top — and comes back spelled as git spells it, which is
 * how every repository the graph knows is spelled.
 *
 * A path that fails either test is `unusable`: the webview is never handed a
 * repository it cannot load (`selectRepo` would only drop it again).
 */
export async function repoToOpen(requested: string, gitPath: string): Promise<RepoToOpen> {
  const folder = requested !== "" && (await isUsableRepoPathAsync(requested)) ? requested : null;
  if (folder === null) return { unusable: requested, why: "missing" };
  const repo = await workingTreeRoot(folder, gitPath);
  if (repo !== null) return { repo };
  // Asked only when it opens nothing: one more git, for what to say.
  const place = await gitFolderPlaceFor(folder, gitPath);
  return { unusable: requested, why: place === "noWorkTree" ? "noWorkTree" : "notRepository" };
}
