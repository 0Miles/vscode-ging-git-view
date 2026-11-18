import * as cp from "node:child_process";

import { decode, encodingExists } from "iconv-lite";

import { readsAsOption } from "@ging/core/backend/utils/string";

/** A file's bytes as text in `encoding` (any iconv-lite knows), or in utf8
 *  when it knows no encoding of that name. */
export function decodeFileBytes(bytes: Buffer, encoding: string): string {
  return decode(bytes, encodingExists(encoding) ? encoding : "utf8");
}

/** What `getCommitFileBytes` answers for a file larger than it was asked to
 *  read. */
export const TOO_LARGE = Symbol("too large");

/**
 * A file's bytes at a given commit, raw: git is spawned directly (not via
 * simple-git) because simple-git only yields utf8 strings, which would
 * corrupt files stored in another encoding. Empty if the path doesn't exist
 * at that commit (e.g. the parent side of an added file), or if git fails.
 * With `maxBytes`, a file larger than that is not read to its end:
 * `TOO_LARGE`, and git is stopped.
 *
 * A revision git would read as an option (`readsAsOption`) is answered as
 * empty, never run.
 */
export function getCommitFileBytes(
  gitPath: string,
  repoPath: string,
  commit: string,
  filePath: string,
  maxBytes?: number
): Promise<Buffer | typeof TOO_LARGE> {
  if (readsAsOption(commit)) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    const child = cp.spawn(gitPath, ["show", commit + ":" + filePath], { cwd: repoPath });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (maxBytes !== undefined && size > maxBytes) {
        if (!tooLarge) {
          tooLarge = true;
          child.kill();
        }
        return;
      }
      chunks.push(c);
    });
    child.stdout.on("error", () => {});
    child.on("error", () => resolve(Buffer.alloc(0)));
    child.on("close", (code) => {
      if (tooLarge) return resolve(TOO_LARGE);
      if (code !== 0) return resolve(Buffer.alloc(0));
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Read a file's contents at a given commit and decode it with the configured
 *  `fileEncoding` (see `getCommitFileBytes`). Returns "" if the path doesn't
 *  exist at that commit (e.g. the parent side of an added file). */
export async function getCommitFileContent(
  gitPath: string,
  repoPath: string,
  commit: string,
  filePath: string,
  encoding: string
): Promise<string> {
  const bytes = await getCommitFileBytes(gitPath, repoPath, commit, filePath);
  return decodeFileBytes(bytes === TOO_LARGE ? Buffer.alloc(0) : bytes, encoding);
}
