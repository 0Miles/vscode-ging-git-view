import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { SimpleGit } from "simple-git";

import { type DiffRun, readFileDiff } from "@ging/core/backend/queries/fileHunks";
import type { HunkArea, NoHunksReason } from "@ging/shared/backend/types";

/** One hunk of a file's diff, as the user was shown it (#406). */
export type HunkChoice = {
  /** The file, repository-relative. */
  path: string;
  /** Which diff: a hunk of the unstaged diff is staged, one of the staged
   *  diff unstaged. */
  area: HunkArea;
  /** The diff the hunk was shown from (`FileHunks.token`). */
  token: string;
  /** Which of its hunks, from 0. */
  hunk: number;
};

/** A hunk not applied because the file's diff is no longer the one it was
 *  shown from: the file, or the index, changed since. Nothing was changed. */
export class StaleHunkError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "StaleHunkError";
  }
}

/** A hunk not applied because the file's diff has none to apply on its own
 *  (`NoHunksReason`). Nothing was changed. */
export class NoHunkError extends Error {
  constructor(readonly reason: NoHunksReason) {
    super(`no hunk of its own to apply: ${reason}`);
    this.name = "NoHunkError";
  }
}

/** A patch of one hunk, ready for `applyHunkPatch`. */
export type HunkPatch = {
  /** The patch, byte for byte as git wrote its lines. */
  bytes: Buffer;
  /** Unstaged (the hunk is taken out of the index) rather than staged. */
  reverse: boolean;
};

/**
 * The patch that stages one hunk of `choice.path`'s unstaged diff, or
 * unstages one of its staged diff (#406), changing nothing. The diff is read
 * again, and a patch made only while it is still the very diff the user was
 * shown (`token`): a file changed on disk since, or an index changed under
 * it, is refused (`StaleHunkError`), never applied to lines that have moved.
 * The patch is that diff's header and the one hunk as git wrote them.
 */
export async function hunkPatch(git: SimpleGit, run: DiffRun, choice: HunkChoice): Promise<HunkPatch> {
  const diff = await readFileDiff(git, run, choice.path, choice.area);
  if (diff.kind === "none") {
    if (diff.reason === "unchanged") throw new StaleHunkError("the file's diff is empty now");
    throw new NoHunkError(diff.reason);
  }
  if (diff.token !== choice.token) throw new StaleHunkError("the file's diff has changed");
  const hunk = Number.isInteger(choice.hunk) ? diff.hunks[choice.hunk] : undefined;
  if (hunk === undefined) throw new StaleHunkError(`the diff has no hunk ${choice.hunk}`);
  return {
    bytes: Buffer.from(diff.header + hunk.text, "latin1"),
    reverse: choice.area === "staged"
  };
}

/**
 * Apply `patch` to the index alone (`git apply --cached`, `--reverse` to
 * unstage): the working tree never changes. git checks every context line
 * against the index before it writes, and matches it exactly — a user's
 * `apply.ignoreWhitespace` would let a hunk land on lines that only look
 * alike. Whitespace is applied as it is: a user's `apply.whitespace=error`
 * must not refuse a hunk the diff showed. Rejects when git refuses it.
 */
export async function applyHunkPatch(git: SimpleGit, patch: HunkPatch): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ging-hunk-"));
  const file = path.join(dir, "hunk.patch");
  try {
    await fs.writeFile(file, patch.bytes);
    await git.raw([
      "-c",
      "apply.ignoreWhitespace=no",
      "apply",
      "--cached",
      "--whitespace=nowarn",
      ...(patch.reverse ? ["--reverse"] : []),
      file
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Stage or unstage one hunk (`hunkPatch`, then `applyHunkPatch`). */
export async function applyHunk(git: SimpleGit, run: DiffRun, choice: HunkChoice): Promise<void> {
  await applyHunkPatch(git, await hunkPatch(git, run, choice));
}
