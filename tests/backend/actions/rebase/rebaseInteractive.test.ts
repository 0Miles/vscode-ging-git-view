import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rebaseInteractive, type RebaseTodoStager } from "@/backend/actions/rebase";
import { gitClientFactory } from "@/backend/gitClient";
import { rebaseTodo } from "@/backend/utils/rebasePlan";
import { shellCommandPath } from "@/backend/utils/shellPath";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

// Drives the real helper git runs as GIT_SEQUENCE_EDITOR — the shell script and
// the node bundle, not a stand-in. The mechanism is the part of this feature
// most likely to break silently (a todo that never reaches git keeps every
// commit and still exits 0), so it is tested end to end against git.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const OUT = path.join(REPO_ROOT, "out");

/**
 * Run the project's own build so the helper exists.
 *
 * CI runs `pnpm run test` on a fresh checkout with nothing built before it, so
 * reading out/ directly made these fail for a reason unrelated to the code they
 * cover. Building here rather than reusing whatever is lying in out/ also keeps
 * the test honest about the source, and makes it notice if the helper ever
 * stops being built at all.
 */
beforeAll(() => {
  cp.execFileSync(process.execPath, ["esbuild.js"], { cwd: REPO_ROOT, stdio: "pipe" });
}, 120_000);

let repo: string;
let todoPath: string;

/** The manager's contract, backed by the same file the shipped helper reads. */
function stager(): RebaseTodoStager {
  return {
    stage: (todo) => fs.writeFileSync(todoPath, todo, "utf8"),
    wasApplied: () => !fs.existsSync(todoPath),
    discard: () => {
      try {
        fs.unlinkSync(todoPath);
      } catch {
        /* nothing staged */
      }
    }
  };
}

/** The shipped client, carrying the same sequence-editor environment the
 *  extension hands it — including the stripping of inherited GIT_CONFIG_*. */
function client() {
  return gitClientFactory(repo, "git", undefined, {
    GIT_SEQUENCE_EDITOR: shellCommandPath(path.join(OUT, "sequenceEditor.sh")),
    GING_SEQUENCE_EDITOR_NODE: process.execPath,
    GING_SEQUENCE_EDITOR_MAIN: path.join(OUT, "sequenceEditorMain.js"),
    GING_REBASE_TODO: todoPath
  }).getInstance();
}

function commit(name: string) {
  fs.writeFileSync(path.join(repo, name + ".txt"), name);
  git(["add", "."], repo);
  git(["commit", "-m", name], repo);
  return cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function subjects(ref: string): string[] {
  return cp
    .execFileSync("git", ["log", "--format=%s", ref], { cwd: repo })
    .toString()
    .trim()
    .split("\n");
}

// base ← keep ← c1 ← c2 ← c3 on "topic"; "target" sits on main.
let keep: string, c1: string, c2: string, c3: string, target: string;

beforeEach(() => {
  repo = makeRepo();
  todoPath = path.join(os.tmpdir(), `ging-test-todo-${Math.abs(Date.now() % 1e9)}-${repo.length}`);
  commit("base");
  git(["checkout", "-b", "topic"], repo);
  keep = commit("keep");
  c1 = commit("c1");
  c2 = commit("c2");
  c3 = commit("c3");
  git(["checkout", "main"], repo);
  target = commit("target");
  git(["checkout", "topic"], repo);
});

afterEach(() => {
  rmrf(repo);
  try {
    fs.unlinkSync(todoPath);
  } catch {
    /* already consumed */
  }
});

describe("rebaseInteractive", () => {
  it("drops a commit from the middle and still moves the branch", async () => {
    const todo = rebaseTodo([
      { hash: c1, message: "c1", keep: true },
      { hash: c2, message: "c2", keep: false },
      { hash: c3, message: "c3", keep: true }
    ]);

    await rebaseInteractive(
      client(),
      { newBase: target, upstream: keep, tip: "topic", todo },
      { stager: stager() }
    );

    // c2 is gone, the rest replayed onto target, and topic is what moved.
    expect(subjects("topic")).toEqual(["c3", "c1", "target", "base", "init"]);
    expect(
      cp.execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo }).toString().trim()
    ).toBe("topic");
  });

  it("drops the newest commits — the case a plain range cannot express", async () => {
    const todo = rebaseTodo([
      { hash: c1, message: "c1", keep: true },
      { hash: c2, message: "c2", keep: false },
      { hash: c3, message: "c3", keep: false }
    ]);

    await rebaseInteractive(
      client(),
      { newBase: target, upstream: keep, tip: "topic", todo },
      { stager: stager() }
    );

    expect(subjects("topic")).toEqual(["c1", "target", "base", "init"]);
  });

  it("consumes the staged todo, so a survivor means the editor never ran", async () => {
    const s = stager();
    await rebaseInteractive(
      client(),
      {
        newBase: target,
        upstream: keep,
        tip: "topic",
        todo: rebaseTodo([{ hash: c1, message: "c1", keep: true }])
      },
      { stager: s }
    );
    expect(s.wasApplied()).toBe(true);
  });

  it("fails loudly when the todo never reaches git rather than keeping everything", async () => {
    // A client without the sequence-editor environment: git falls back to
    // GIT_EDITOR=true, keeps its own todo, and would replay every commit.
    const plain = gitClientFactory(repo, "git").getInstance();

    await expect(
      rebaseInteractive(
        plain,
        {
          newBase: target,
          upstream: keep,
          tip: "topic",
          todo: rebaseTodo([{ hash: c1, message: "c1", keep: false }])
        },
        { stager: stager() }
      )
    ).rejects.toThrow(/never reached git/);
  });
});
