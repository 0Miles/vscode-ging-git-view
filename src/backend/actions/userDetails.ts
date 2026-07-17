import type { SimpleGit } from "simple-git";

export type UserDetails = { name: string; email: string };

/** Read the effective git user name/email for the repository (empty strings
 *  when unset). */
export async function getUserDetails(git: SimpleGit): Promise<UserDetails> {
  const read = async (key: string): Promise<string> => {
    try {
      return (await git.raw(["config", "--get", key])).trim();
    } catch {
      return ""; // not configured
    }
  };
  return { name: await read("user.name"), email: await read("user.email") };
}

/**
 * Set the git user name and/or email. When `useGlobal` is true the
 * values are written to the global (`--global`) config, otherwise to the
 * repository's local config. Empty values are unset rather than written blank.
 */
export async function setUserDetails(
  git: SimpleGit,
  input: { name: string; email: string; useGlobal: boolean }
): Promise<void> {
  const scope = input.useGlobal ? ["--global"] : ["--local"];
  const apply = async (key: string, value: string) => {
    if (value !== "") {
      await git.raw(["config", ...scope, key, value]);
    } else {
      // Clearing the field: remove it (ignore "key not present" errors).
      await git.raw(["config", ...scope, "--unset", key]).catch(() => undefined);
    }
  };
  await apply("user.name", input.name);
  await apply("user.email", input.email);
}
