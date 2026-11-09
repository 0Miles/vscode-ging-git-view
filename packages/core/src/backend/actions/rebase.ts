import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

/** Rebase the currently checked-out branch onto `obj` (a branch name or commit
 *  hash). On conflict git stops mid-rebase and the error is surfaced. */
export async function rebaseOn(
  git: SimpleGit,
  input: ActionPayload<"rebaseOn">,
  signCommits: boolean = false
): Promise<void> {
  // `-S` GPG/SSH-signs the rebased commits.
  await git.rebase(signCommits ? ["-S", input.obj] : [input.obj]);
}

/**
 * Replay the commits in `upstream..tip` onto `newBase` — `git rebase --onto`.
 *
 * `upstream` is the exclusive lower bound of the range, so it must be the
 * ancestor of the two commits the caller selected; the webview resolves that
 * order before sending. `tip` is spelled as a branch name whenever one points
 * at that commit, which is what makes git move the branch; given a raw hash git
 * leaves HEAD detached at the replayed tip instead.
 */
export async function rebaseOnto(
  git: SimpleGit,
  input: ActionPayload<"rebaseOnto">,
  signCommits: boolean = false
): Promise<void> {
  const args = ["rebase"];
  if (signCommits) args.push("-S"); // GPG/SSH-sign the replayed commits
  args.push("--onto", input.newBase, input.upstream, input.tip);
  await git.raw(args);
}

/** What the action needs from the sequence editor: stage a todo, and afterwards
 *  say whether git actually consumed it. Kept as an interface so the action can
 *  be tested without the extension host's file plumbing. */
export interface RebaseTodoStager {
  stage(todo: string): void;
  wasApplied(): boolean;
  discard(): void;
}

/**
 * Replay a chosen subset of a range — `git rebase -i` with a todo we write.
 *
 * Only reached when the subset is a shape a range cannot spell: a gap in the
 * middle, or the newest commits dropped (see `planRebase`). `tip` is spelled as
 * a branch name whenever one points at it, which is what makes git move the
 * branch rather than leave the replay on a detached HEAD.
 *
 * The staged todo is verified afterwards. If git never asked our sequence
 * editor for it, every commit would have been kept and the rebase would look
 * like it worked — so that case is turned into a failure rather than reported
 * as success.
 */
export async function rebaseInteractive(
  git: SimpleGit,
  input: ActionPayload<"rebaseInteractive">,
  options: { signCommits?: boolean; stager: RebaseTodoStager }
): Promise<void> {
  const { stager } = options;
  stager.stage(input.todo);
  const args = ["rebase", "--interactive"];
  if (options.signCommits === true) args.push("-S"); // GPG/SSH-sign the replayed commits
  args.push("--onto", input.newBase, input.upstream);
  if (input.tip !== null) args.push(input.tip);
  try {
    await git.raw(args);
  } catch (e: unknown) {
    // git's own failure is the truth here — a conflict stops the rebase long
    // after the todo was read. Clear any todo it never got to, and let the real
    // error through rather than replacing it with a guess about the editor.
    stager.discard();
    throw e;
  }
  // git returned successfully, so a surviving staged todo can only mean the
  // sequence editor never ran: every commit was kept and nothing was dropped.
  if (!stager.wasApplied()) {
    stager.discard();
    throw new Error(
      "The prepared rebase todo never reached git, so no commits were dropped. Nothing was changed as requested."
    );
  }
}
