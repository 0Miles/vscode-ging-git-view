/**
 * The vocabulary of branch refs, shared by the backend queries, the extension
 * host and the webview. Two spellings of the same branch are in play throughout
 * the codebase and mixing them up fails silently:
 *
 * - the **branch-list format** (`main`, `remotes/origin/main`) — what
 *   `loadBranches` returns and what the side-view and the graph filter use;
 * - the **full refname** (`refs/heads/main`, `refs/remotes/origin/main`) — what
 *   `git for-each-ref` emits.
 *
 * The graph's ref chips carry a third, display spelling (`origin/main`), which
 * {@link displayRef} produces.
 */

export const REMOTE_PREFIX = "remotes/";

/** Names a repo's default branch is likely to have, in preference order. Used
 *  both to sort them to the top of the side-view and to resolve the default
 *  branch when no `<remote>/HEAD` is configured. */
export const PRIMARY_BRANCHES = ["main", "master", "develop", "dev", "trunk"];

/** A ref as shown to the user: the `remotes/` prefix is an implementation
 *  detail of the branch-list format, not something to put in front of a reader.
 *  Also the form the graph's ref chips carry, so it doubles as the normaliser
 *  when matching host-sent refs against rendered chips. */
export function displayRef(ref: string): string {
  return ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : ref;
}

/** Split a branch-list-format remote ref into its remote and the branch name
 *  under it (`remotes/origin/feature/x` → `origin` + `feature/x`), or null when
 *  the ref isn't remote-tracking. */
export function splitRemoteRef(ref: string): { remote: string; name: string } | null {
  if (!ref.startsWith(REMOTE_PREFIX)) return null;
  const rest = ref.slice(REMOTE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  return { remote: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

/** A full refname converted to the branch-list format: `refs/heads/x` → `x`,
 *  `refs/remotes/o/x` → `remotes/o/x`; null for anything else.
 *
 *  `refs/remotes/<remote>/HEAD` is dropped: it is a symbolic ref, not a branch
 *  in the list, and `git for-each-ref` would otherwise surface it as a phantom
 *  entry (its short form is a bare `origin`). */
export function branchKeyFromRefname(refname: string): string | null {
  if (refname.startsWith("refs/heads/")) return refname.slice("refs/heads/".length);
  if (refname.startsWith("refs/remotes/")) {
    const rest = refname.slice("refs/remotes/".length);
    return rest.endsWith("/HEAD") ? null : REMOTE_PREFIX + rest;
  }
  return null;
}

/** `git for-each-ref --format=%(refname)` output — full refnames, one per line —
 *  in the branch-list format; unparseable and non-branch lines are dropped. */
export function parseRefnames(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => branchKeyFromRefname(line.trim()))
    .filter((key): key is string => key !== null);
}
