import type { SimpleGit } from "simple-git";

import type {
  ActionPayload,
  StashApplyFacts,
  StashApplyFailure,
  StashRefusalFacts
} from "@ging/shared/backend/types";

type StashTarget = ActionPayload<"dropStash">;

/** A stash action refused before any stash command ran: its selector resolves
 *  to another commit than `expectedHash`, or to nothing. Why — see
 *  `StashTarget`. */
export class StashMovedError extends Error {
  constructor(
    readonly selector: string,
    readonly expectedHash: string,
    /** What `selector` resolved to instead, or null when it resolved to
     *  nothing — the stack is shorter than it was. */
    readonly actualHash: string | null
  ) {
    super(
      `${selector} no longer refers to stash ${expectedHash}` +
        (actualHash === null ? " (it no longer exists)" : ` (it is now ${actualHash})`)
    );
    this.name = "StashMovedError";
  }
}

/** What a stash action reports beside its status, read off the error it threw
 *  (null when it succeeded). */
export function stashRefusalFacts(error: unknown): StashRefusalFacts {
  return { movedSelector: error instanceof StashMovedError ? error.selector : null };
}

/**
 * Refuse with `StashMovedError` unless `selector` still resolves to
 * `expectedHash`; return that SHA when it does.
 *
 * The consent check all four stash actions share. It cannot hold the stack
 * still until the stash command runs — the `rev-parse` here and that command
 * are two spawns — and how much of that window is left differs per action:
 *
 * - apply hands git `expectedHash` itself, so what lands in the working tree
 *   is fixed: a push in the window cannot make it apply another stash. A stash
 *   dropped in the window still applies, since the commit outlives its entry.
 * - pop and drop take only a `stash@{n}`, so a push in the window still
 *   renumbers the stack under them.
 * - rename drops the old entry by `selector`, so a push before that drop
 *   still makes it drop another stash.
 *
 * What is gone for all four is the long window: from the moment the caller
 * read the selector to the moment the action reached the host.
 */
async function verifyStashSelector(
  git: SimpleGit,
  selector: string,
  expectedHash: string
): Promise<string> {
  const actualHash = await stashSelectorTarget(git, selector);
  if (actualHash !== expectedHash) {
    throw new StashMovedError(selector, expectedHash, actualHash);
  }
  return expectedHash;
}

/** The commit `selector` names now; null when it names nothing. */
async function stashSelectorTarget(git: SimpleGit, selector: string): Promise<string | null> {
  // `--verify --quiet`: a selector that names nothing — past the end of the
  // stack — exits non-zero with no output, which simple-git resolves as "".
  // Any other failure (not a repository, git missing) rejects, and is git's to
  // report.
  return (await git.raw(["rev-parse", "--verify", "--quiet", selector])).trim() || null;
}

/**
 * Whether `selector` still names the stash `expectedHash` — the consent rule
 * every stash action is held to (`verifyStashSelector`), for a caller that
 * refuses on its own terms instead of with `StashMovedError`.
 */
export async function stashSelectorResolvesTo(
  git: SimpleGit,
  selector: string,
  expectedHash: string
): Promise<boolean> {
  return (await stashSelectorTarget(git, selector)) === expectedHash;
}

const STASH_APPLY_FAILURE_MESSAGES: Record<StashApplyFailure["kind"], string> = {
  unmergedBefore: "the working tree already has unmerged paths, so no stash command ran",
  conflicted: "the stash was applied with conflicts",
  unchanged: "the stash was not applied"
};

/** An apply or pop that did not go through, and why (`StashApplyFailure`).
 *  Its message is git's when git threw, so `formatGitError` still finds git's
 *  line in it. */
export class StashApplyError extends Error {
  constructor(
    readonly failure: StashApplyFailure,
    /** What git threw, or null when it threw nothing. */
    cause: unknown
  ) {
    super(
      cause instanceof Error ? cause.message : STASH_APPLY_FAILURE_MESSAGES[failure.kind],
      cause === null ? undefined : { cause }
    );
    this.name = "StashApplyError";
  }
}

/** What an apply or pop reports beside its status, read off the error it
 *  threw (null when it succeeded). */
export function stashApplyFacts(error: unknown): StashApplyFacts {
  return {
    ...stashRefusalFacts(error),
    applyFailure: error instanceof StashApplyError ? error.failure : null
  };
}

/** The working tree's unmerged paths. */
async function unmergedPaths(git: SimpleGit): Promise<string[]> {
  const out = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
  return out.split(/\r\n|\r|\n/).filter((line) => line !== "");
}

/** Where `sha` sits in the stash list now — the first place, should
 *  `git stash store` have put it there twice — or null when it is not listed. */
async function stashPosition(git: SimpleGit, sha: string): Promise<string | null> {
  const out = await git.raw(["stash", "list", "--format=%H %gd"]);
  for (const line of out.split(/\r\n|\r|\n/)) {
    const [hash, selector] = line.split(" ");
    if (hash === sha && selector !== undefined) return selector;
  }
  return null;
}

/**
 * Run an apply or pop, judging a failure by the unmerged paths before and
 * after it rather than by what git printed (#337); see `StashApplyFailure`.
 *
 * The check before narrows a window but cannot close it: the working tree can
 * still change between it and the run, as the stack can between
 * `verifyStashSelector` and the run.
 */
async function runApplyOrPop(
  git: SimpleGit,
  input: StashTarget,
  run: () => Promise<unknown>
): Promise<void> {
  if ((await unmergedPaths(git)).length > 0) {
    throw new StashApplyError({ kind: "unmergedBefore" }, null);
  }
  await verifyStashSelector(git, input.selector, input.expectedHash);
  let failed = false;
  let error: unknown = null;
  try {
    await run();
  } catch (e) {
    failed = true;
    error = e;
  }
  // Read even after a run that resolved: a conflicted apply exits non-zero
  // with git's report on stdout alone, and simple-git resolves that.
  const judged = await judgeRun(git, input.expectedHash, failed, error);
  if (judged !== null) throw judged;
}

/** What to throw after a run, given whether it `failed` and with what
 *  `error`; null when it went through. When the unmerged paths cannot be
 *  read, a failure is thrown as git reported it and a success stands. */
async function judgeRun(
  git: SimpleGit,
  sha: string,
  failed: boolean,
  error: unknown
): Promise<unknown> {
  let unmerged: string[];
  try {
    unmerged = await unmergedPaths(git);
  } catch {
    return failed ? error : null;
  }
  if (unmerged.length === 0) {
    return failed ? new StashApplyError({ kind: "unchanged" }, error) : null;
  }
  // Looked up again rather than taken from the request: a push or drop since
  // the check moves the stash, and the selector agreed to may name another.
  const keptAs = await stashPosition(git, sha).catch(() => null);
  return new StashApplyError({ kind: "conflicted", keptAs }, error);
}

/** Apply a stash to the working tree, keeping it in the stash list. With
 *  `reinstateIndex`, the stash's staged changes are restored to the index too.
 *  Fails with `StashApplyError` when it does not go through. */
export async function applyStash(
  git: SimpleGit,
  input: ActionPayload<"applyStash">
): Promise<void> {
  await runApplyOrPop(git, input, () => {
    const args = ["stash", "apply"];
    if (input.reinstateIndex) args.push("--index");
    // Safe because verified first: a byte-equal full SHA. A short or all-digit
    // token would read as something else, so the check must stay first.
    args.push(input.expectedHash);
    return git.raw(args);
  });
}

/** Apply a stash and drop it from the stash list on success. Fails with
 *  `StashApplyError` when it does not go through. */
export async function popStash(git: SimpleGit, input: ActionPayload<"popStash">): Promise<void> {
  await runApplyOrPop(git, input, () => {
    const args = ["stash", "pop"];
    if (input.reinstateIndex) args.push("--index");
    args.push(input.selector);
    return git.raw(args);
  });
}

/** Delete a stash from the stash list. */
export async function dropStash(git: SimpleGit, input: ActionPayload<"dropStash">): Promise<void> {
  await verifyStashSelector(git, input.selector, input.expectedHash);
  await git.raw(["stash", "drop", input.selector]);
}

/** Rename a stash. Git has no native rename, and `git stash store -m` only sets
 *  the reflog message (`%gs`) while the stash's *displayed* message is its commit
 *  subject (`%s`). So we rebuild the stash commit with the new subject — same
 *  tree and parents (base/index/untracked), new message — via `commit-tree`,
 *  then drop the old entry and store the rebuilt commit.
 *
 *  The replacement commit is built BEFORE the drop, so a failure can't lose the
 *  stash. Caveat: `stash store` pushes onto the top of the stack, so a renamed
 *  stash moves to `stash@{0}`. */
export async function renameStash(
  git: SimpleGit,
  input: ActionPayload<"renameStash">
): Promise<void> {
  // A wider window than pop/drop: three more spawns sit between this and the drop.
  const sha = await verifyStashSelector(git, input.selector, input.expectedHash);
  const tree = (await git.raw(["rev-parse", `${sha}^{tree}`])).trim();
  // `rev-list --parents -n 1 <sha>` → "<sha> <parent>...": drop the commit's
  // own sha, keep its parents (a stash has base + index [+ untracked]).
  const revList = (await git.raw(["rev-list", "--parents", "-n", "1", sha])).trim();
  const parentArgs = revList
    .split(/\s+/)
    .slice(1)
    .flatMap((parent) => ["-p", parent]);
  const newCommit = (
    await git.raw(["commit-tree", tree, ...parentArgs, "-m", input.message])
  ).trim();
  await git.raw(["stash", "drop", input.selector]);
  try {
    await git.raw(["stash", "store", "-m", input.message, newCommit]);
  } catch (e: unknown) {
    // The drop succeeded but the re-store didn't: the stash is gone from the
    // list yet the rebuilt commit is reachable. Tell the user how to recover it.
    throw new Error(`stash store failed after drop; recover with: git stash store ${newCommit}`, {
      cause: e
    });
  }
}
