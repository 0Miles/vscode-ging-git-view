import { describe, expect, it } from "vitest";

import { FS, RS } from "@ging/core/backend/queries/loadReflog";
import { createReflogCommand, type ReflogCommandDeps } from "@ging/core/extension/reflogCommand";

import {
  fakeGit,
  fakePorts,
  type PromptReply,
  recordingRunRepoMutation
} from "@ging/core/tests/helpers";

// The View Reflog command, driven the way a user drives it: each question is
// answered in turn from a script, and one ordered log shows what was asked,
// which git commands ran, and whether they ran inside the host's
// `runRepoMutation`.

const REPO = "/repo";
const MOVED = "1".repeat(40);
const COMMITTED = "2".repeat(40);
const LOST = "3".repeat(40);

/** git's records, in the framing `loadReflog` asks for. */
const records = (...rows: string[][]) => rows.map((fields) => RS + fields.join(FS) + "\n").join("");

const REFLOG = records(
  [MOVED, "1111111", "HEAD@{0}", "checkout: moving from main to topic"],
  [COMMITTED, "2222222", "HEAD@{1}", "commit: Fix the thing"]
);

function harness(options: { repo?: string | null; reflog?: string; dangling?: boolean } = {}) {
  const { ports, calls, answers } = fakePorts();
  const git = fakeGit(calls);
  git.state.stdout = {
    reflog: options.reflog ?? REFLOG,
    ...(options.dangling
      ? {
          fsck: `dangling blob ${"9".repeat(40)}\ndangling commit ${LOST}\n`,
          log: records([LOST, "3333333", "Work in progress"])
        }
      : {})
  };
  const deps: ReflogCommandDeps = {
    prompts: ports.prompts,
    clipboard: ports.clipboard,
    l10n: ports.l10n,
    gitClientFor: git.clientFor,
    currentRepo: () => (options.repo === undefined ? REPO : options.repo),
    repoSource: { getRepos: () => ({ [REPO]: { columnWidths: null } }) },
    runRepoMutation: recordingRunRepoMutation(calls)
  };
  return {
    command: createReflogCommand(deps),
    deps,
    calls,
    answers,
    git: git.state,
    /** Queue the user's answers, in the order the questions come. */
    answer: (...replies: PromptReply[]) => answers.replies.push(...replies)
  };
}

/** The calls that ran git or the hook, after the reads that list the entries. */
const effects = (calls: unknown[][]) =>
  calls.filter(
    (call) =>
      (call[0] === "git" && !["reflog", "fsck", "log"].includes(String(call[2]))) ||
      String(call[0]).startsWith("runRepoMutation")
  );

/** What the user is asked, in order. */
const questions = (calls: unknown[][]) =>
  calls.filter(([name]) => ["pick", "input", "choose"].includes(String(name)));

const ENTRY = "2222222  commit: Fix the thing";
const ACTIONS = {
  createBranch: "reflog.createBranch",
  reset: "reflog.resetHard",
  copy: "reflog.copyHash"
};

describe("View Reflog", () => {
  it("says there is no repository, and reads nothing, without a current one", async () => {
    const h = harness({ repo: null });
    await h.command.viewReflog();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });

  it("offers the reflog, then the commits dangling beyond it, flagged as a warning", async () => {
    const h = harness({ dangling: true });
    await h.command.viewReflog();
    expect(questions(h.calls)).toEqual([
      [
        "pick",
        [
          {
            label: "1111111  checkout: moving from main to topic",
            description: "HEAD@{0}",
            warning: false
          },
          { label: ENTRY, description: "HEAD@{1}", warning: false },
          { label: "3333333  Work in progress", description: "reflog.danglingTag", warning: true }
        ],
        { placeholder: "reflog.pickPrompt", matchOnDescription: true }
      ]
    ]);
  });

  it("says the reflog is empty when there is nothing to offer", async () => {
    const h = harness({ reflog: "" });
    await h.command.viewReflog();
    expect(h.calls.at(-1)).toEqual(["showInformation", "reflog.empty"]);
    expect(questions(h.calls)).toEqual([]);
  });

  it("reports a repo whose client cannot be built", async () => {
    const h = harness();
    const command = createReflogCommand({
      ...h.deps,
      gitClientFor: () => {
        throw new Error("Cannot use simple-git on a directory that does not exist");
      }
    });
    await command.viewReflog();
    expect(h.calls).toEqual([
      ["showError", "reflog.unableTo: Cannot use simple-git on a directory that does not exist"]
    ]);
  });

  it("asks what to do with the entry picked", async () => {
    const h = harness();
    h.answer(ENTRY, undefined);
    await h.command.viewReflog();
    expect(questions(h.calls).at(-1)).toEqual([
      "pick",
      [{ label: ACTIONS.createBranch }, { label: ACTIONS.reset }, { label: ACTIONS.copy }],
      { placeholder: "reflog.actionPrompt|2222222" }
    ]);
    expect(effects(h.calls)).toEqual([]);
  });

  it("changes nothing when the entry pick is dismissed", async () => {
    const h = harness();
    h.answer(undefined);
    await h.command.viewReflog();
    expect(questions(h.calls)).toHaveLength(1);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("Create branch", () => {
  it("asks for a name and branches from the entry, without checking it out, inside the hook", async () => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.createBranch, "  rescued  ");
    await h.command.viewReflog();
    expect(questions(h.calls).at(-1)).toEqual(["input", { prompt: "reflog.branchNamePrompt" }]);
    expect(effects(h.calls)).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "branch", "rescued", COMMITTED],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["dismissed", undefined],
    ["blank", "   "]
  ])("changes nothing when the name is %s", async (_case, name) => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.createBranch, name);
    await h.command.viewReflog();
    expect(effects(h.calls)).toEqual([]);
  });

  it("reports git's failure once the hook has finished", async () => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.createBranch, "main");
    // git fails from the moment the name is asked for: the reads have run.
    const { prompts } = h.deps;
    const command = createReflogCommand({
      ...h.deps,
      prompts: {
        ...prompts,
        input: (options) => {
          h.git.failure = "fatal: a branch named 'main' already exists";
          return prompts.input(options);
        }
      }
    });
    await command.viewReflog();
    expect(h.calls.slice(-2)).toEqual([
      ["runRepoMutation done", REPO],
      ["showError", "reflog.unableTo: a branch named 'main' already exists"]
    ]);
  });
});

describe("Reset (hard)", () => {
  it("resets hard to the entry once the user confirms, inside the hook", async () => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.reset, "reflog.resetConfirmYes");
    await h.command.viewReflog();
    expect(questions(h.calls).at(-1)).toEqual([
      "choose",
      "reflog.resetConfirm|2222222",
      { detail: undefined, actions: ["reflog.resetConfirmYes"] }
    ]);
    expect(effects(h.calls)).toEqual([
      ["runRepoMutation", REPO],
      ["git", REPO, "reset", "--hard", COMMITTED],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("changes nothing when the confirmation is dismissed", async () => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.reset, undefined);
    await h.command.viewReflog();
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("Copy hash", () => {
  it("copies the entry's full hash, changing nothing", async () => {
    const h = harness();
    h.answer(ENTRY, ACTIONS.copy);
    await h.command.viewReflog();
    expect(h.calls.at(-1)).toEqual(["writeText", COMMITTED]);
    expect(effects(h.calls)).toEqual([]);
  });

  it("reports a clipboard that cannot be written", async () => {
    const h = harness();
    h.answers.clipboard = Promise.reject(new Error("denied"));
    h.answer(ENTRY, ACTIONS.copy);
    await h.command.viewReflog();
    expect(h.calls.at(-1)).toEqual(["showError", "reflog.unableTo: denied"]);
  });
});
