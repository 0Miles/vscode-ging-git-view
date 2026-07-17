import type { SimpleGit } from "simple-git";

import type {
  CommitOrdering,
  DateType,
  GitCommitNode,
  GitLogEntry,
  GitRefData,
  QueryResult
} from "@/backend/types";

import { loadStashes } from "./loadStashes";

const commitOrderFlag: Record<CommitOrdering, string> = {
  date: "--date-order",
  "author-date": "--author-date-order",
  topo: "--topo-order"
};

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
    commitOrderFlag[commitOrder]
  ];
  if (onlyFollowFirstParent) args.push("--first-parent");
  // The branch filter (from the Branches side-view) may select several refs. A
  // selection that is empty or contains the "" sentinel means "all branches";
  // otherwise entries are specific branch names and/or `glob:<pattern>` markers,
  // combined into a single `git log` invocation.
  const globs = branches.filter((b) => b.startsWith("glob:")).map((b) => b.slice(5));
  const named = branches.filter((b) => b !== "" && !b.startsWith("glob:"));
  const showAll = branches.length === 0 || branches.indexOf("") > -1;
  if (!showAll) {
    for (const glob of globs) {
      args.push("--branches=" + glob);
      if (showRemoteBranches) {
        // `--exclude` applies to the next ref-listing option.
        for (const r of hiddenRemotes) args.push("--exclude=" + r + "/*");
        args.push("--remotes=" + glob);
      }
    }
    // Trailing "--" disambiguates refs from paths when a file shares a branch's
    // name (otherwise `git log <name>` is ambiguous and errors).
    if (named.length > 0) args.push(...named, "--");
  } else {
    args.push("--branches");
    // Including --tags brings in commits reachable only from a tag (not on any
    // branch); omit it to hide such commits.
    if (showCommitsOnlyReferencedByTags) args.push("--tags");
    if (showRemoteBranches) {
      // Exclude hidden remotes' branches; --exclude applies to --remotes.
      for (const r of hiddenRemotes) args.push("--exclude=" + r + "/*");
      args.push("--remotes");
    }
    // Include commits reachable only from the reflog (e.g. orphaned by a reset
    // or rebase) so they remain recoverable from the graph.
    if (includeCommitsMentionedByReflogs) args.push("--reflog");
    // Include HEAD so its commit still appears when it's detached (not on any
    // branch), e.g. during a rebase or after checking out a commit.
    args.push("HEAD");
  }
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
      let idx = commits.findIndex((c) => c.date < stash.date);
      if (idx === -1) idx = commits.length;
      // The graph layout assumes a commit's parents appear below it (a higher
      // index). Placing a stash purely by date can drop it *below* its base
      // commit — the stash date (%ct) and the commits' date basis (%at/%ct, per
      // dateType) can disagree, topo ordering isn't date-sorted at all, and
      // clock skew happens — which makes the stash's parent point upward and
      // hangs the layout walk (a frozen graph). Clamp the stash to sit at or
      // above its base so that invariant always holds.
      if (stash.baseHash !== null) {
        const baseIdx = commits.findIndex((c) => c.hash === stash.baseHash);
        if (baseIdx !== -1 && baseIdx < idx) idx = baseIdx;
      }
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
