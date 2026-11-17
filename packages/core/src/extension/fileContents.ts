/* What an editor of the desktop host shows of a file (#404): its contents at a
 * revision, or as the working tree has them, as text decoded per the
 * `defaultFileEncoding` setting — or why it shows none: a binary file, or one
 * too large to hand an editor. The VS Code host reads the revision side
 * through its own `DiffDocProvider` and leaves the working tree's file to VS
 * Code; the desktop host has neither, and an app may not run core's queries
 * itself (ADR-0027), so both reads are here. */

import { promises as fs } from "node:fs";

import {
  decodeFileBytes,
  getCommitFileBytes,
  TOO_LARGE
} from "@ging/core/backend/queries/commitFileContent";

import type { DiffSide } from "./commitDiff";

/** A file as an editor can show it: its text, or why there is none. */
export type FileText = { kind: "text"; text: string } | { kind: "binary" } | { kind: "tooLarge" };

/** The most of a file read for an editor, in bytes: past it the file is not
 *  shown. A diff's two sides travel to the page whole, and Monaco slows to a
 *  crawl long before files this size anyway. */
export const FILE_TEXT_LIMIT = 5 * 1024 * 1024;

/** How far into a file git looks for a NUL byte to call it binary
 *  (`buffer_is_binary`, xdiff-interface.c). */
const BINARY_PEEK = 8000;

/** `bytes` as text, unless git would call them binary: a NUL in the first
 *  8000 bytes. A UTF-16 file has them too, and git does not diff it as text
 *  either. */
function asText(bytes: Buffer, encoding: string): FileText {
  if (bytes.subarray(0, BINARY_PEEK).includes(0)) return { kind: "binary" };
  return { kind: "text", text: decodeFileBytes(bytes, encoding) };
}

/** `side`'s file at its revision, in `encoding`; empty text where the
 *  revision has no such file — the parent of an added file, the commit of a
 *  deleted one. A revision is anything `git show <revision>:<path>` takes: a
 *  commit, or `:0` for the index. */
export async function readFileAtRevision(
  gitPath: string,
  side: DiffSide,
  encoding: string,
  limit = FILE_TEXT_LIMIT
): Promise<FileText> {
  const bytes = await getCommitFileBytes(gitPath, side.repo, side.commit, side.filePath, limit);
  return bytes === TOO_LARGE ? { kind: "tooLarge" } : asText(bytes, encoding);
}

/** The working tree's `file` (an absolute path), in `encoding`; empty text
 *  when there is no such file, as a revision without it reads: deleted in the
 *  working tree, its diff is everything removed. Rejects when it is there
 *  but cannot be read. */
export async function readWorkingFile(
  file: string,
  encoding: string,
  limit = FILE_TEXT_LIMIT
): Promise<FileText> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "text", text: "" };
    throw e;
  }
  if (size > limit) return { kind: "tooLarge" };
  return asText(await fs.readFile(file), encoding);
}
