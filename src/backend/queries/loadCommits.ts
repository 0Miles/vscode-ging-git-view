import type { SimpleGit } from "simple-git";

import type {
  CommitOrdering,
  DateType,
  GitCommitNode,
  GitLogEntry,
  GitRefData,
  QueryResult
} from "@/backend/types";

import { gitLogScopeArgs, gitLogTraversalArgs } from "./gitLogScope";
import { type GraphStash, loadStashes } from "./loadStashes";

const eolRegex = /\r\n|\r|\n/g;
const gitLogSeparator = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb";

type LoadCommitsInput = {
  /** Branch refs to show commits from; see the request type. */
  branchNames: string[];
  maxCommits: number;
  showRemoteBranches: boolean;
  hard: boolean;
  dateType: DateType;
  showUncommittedChanges: boolean;
  commitOrder: CommitOrdering;
  onlyFollowFirstParent: boolean;
  showUntrackedFiles: boolean;
  showCommitsOnlyReferencedByTags: boolean;
  showRemoteHeads: boolean;
  includeCommitsMentionedByReflogs: boolean;
  showSignatureStatus: boolean;
  showStashes: boolean;
  useMailmap: boolean;
  /** Remote names whose branches are hidden. */
  hiddenRemotes: string[];
};

async function getRefs(
  git: SimpleGit,
  showRemoteBranches: boolean,
  showRemoteHeads: boolean,
  hiddenRemotes: string[]
): Promise<GitRefData> {
  try {
    const args = ["show-ref"];
    if (!showRemoteBranches) args.push("--heads", "--tags");
    args.push("-d", "--head");
    const stdout = await git.raw(args);
    const refData: GitRefData = { head: null, refs: [] };
    const lines = stdout.split(eolRegex);
    for (let i = 0; i < lines.length - 1; i++) {
      const parts = lines[i].split(" ");
      if (parts.length < 2) continue;
      const hash = parts.shift()!;
      const ref = parts.join(" ");
      if (ref.startsWith("refs/heads/")) {
        refData.refs.push({ hash, name: ref.substring(11), type: "head" });
      } else if (ref.startsWith("refs/tags/")) {
        refData.refs.push({
          hash,
          name: ref.endsWith("^{}") ? ref.substring(10, ref.length - 3) : ref.substring(10),
          type: "tag"
        });
      } else if (ref.startsWith("refs/remotes/")) {
        const name = ref.substring(13);
        // Don't show labels for branches of a hidden remote.
        if (hiddenRemotes.some((r) => name === r || name.startsWith(r + "/"))) continue;
        // Skip the symbolic "<remote>/HEAD" ref unless remote heads are shown.
        if (showRemoteHeads || !name.endsWith("/HEAD")) {
          refData.refs.push({ hash, name, type: "remote" });
        }
      } else if (ref === "HEAD") {
        refData.head = hash;
      }
    }
    return refData;
  } catch {
    return { head: null, refs: [] };
  }
}

async function getLog(
  git: SimpleGit,
  branches: string[],
  maxCommits: number,
  showRemoteBranches: boolean,
  dateType: DateType,
  commitOrder: CommitOrdering,
  onlyFollowFirstParent: boolean,
  showCommitsOnlyReferencedByTags: boolean,
  includeCommitsMentionedByReflogs: boolean,
  showSignatureStatus: boolean,
  useMailmap: boolean,
  hiddenRemotes: string[]
): Promise<GitLogEntry[]> {
  const dateField = dateType === "Author Date" ? "%at" : "%ct";
  // %aN/%aE always apply .mailmap; %an/%ae never do (the --use-mailmap flag has
  // no effect on these format placeholders), so switch placeholders directly.
  const nameField = useMailmap ? "%aN" : "%an";
  const emailField = useMailmap ? "%aE" : "%ae";
  const fields = ["%H", "%P", nameField, emailField, dateField, "%s"];
  // %G? appends the signature-verification status; only request it on demand,
  // since verifying signatures for every commit is comparatively expensive.
  if (showSignatureStatus) fields.push("%G?");
  const format = fields.join(gitLogSeparator);
  const expectedFields = fields.length;
  const args = [
    "log",
    `--max-count=${maxCommits}`,
    `--format=${format}`,
    ...gitLogTraversalArgs(commitOrder, onlyFollowFirstParent)
  ];
  args.push(
    ...gitLogScopeArgs({
      branchNames: branches,
      showRemoteBranches,
      hiddenRemotes,
      includeTagOnlyCommits: showCommitsOnlyReferencedByTags,
      includeReflogCommits: includeCommitsMentionedByReflogs
    })
  );
  try {
    const stdout = await git.raw(args);
    const lines = stdout.split(eolRegex);
    const commits: GitLogEntry[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].split(gitLogSeparator);
      if (line.length !== expectedFields) break;
      commits.push({
        hash: line[0],
        parentHashes: line[1] === "" ? [] : line[1].split(" "),
        author: line[2],
        email: line[3],
        date: parseInt(line[4]),
        message: line[5],
        signatureStatus: showSignatureStatus ? line[6] : ""
      });
    }
    return commits;
  } catch {
    return [];
  }
}

async function getUnsavedChanges(git: SimpleGit) {
  try {
    const status = await git.status();
    // The uncommitted-changes node counts staged + tracked working-tree changes
    // only. `not_added` (untracked paths, a subset of `files`) never contributes,
    // so a tree with nothing but untracked files shows no node.
    const changes = status.files.length - status.not_added.length;
    if (changes <= 0) return null;
    return { branch: status.current ?? "HEAD", changes };
  } catch {
    return null;
  }
}

/**
 * Which row a stash belongs on within the loaded commits, or -1 when its row
 * lies past the end of a truncated window.
 *
 * The row is the first loaded commit older than the stash — or the stash's base
 * commit, when that one sits higher still. **That clamp to the base is a
 * correctness requirement, not tidiness.** The graph layout assumes a commit's
 * parents appear below it (a higher index), and a stash's date can disagree
 * with the commits around it in three ways: the stash date is always its
 * committer date (%ct) while the commits carry %at or %ct per `dateType`, topo
 * ordering isn't date-sorted at all, and clock skew happens. Any of those can
 * place a stash *below* its own base, pointing its only parent upward, which
 * the layout walk cannot terminate on (see `tests/webview/graphLayout.test.ts`).
 *
 * When neither exists, the stash is older than everything loaded, so its row is
 * past the last loaded one. Appending it there — what this used to do — makes
 * the row a function of how much is loaded: the stash sits at the bottom of
 * whatever happens to be loaded, then moves down each time a later load reveals
 * the commits that belong above it. So the end of the list counts as a real row
 * only when the list *is* the whole history; otherwise the stash waits for the
 * window to reach the commits it belongs among.
 *
 * That wait has a price, and it is deliberate: the graph is the only surface
 * that offers a stash's actions, so a stash with no row has none until the
 * window reaches it. A row nobody can predict is the worse of the two.
 */
function stashRow(commits: GitLogEntry[], stash: GraphStash, windowIsTruncated: boolean): number {
  const byDate = commits.findIndex((c) => c.date < stash.date);
  const base = stash.baseHash === null ? -1 : commits.findIndex((c) => c.hash === stash.baseHash);
  if (base !== -1 && (byDate === -1 || base < byDate)) return base;
  if (byDate !== -1) return byDate;
  return windowIsTruncated ? -1 : commits.length;
}

export async function loadCommits(
  git: SimpleGit,
  input: LoadCommitsInput
): Promise<QueryResult<"loadCommits">> {
  const {
    branchNames,
    maxCommits,
    showRemoteBranches,
    hard,
    dateType,
    showUncommittedChanges,
    commitOrder,
    onlyFollowFirstParent,
    showCommitsOnlyReferencedByTags,
    showRemoteHeads,
    includeCommitsMentionedByReflogs,
    showSignatureStatus,
    showStashes,
    useMailmap,
    hiddenRemotes
  } = input;

  const [rawCommits, refData] = await Promise.all([
    getLog(
      git,
      branchNames,
      maxCommits + 1,
      showRemoteBranches,
      dateType,
      commitOrder,
      onlyFollowFirstParent,
      showCommitsOnlyReferencedByTags,
      includeCommitsMentionedByReflogs,
      showSignatureStatus,
      useMailmap,
      hiddenRemotes
    ),
    getRefs(git, showRemoteBranches, showRemoteHeads, hiddenRemotes)
  ]);

  let commits = rawCommits;
  const moreCommitsAvailable = commits.length === maxCommits + 1;
  if (moreCommitsAvailable) commits = commits.slice(0, -1);

  if (refData.head !== null) {
    for (let i = 0; i < commits.length; i++) {
      if (refData.head === commits[i].hash) {
        const unsaved = showUncommittedChanges ? await getUnsavedChanges(git) : null;
        if (unsaved !== null) {
          commits.unshift({
            hash: "*",
            parentHashes: [refData.head],
            author: "*",
            email: "",
            date: Math.round(new Date().getTime() / 1000),
            message: `Uncommitted Changes (${unsaved.changes})`,
            signatureStatus: ""
          });
        }
        break;
      }
    }
  }

  if (showStashes) {
    // Merge stashes in as commit nodes (first parent = their base commit),
    // positioned by date, and add a "stash" ref so they're labelled on the graph.
    const stashes = await loadStashes(git);
    for (const stash of stashes) {
      const idx = stashRow(commits, stash, moreCommitsAvailable);
      // The stash belongs below everything this window holds; it gets its row
      // (and its label with it) once the window reaches that far.
      if (idx === -1) continue;
      commits.splice(idx, 0, {
        hash: stash.hash,
        parentHashes: stash.baseHash !== null ? [stash.baseHash] : [],
        author: "",
        email: "",
        date: stash.date,
        message: stash.message,
        signatureStatus: ""
      });
      refData.refs.push({ hash: stash.hash, name: stash.selector, type: "stash" });
    }
  }

  const commitNodes: GitCommitNode[] = [];
  const commitLookup: { [hash: string]: number } = {};
  for (let i = 0; i < commits.length; i++) {
    commitLookup[commits[i].hash] = i;
    commitNodes.push({
      hash: commits[i].hash,
      parentHashes: commits[i].parentHashes,
      author: commits[i].author,
      email: commits[i].email,
      date: commits[i].date,
      message: commits[i].message,
      refs: [],
      signatureStatus: commits[i].signatureStatus
    });
  }
  for (const ref of refData.refs) {
    if (typeof commitLookup[ref.hash] === "number") {
      commitNodes[commitLookup[ref.hash]].refs.push(ref);
    }
  }

  return { commits: commitNodes, head: refData.head, moreCommitsAvailable, hard };
}
