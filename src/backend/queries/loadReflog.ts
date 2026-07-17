import type { SimpleGit } from "simple-git";

// Collision-free separators (same convention as git-parser): reflog subjects
// never contain these control bytes. We split the *output* on the real bytes,
// but the format string must use git's `%x..` escapes — embedding a literal NUL
// in a command-line argument truncates it.
const RS = "\x01\x02\x03";
const FS = "\x00";
const RS_FMT = "%x01%x02%x03";
const FS_FMT = "%x00";

export type ReflogEntry = {
  hash: string;
  shortHash: string;
  /** Reflog selector, e.g. `HEAD@{0}`. Empty for dangling commits. */
  selector: string;
  /** Reflog message (e.g. `commit: msg`, `checkout: ...`) or commit subject. */
  subject: string;
  /** True for commits found only via `git fsck` (lost from the reflog too). */
  dangling: boolean;
};

function parseRecords(out: string, dangling: boolean, withSelector: boolean): ReflogEntry[] {
  return out
    .split(RS)
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      // Each git --format record ends with a newline, so the last field can
      // carry trailing whitespace; trim every field.
      const fields = rec.split(FS).map((f) => f.trim());
      return withSelector
        ? {
            hash: fields[0] ?? "",
            shortHash: fields[1] ?? "",
            selector: fields[2] ?? "",
            subject: fields[3] ?? "",
            dangling
          }
        : {
            hash: fields[0] ?? "",
            shortHash: fields[1] ?? "",
            selector: "",
            subject: fields[2] ?? "",
            dangling
          };
    });
}

/** The HEAD reflog — the primary way to recover commits that branch moves,
 *  resets, or rebases left behind. */
export async function loadReflog(git: SimpleGit, maxEntries = 150): Promise<ReflogEntry[]> {
  try {
    const out = await git.raw([
      "reflog",
      `--max-count=${maxEntries}`,
      `--format=${RS_FMT}%H${FS_FMT}%h${FS_FMT}%gd${FS_FMT}%gs`
    ]);
    return parseRecords(out, false, true);
  } catch {
    return [];
  }
}

/** Commits that are unreachable even via the reflog (`git fsck`). `--no-reflogs`
 *  treats reflogs as non-pinning so genuinely-lost commits surface; the notices
 *  are printed to stdout and fsck exits 0 when the repo is otherwise healthy. */
export async function loadDanglingCommits(git: SimpleGit): Promise<ReflogEntry[]> {
  try {
    const fsck = await git.raw(["fsck", "--no-reflogs", "--no-progress"]);
    const shas = fsck
      .split(/\r?\n/)
      .filter((line) => line.startsWith("dangling commit "))
      .map((line) => line.slice("dangling commit ".length).trim())
      // Cap the count so a never-gc'd repo can't blow past the OS arg limit
      // (notably the smaller one on Windows). More than this is rarely useful.
      .slice(0, 100);
    if (shas.length === 0) return [];
    const out = await git.raw([
      "log",
      "--no-walk",
      `--format=${RS_FMT}%H${FS_FMT}%h${FS_FMT}%s`,
      ...shas
    ]);
    return parseRecords(out, true, false);
  } catch {
    return [];
  }
}
