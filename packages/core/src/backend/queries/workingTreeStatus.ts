import type { SimpleGit } from "simple-git";

import { detectOperation } from "@ging/core/backend/queries/operationState";
import type { WorkingTreeChange, WorkingTreeStatus } from "@ging/shared/backend/types";

/** A status letter of `git status --porcelain=v2`, on one side of the index;
 *  `.` is no change there. */
const CHANGES: Record<string, WorkingTreeChange> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typeChanged"
};

/** `line` cut after its first `count` space-separated fields, and the rest
 *  whole: a path may hold spaces. */
function fieldsThenRest(line: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const space = line.indexOf(" ", at);
    if (space === -1) return { fields, rest: "" };
    fields.push(line.slice(at, space));
    at = space + 1;
  }
  return { fields, rest: line.slice(at) };
}

/** Parse `git status --porcelain=v2 --branch -z` (git 2.11+). */
export function parseWorkingTreeStatus(out: string): WorkingTreeStatus {
  const status: WorkingTreeStatus = { branch: null, staged: [], unstaged: [], conflicted: [] };
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      status.branch = head === "(detached)" ? null : head;
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      // `1 XY sub mH mI mW hH hI path`, and an extra score field before the
      // path of a `2` (a rename or copy), whose original path is the next record.
      const ordinary = record.startsWith("1 ");
      const { fields, rest: path } = fieldsThenRest(record, ordinary ? 8 : 9);
      const [x, y] = fields[1];
      // `N...` for a file, `S<c><m><u>` for a submodule.
      const submodule = fields[2]?.startsWith("S") === true ? { submodule: true as const } : {};
      const oldPath = ordinary ? undefined : records[++i];
      if (x !== ".") {
        status.staged.push({
          path,
          ...(oldPath !== undefined && { oldPath }),
          change: CHANGES[x],
          ...submodule
        });
      }
      if (y !== ".") status.unstaged.push({ path, change: CHANGES[y], ...submodule });
    } else if (record.startsWith("u ")) {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
      status.conflicted.push({ path: fieldsThenRest(record, 10).rest, change: "conflicted" });
    } else if (record.startsWith("? ")) {
      status.unstaged.push({ path: record.slice(2), change: "untracked" });
    }
  }
  return status;
}

/**
 * The working tree's changes, staged and not, the branch checked out, and the
 * operation in progress, if any. Every untracked file is listed, not only its
 * folder, so each can be staged on its own. Read without git's optional lock:
 * a plain `git status` may refresh and write the index, and that write would
 * hold `index.lock` against the user's next stage or commit, and wake the
 * file watcher besides.
 */
export async function workingTreeStatus(git: SimpleGit): Promise<WorkingTreeStatus> {
  const [out, operation] = await Promise.all([
    git.raw([
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "-z"
    ]),
    detectOperation(git)
  ]);
  const status = parseWorkingTreeStatus(out);
  return operation === null ? status : { ...status, operation };
}
