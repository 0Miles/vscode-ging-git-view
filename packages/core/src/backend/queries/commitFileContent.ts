import * as cp from "node:child_process";

import { decode, encodingExists } from "iconv-lite";

/** A file's bytes as text in `encoding` (any iconv-lite knows), or in utf8
 *  when it knows no encoding of that name. */
export function decodeFileBytes(bytes: Buffer, encoding: string): string {
  return decode(bytes, encodingExists(encoding) ? encoding : "utf8");
}

/** Read a file's contents at a given commit and decode it with the configured
 *  `fileEncoding`. git is spawned directly (not via simple-git) because
 *  the file bytes must be captured raw — simple-git only yields utf8 strings,
 *  which would corrupt files stored in another encoding. Returns "" if the path
 *  doesn't exist at that commit (e.g. the parent side of an added file). */
export function getCommitFileContent(
  gitPath: string,
  repoPath: string,
  commit: string,
  filePath: string,
  encoding: string
): Promise<string> {
  return new Promise((resolve) => {
    const child = cp.spawn(gitPath, ["show", commit + ":" + filePath], { cwd: repoPath });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stdout.on("error", () => {});
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      if (code !== 0) return resolve("");
      resolve(decodeFileBytes(Buffer.concat(chunks), encoding));
    });
  });
}
