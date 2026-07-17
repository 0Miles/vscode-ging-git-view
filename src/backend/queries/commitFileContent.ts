import * as cp from "node:child_process";

import { decode, encodingExists } from "iconv-lite";

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
      const buffer = Buffer.concat(chunks);
      resolve(decode(buffer, encodingExists(encoding) ? encoding : "utf8"));
    });
  });
}
