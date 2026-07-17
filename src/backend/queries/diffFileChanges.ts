import type { GitFileChange, GitFileChangeType } from "@/backend/types";

/** Normalise a git-reported path to forward slashes. */
export function toPath(str: string) {
  return str.replace(/\\/g, "/");
}

const gitPathEscapes: { [k: string]: string } = {
  '"': '"',
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v"
};

/** Reverse git's path quoting: paths containing special characters (e.g. a
 *  double quote, backslash, or control char) are wrapped in double quotes with
 *  C-style escapes. Plain (unquoted) paths are returned unchanged. */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const inner = p.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (gitPathEscapes[next] !== undefined) {
        out += gitPathEscapes[next];
        i++;
        continue;
      }
      const octal = inner.substr(i + 1, 3);
      if (/^[0-7]{3}$/.test(octal)) {
        out += String.fromCharCode(parseInt(octal, 8));
        i += 3;
        continue;
      }
    }
    out += inner[i];
  }
  return out;
}

/** Parse paired `--name-status` and `--numstat` diff output into a list of file
 *  changes. `firstFileLine` skips a leading commit-hash line when present (the
 *  single-commit `--root` form prints one; two-argument diffs do not). Shared by
 *  the commit-details and commit-comparison queries. */
export function parseDiffFileChanges(
  nameStatusLines: string[],
  numStatLines: string[],
  firstFileLine: number
): GitFileChange[] {
  const fileChanges: GitFileChange[] = [];
  const fileLookup: { [file: string]: number } = {};
  for (let i = firstFileLine; i < nameStatusLines.length - 1; i++) {
    const line = nameStatusLines[i].split("\t");
    if (line.length < 2) break;
    const oldFilePath = toPath(unquoteGitPath(line[1]));
    const newFilePath = toPath(unquoteGitPath(line[line.length - 1]));
    fileLookup[newFilePath] = fileChanges.length;
    fileChanges.push({
      oldFilePath,
      newFilePath,
      type: line[0][0] as GitFileChangeType,
      additions: null,
      deletions: null
    });
  }

  for (let i = firstFileLine; i < numStatLines.length - 1; i++) {
    const line = numStatLines[i].split("\t");
    if (line.length !== 3) break;
    const fileName = toPath(unquoteGitPath(line[2]))
      .replace(/(.*){.* => (.*)}/, "$1$2")
      .replace(/.* => (.*)/, "$1");
    if (typeof fileLookup[fileName] === "number") {
      fileChanges[fileLookup[fileName]].additions = parseInt(line[0]);
      fileChanges[fileLookup[fileName]].deletions = parseInt(line[1]);
    }
  }

  return fileChanges;
}
