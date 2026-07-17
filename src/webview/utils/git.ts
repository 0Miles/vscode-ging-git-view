export const refInvalid = /^[-/].*|[\\" ><~^:?*[]|\.\.|\/\/|\/\.|@{|[./]$|\.lock$|^@$/g;
export const ELLIPSIS = "&#8230;";

/** Case-insensitive match of a Find-widget query against a commit's searchable
 *  fields: message, author name/email, hash, and ref (branch/tag) names. */
export function commitMatchesQuery(
  commit: {
    message: string;
    author: string;
    email: string;
    hash: string;
    refs: { name: string }[];
  },
  query: string
): boolean {
  const q = query.toLowerCase();
  if (q === "") return false;
  if (
    commit.message.toLowerCase().includes(q) ||
    commit.author.toLowerCase().includes(q) ||
    commit.email.toLowerCase().includes(q) ||
    commit.hash.toLowerCase().includes(q)
  ) {
    return true;
  }
  return commit.refs.some((ref) => ref.name.toLowerCase().includes(q));
}

/**
 * Build the plain-text hover tooltip for a commit node, listing whether it is
 * the checked-out commit (HEAD) and the branches/tags that reference it. Returns
 * an empty string when there is nothing noteworthy to show. `labels` carries the
 * localized line templates ("{0}" is replaced with the comma-separated names).
 */
export function commitNodeTooltip(
  refs: { name: string; type: string }[],
  isHead: boolean,
  labels: { head: string; branches: string; tags: string }
): string {
  const lines: string[] = [];
  if (isHead) lines.push(labels.head);
  const branches = refs.filter((r) => r.type === "head" || r.type === "remote").map((r) => r.name);
  const tags = refs.filter((r) => r.type === "tag").map((r) => r.name);
  if (branches.length > 0) lines.push(labels.branches.replace("{0}", branches.join(", ")));
  if (tags.length > 0) lines.push(labels.tags.replace("{0}", tags.join(", ")));
  return lines.join("\n");
}

/**
 * Name of the most recent tag among the loaded commits (commits are in graph
 * order, newest first), or null if none are tagged. Used to hint the previous
 * tag when adding a new one.
 */
export function latestTagName(
  commits: { refs: { name: string; type: string }[] }[]
): string | null {
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.type === "tag") return ref.name;
    }
  }
  return null;
}

/**
 * Substitute spaces in a reference (branch/tag) name as the user types, since
 * git refs cannot contain spaces. "None" leaves the value untouched.
 */
export function substituteRefSpaces(value: string, mode: "None" | "Hyphen" | "Underscore"): string {
  if (mode === "Hyphen") return value.replace(/ /g, "-");
  if (mode === "Underscore") return value.replace(/ /g, "_");
  return value;
}

/**
 * Set of commit hashes reachable from any of `startHashes` by following parent
 * links (the starts themselves are included). `parentsOf` returns a commit's
 * parent hashes, or undefined when the commit isn't loaded.
 */
export function commitsReachableFrom(
  startHashes: string[],
  parentsOf: (hash: string) => string[] | undefined
): Set<string> {
  const reachable = new Set<string>();
  const stack = [...startHashes];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    if (reachable.has(hash)) continue;
    reachable.add(hash);
    const parents = parentsOf(hash);
    if (parents !== undefined) for (const p of parents) stack.push(p);
  }
  return reachable;
}

/**
 * Map git's `%G?` signature status to a display category, or null when the
 * commit is unsigned / the status wasn't requested. G = good; U (unknown
 * validity) and E (cannot check) = unverified; B/X/Y/R = bad/expired/revoked.
 */
export function signatureCategory(
  status: string | undefined
): "good" | "unverified" | "bad" | null {
  switch (status) {
    case "G":
      return "good";
    case "U":
    case "E":
      return "unverified";
    case "B":
    case "X":
    case "Y":
    case "R":
      return "bad";
    default:
      return null;
  }
}

/**
 * Topological check for whether a commit can be dropped. Dropping runs
 * `git rebase --onto <hash>~1 <hash>`, replaying the commits after it onto its
 * parent — so it's only safe when the commit has a parent and lies on a linear,
 * non-merge chain of descendants that reaches HEAD (no merge or fork in between
 * that the rebase would disturb). Children/HEAD are restricted to loaded commits.
 */
export function dropCommitPossible(
  startHash: string,
  commits: { hash: string; parentHashes: string[] }[],
  commitLookup: { [hash: string]: number },
  commitHead: string | null
): boolean {
  if (commitHead === null) return false;
  const startIdx = commitLookup[startHash];
  // Only a non-merge commit that has exactly one parent can be rebased away.
  if (startIdx === undefined || commits[startIdx].parentHashes.length !== 1) return false;

  // Map each loaded commit to the loaded commits that name it as a parent.
  const childrenOf: { [hash: string]: string[] } = {};
  for (const commit of commits) {
    for (const parent of commit.parentHashes) {
      if (commitLookup[parent] !== undefined) (childrenOf[parent] ||= []).push(commit.hash);
    }
  }

  // Walk forward (towards newer commits) from startHash. The path is droppable
  // only if every step has a single child that is itself non-merge, until we
  // land exactly on HEAD. A fork, a merge, a dead end, or a cycle disqualifies it.
  let cursor = startHash;
  const walked = new Set<string>();
  while (cursor !== commitHead) {
    if (walked.has(cursor)) return false;
    walked.add(cursor);
    const kids = childrenOf[cursor];
    if (kids === undefined || kids.length !== 1) return false;
    const next = kids[0];
    const nextIdx = commitLookup[next];
    if (nextIdx === undefined || commits[nextIdx].parentHashes.length > 1) return false;
    cursor = next;
  }
  return true;
}

/**
 * Pick the commit to navigate to from the Commit Details View. "parent"
 * (Down) follows a parent of `current`; "child" (Up) follows a commit that has
 * `current` as a parent. `alternative` selects the second branch at a fork/merge
 * (e.g. CTRL/CMD+SHIFT) instead of the first — returning undefined when there
 * is no such alternative. Children are taken in loaded-commit order.
 */
export function graphNavigationTarget(
  current: { hash: string; parentHashes: string[] },
  commits: { hash: string; parentHashes: string[] }[],
  direction: "parent" | "child",
  alternative: boolean
): string | undefined {
  if (direction === "parent") {
    return current.parentHashes[alternative ? 1 : 0];
  }
  const children = commits.filter((c) => c.parentHashes.includes(current.hash));
  return children[alternative ? 1 : 0]?.hash;
}

/**
 * Whether a failed branch-deletion error indicates the branch is not fully
 * merged (so a force delete would succeed). Git's hint includes the
 * literal command `git branch -D`, which stays in English across locales, so
 * it is a reliable, translation-safe marker.
 */
export function isNotFullyMergedBranchError(status: string | null): boolean {
  return status !== null && status.includes("git branch -D");
}

export function arraysEqual<T>(a: T[], b: T[], equalElements: (a: T, b: T) => boolean) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!equalElements(a[i], b[i])) return false;
  }
  return true;
}
