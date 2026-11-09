import type { SimpleGit } from "simple-git";

/** Add a new remote. */
export async function addRemote(
  git: SimpleGit,
  input: { name: string; url: string }
): Promise<void> {
  await git.raw(["remote", "add", input.name, input.url]);
}

/** Remove a remote and its remote-tracking references. */
export async function removeRemote(git: SimpleGit, input: { name: string }): Promise<void> {
  await git.raw(["remote", "remove", input.name]);
}

/** Rename a remote. */
export async function renameRemote(
  git: SimpleGit,
  input: { oldName: string; newName: string }
): Promise<void> {
  await git.raw(["remote", "rename", input.oldName, input.newName]);
}

/** Change a remote's fetch URL. */
export async function setRemoteUrl(
  git: SimpleGit,
  input: { name: string; url: string }
): Promise<void> {
  await git.raw(["remote", "set-url", input.name, input.url]);
}

/** The fetch URL configured for a remote, or "" if it has none. */
export async function getRemoteUrl(git: SimpleGit, name: string): Promise<string> {
  try {
    return (await git.raw(["remote", "get-url", name])).trim();
  } catch {
    return "";
  }
}
