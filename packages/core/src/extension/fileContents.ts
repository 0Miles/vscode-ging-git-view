/* What an editor of the desktop host shows of a file (#404): its contents at a
 * revision, or as the working tree has them, as text decoded per the
 * `defaultFileEncoding` setting. The VS Code host reads the revision side
 * through its own `DiffDocProvider` and leaves the working tree's file to VS
 * Code; the desktop host has neither, and an app may not run core's queries
 * itself (ADR-0027), so both reads are here. */

import { promises as fs } from "node:fs";

import {
  decodeFileBytes,
  getCommitFileContent
} from "@ging/core/backend/queries/commitFileContent";

import type { DiffSide } from "./commitDiff";

/** `side`'s file at its revision, in `encoding`; "" where the revision has no
 *  such file — the parent of an added file, the commit of a deleted one. A
 *  revision is anything `git show <revision>:<path>` takes: a commit, or `:0`
 *  for the index. */
export function readFileAtRevision(
  gitPath: string,
  side: DiffSide,
  encoding: string
): Promise<string> {
  return getCommitFileContent(gitPath, side.repo, side.commit, side.filePath, encoding);
}

/** The working tree's `file` (an absolute path), in `encoding`; "" when there
 *  is no such file, as a revision without it reads: deleted in the working
 *  tree, its diff is everything removed. Rejects when it is there but cannot
 *  be read. */
export async function readWorkingFile(file: string, encoding: string): Promise<string> {
  try {
    return decodeFileBytes(await fs.readFile(file), encoding);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    throw e;
  }
}
