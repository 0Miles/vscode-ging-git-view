import { describe, expect, it } from "vitest";

import {
  createRemoteCommands,
  type RemoteCommandsDeps,
  type RemoteTarget
} from "@ging/core/extension/remoteCommands";
import type { GitRepoSet } from "@ging/shared/types";

import {
  fakeGit,
  fakePorts,
  type PromptReply,
  recordingRunRepoMutation
} from "@ging/core/tests/helpers";

// The remote commands, driven the way a user drives them: each question is
// answered in turn from a script, and one ordered log shows what was asked,
// which git commands ran, and whether they ran inside the host's
// `runRepoMutation`.

const REPO = "/repo";
const URLS = {
  origin: "https://example.com/origin.git",
  upstream: "https://example.com/upstream.git"
};

function harness(options: { repo?: string | null; hiddenRemotes?: string[] } = {}) {
  const { ports, calls, answers } = fakePorts();
  const git = fakeGit(calls);
  git.state.remotes = { ...URLS };
  const repos: GitRepoSet = {
    [REPO]: { columnWidths: null, hiddenRemotes: options.hiddenRemotes ?? [] }
  };
  const deps: RemoteCommandsDeps = {
    prompts: ports.prompts,
    l10n: ports.l10n,
    gitClientFor: git.clientFor,
    currentRepo: () => (options.repo === undefined ? REPO : options.repo),
    repoSource: { getRepos: () => repos, updateRepoState: ports.repoSource.updateRepoState },
    refreshGraph: () => calls.push(["refreshGraph"]),
    runRepoMutation: recordingRunRepoMutation(calls)
  };
  return {
    commands: createRemoteCommands(deps),
    deps,
    calls,
    git: git.state,
    /** Queue the user's answers, in the order the questions come. */
    answer: (...replies: PromptReply[]) => answers.replies.push(...replies)
  };
}

const ORIGIN: RemoteTarget = { repo: REPO, name: "origin", fetchUrl: URLS.origin };
const LISTED = ["git", REPO, "remote", "-v"];

/** The calls that ran git or the hook: none, for a flow that changed nothing. */
const effects = (calls: unknown[][]) =>
  calls.filter(([name]) => name === "git" || String(name).startsWith("runRepoMutation"));

describe("Add", () => {
  it("asks for a name, then a URL, and adds the remote inside the hook", async () => {
    const h = harness();
    h.answer("  fork  ", " https://example.com/fork.git ");
    await h.commands.add(REPO);
    expect(h.calls).toEqual([
      ["input", { prompt: "remotes.namePrompt" }],
      ["input", { prompt: "remotes.urlPrompt" }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "add", "fork", "https://example.com/fork.git"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["the name is dismissed", [undefined]],
    ["the name is blank", ["  "]],
    ["the URL is dismissed", ["fork", undefined]],
    ["the URL is blank", ["fork", ""]]
  ])("changes nothing when %s", async (_case, replies) => {
    const h = harness();
    h.answer(...replies);
    await h.commands.add(REPO);
    expect(effects(h.calls)).toEqual([]);
  });

  it("does nothing without a repository to add to", async () => {
    const h = harness();
    await h.commands.add(null);
    expect(h.calls).toEqual([]);
  });

  it("reports git's failure once the hook has finished", async () => {
    const h = harness();
    h.git.failure = "error: could not lock config file .git/config";
    h.answer("fork", "https://example.com/fork.git");
    await h.commands.add(REPO);
    expect(h.calls.slice(-2)).toEqual([
      ["runRepoMutation done", REPO],
      ["showError", "error.unableToManageRemote: could not lock config file .git/config"]
    ]);
  });

  it("reports a repo whose client cannot be built the same way", async () => {
    const h = harness();
    const commands = createRemoteCommands({
      ...h.deps,
      gitClientFor: () => {
        throw new Error("Cannot use simple-git on a directory that does not exist");
      }
    });
    h.answer("fork", "https://example.com/fork.git");
    await commands.add(REPO);
    expect(h.calls.slice(-3)).toEqual([
      ["runRepoMutation", REPO],
      ["runRepoMutation done", REPO],
      [
        "showError",
        "error.unableToManageRemote: Cannot use simple-git on a directory that does not exist"
      ]
    ]);
  });
});

describe("Edit URL", () => {
  it("asks starting from the URL listed, and sets the new one inside the hook", async () => {
    const h = harness();
    h.answer("https://example.com/moved.git");
    await h.commands.editUrl(ORIGIN);
    expect(h.calls).toEqual([
      ["input", { prompt: "remotes.urlPrompt", value: URLS.origin }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "set-url", "origin", "https://example.com/moved.git"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["dismissed", undefined],
    ["blank", " "],
    ["unchanged", ` ${URLS.origin} `]
  ])("changes nothing when the answer is %s", async (_case, reply) => {
    const h = harness();
    h.answer(reply);
    await h.commands.editUrl(ORIGIN);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("Rename", () => {
  it("asks starting from the name, and renames inside the hook", async () => {
    const h = harness();
    h.answer("mine");
    await h.commands.rename(ORIGIN);
    expect(h.calls).toEqual([
      ["input", { prompt: "remotes.renamePrompt", value: "origin" }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "rename", "origin", "mine"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["dismissed", undefined],
    ["blank", ""],
    ["unchanged", "origin "]
  ])("changes nothing when the answer is %s", async (_case, reply) => {
    const h = harness();
    h.answer(reply);
    await h.commands.rename(ORIGIN);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("Remove", () => {
  it("asks a modal question naming the remote, and removes it inside the hook", async () => {
    const h = harness();
    h.answer("remotes.removeConfirmYes");
    await h.commands.remove(ORIGIN);
    expect(h.calls).toEqual([
      ["choose", "remotes.removeConfirm|origin", { actions: ["remotes.removeConfirmYes"] }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "remove", "origin"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("changes nothing when the question is cancelled", async () => {
    const h = harness();
    h.answer(undefined);
    await h.commands.remove(ORIGIN);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("Manage Remotes", () => {
  it("offers the current repository's remotes, then a row to add one", async () => {
    const h = harness();
    h.answer(undefined);
    await h.commands.manageRemotes();
    expect(h.calls).toEqual([
      LISTED,
      [
        "pick",
        [{ label: "origin" }, { label: "upstream" }, { label: "remotes.add" }],
        { placeholder: "remotes.pickPrompt" }
      ]
    ]);
  });

  it("adds a remote as Add does", async () => {
    const h = harness();
    h.answer("remotes.add", "fork", "https://example.com/fork.git");
    await h.commands.manageRemotes();
    expect(h.calls.slice(2)).toEqual([
      ["input", { prompt: "remotes.namePrompt" }],
      ["input", { prompt: "remotes.urlPrompt" }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "add", "fork", "https://example.com/fork.git"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("asks what to do with the remote picked", async () => {
    const h = harness();
    h.answer("upstream", undefined);
    await h.commands.manageRemotes();
    expect(h.calls.slice(2)).toEqual([
      [
        "pick",
        [{ label: "remotes.editUrl" }, { label: "remotes.rename" }, { label: "remotes.remove" }],
        { placeholder: "remotes.actionPrompt|upstream" }
      ]
    ]);
    expect(effects(h.calls)).toEqual([LISTED]);
  });

  it("edits a URL starting from the one it listed", async () => {
    const h = harness();
    h.answer("upstream", "remotes.editUrl", "https://example.com/moved.git");
    await h.commands.manageRemotes();
    expect(h.calls.slice(3)).toEqual([
      ["input", { prompt: "remotes.urlPrompt", value: URLS.upstream }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "set-url", "upstream", "https://example.com/moved.git"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("renames the remote picked", async () => {
    const h = harness();
    h.answer("upstream", "remotes.rename", "theirs");
    await h.commands.manageRemotes();
    expect(h.calls.slice(3)).toEqual([
      ["input", { prompt: "remotes.renamePrompt", value: "upstream" }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "rename", "upstream", "theirs"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("removes the remote picked, once confirmed", async () => {
    const h = harness();
    h.answer("upstream", "remotes.remove", "remotes.removeConfirmYes");
    await h.commands.manageRemotes();
    expect(h.calls.slice(3)).toEqual([
      ["choose", "remotes.removeConfirm|upstream", { actions: ["remotes.removeConfirmYes"] }],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "remove", "upstream"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["the URL is left as it was", ["origin", "remotes.editUrl", URLS.origin]],
    ["the new name is blank", ["origin", "remotes.rename", "  "]],
    ["the removal is cancelled", ["origin", "remotes.remove", undefined]],
    ["adding is abandoned at the URL", ["remotes.add", "fork", undefined]]
  ])("changes nothing when %s", async (_case, replies) => {
    const h = harness();
    h.answer(...replies);
    await h.commands.manageRemotes();
    expect(effects(h.calls)).toEqual([LISTED]);
  });

  it("tells a remote named like the add row apart from the add row", async () => {
    const h = harness();
    h.git.remotes = { "remotes.add": URLS.origin };
    h.answer("remotes.add", undefined);
    await h.commands.manageRemotes();
    // The first row with that label is the remote, so its actions are offered.
    expect(h.calls[2]).toEqual([
      "pick",
      [{ label: "remotes.editUrl" }, { label: "remotes.rename" }, { label: "remotes.remove" }],
      { placeholder: "remotes.actionPrompt|remotes.add" }
    ]);
  });

  it.each([
    ["there is no current repository", { repo: null }],
    ["the current repository is not a known one", { repo: "/elsewhere" }]
  ])("says so when %s", async (_case, options) => {
    const h = harness(options);
    await h.commands.manageRemotes();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });

  it("reports a failure to list the remotes", async () => {
    const h = harness();
    h.git.failure = "fatal: not a git repository";
    await h.commands.manageRemotes();
    expect(h.calls).toEqual([
      LISTED,
      ["showError", "error.unableToManageRemote: not a git repository"]
    ]);
  });
});

describe("Show/Hide Remotes", () => {
  it("checks the shown remotes, and hides the ones left unchecked", async () => {
    const h = harness({ hiddenRemotes: ["fork"] });
    h.git.remotes = { ...URLS, fork: "https://example.com/fork.git" };
    h.answer(["origin"]);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([
      LISTED,
      [
        "pickMany",
        [
          { label: "origin", picked: true },
          { label: "upstream", picked: true },
          { label: "fork", picked: false }
        ],
        { placeholder: "remoteVisibility.prompt" }
      ],
      ["updateRepoState", REPO, { hiddenRemotes: ["upstream", "fork"] }],
      ["refreshGraph"]
    ]);
  });

  it("hides nothing when every remote is left checked", async () => {
    const h = harness({ hiddenRemotes: ["upstream"] });
    h.answer(["origin", "upstream"]);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls.find(([name]) => name === "updateRepoState")).toEqual([
      "updateRepoState",
      REPO,
      { hiddenRemotes: [] }
    ]);
  });

  it("writes nothing when the pick is dismissed", async () => {
    const h = harness();
    h.answer(undefined);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls.map(([name]) => name)).toEqual(["git", "pickMany"]);
  });

  it("says so when the repository has no remotes", async () => {
    const h = harness();
    h.git.remotes = {};
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([LISTED, ["showInformation", "fetch.noRemotes"]]);
  });

  it("reports a failure to list the remotes, rather than rejecting", async () => {
    const h = harness();
    h.git.failure = "fatal: not a git repository";
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([
      LISTED,
      ["showError", "error.unableToManageRemote: not a git repository"]
    ]);
  });

  it.each([
    ["there is no current repository", { repo: null }],
    ["the current repository is not a known one", { repo: "/elsewhere" }]
  ])("says so when %s", async (_case, options) => {
    const h = harness(options);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });
});

describe("list", () => {
  it("lists the repo's remotes with their URLs", async () => {
    const h = harness();
    h.git.remotes = { origin: URLS.origin };
    expect(await h.commands.list(REPO)).toEqual([
      { name: "origin", fetchUrl: URLS.origin, pushUrl: URLS.origin }
    ]);
    expect(h.calls).toEqual([LISTED]);
  });

  it("rejects, rather than throws, when the repo's client cannot be built", async () => {
    const h = harness();
    const commands = createRemoteCommands({
      ...h.deps,
      gitClientFor: () => {
        throw new Error("Cannot use simple-git on a directory that does not exist");
      }
    });
    const listed = commands.list(REPO);
    await expect(listed).rejects.toThrow("does not exist");
  });
});
