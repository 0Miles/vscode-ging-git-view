import type { SimpleGit } from "simple-git";

import type { QueryResult } from "@/backend/types";

export async function loadRemotes(git: SimpleGit): Promise<QueryResult<"loadRemotes">> {
  try {
    const remotes = await git.getRemotes(false);
    let pushDefault: string | null = null;
    try {
      const value = (await git.raw(["config", "--get", "remote.pushDefault"])).trim();
      if (value !== "") pushDefault = value;
    } catch {
      // `git config --get` exits non-zero when the key is unset — leave it null.
    }
    return { remotes: remotes.map((r) => r.name), pushDefault };
  } catch {
    return { remotes: [], pushDefault: null };
  }
}
