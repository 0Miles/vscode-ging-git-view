import type { SimpleGit } from "simple-git";

import { gitFolderPlace } from "@ging/core/backend/utils/git";

/** The repository `initRepository` leaves in a folder, and whether it made it. */
export type InitializedRepo = {
  /** Its top folder, as git spells it (forward slashes): how every repository
   *  the graph knows is spelled. */
  repo: string;
  /** False when the folder already was the top of a working tree, which is
   *  then left as it was. */
  created: boolean;
};

/** A folder no repository is initialized in: a bare repository, or a `.git`
 *  folder or inside one. `git init` there would re-initialize that repository
 *  or nest a new one in its database; neither is what the user asked for. */
export class NoWorkTreeFolderError extends Error {
  constructor(readonly folder: string) {
    super(`${folder} is a bare repository or inside a .git folder`);
    this.name = "NoWorkTreeFolderError";
  }
}

/**
 * A repository in `folder` (#394): `git init` there — git makes the folder if
 * it is not there yet — unless it already is the top of a working tree, which
 * is left as it is rather than re-initialised. A folder inside another
 * repository's working tree gets one of its own, as `git init` gives it. A
 * folder with no working tree to give (`NoWorkTreeFolderError`) gets none.
 *
 * `git` is bound to no repository: the folder is named on each command line
 * (`-C`), not as the client's `baseDir`, which must already exist.
 */
export async function initRepository(git: SimpleGit, folder: string): Promise<InitializedRepo> {
  const place = await gitFolderPlace(git, folder);
  if (place === "noWorkTree") throw new NoWorkTreeFolderError(folder);
  const existing = place === "workTreeTop";
  if (!existing) await git.raw(["init", "--", folder]);
  const repo = (await git.raw(["-C", folder, "rev-parse", "--show-toplevel"])).trim();
  return { repo, created: !existing };
}
