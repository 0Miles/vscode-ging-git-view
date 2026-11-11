import type { SimpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import {
  createRemoteCommands,
  type RemoteCommandsDeps,
  type RemoteTarget
} from "@ging/core/extension/remoteCommands";
import type { PickItem, Prompts } from "@ging/core/host/ports";
import type { GitRepoState } from "@ging/shared/types";

import { fakePorts } from "@ging/core/tests/helpers";

// The remote commands, driven the way a user drives them: each question is
// answered in turn from a script, and one ordered log shows what was asked,
// which git commands ran, and whether they ran inside the host's
// `runRepoMutation`. Git is a fake that records its argv.

const shown = (items: readonly PickItem<unknown>[]) =>
  items.map(({ value: _value, ...row }) => row);

const REPO = "/repo";
const URLS: Record<string, string> = {
  origin: "https://example.com/origin.git",
  upstream: "https://example.com/upstream.git"
};

/** What the user answers, question by question: a label (or labels, for a
 *  pick of many) for a pick, the text typed for an input, yes or no for a
 *  confirm, and `undefined` to dismiss any of them. */
type Reply = string | string[] | boolean | undefined;

function harness(
  options: { repo?: string | null; remotes?: string[]; hiddenRemotes?: string[] } = {}
) {
  const { ports, calls } = fakePorts();
  const replies: Reply[] = [];
  /** Run once, as the next question is asked: what changes while it is open. */
  let whileAsking: (() => void) | undefined;
  const reply = () => {
    whileAsking?.();
    whileAsking = undefined;
    if (replies.length === 0) throw new Error("asked more than the script answers");
    return replies.shift();
  };
  const remotes = options.remotes ?? ["origin", "upstream"];
  let gitFails = false;
  let repos: Record<string, GitRepoState> = {
    [REPO]: { columnWidths: null, hiddenRemotes: options.hiddenRemotes ?? [] }
  };

  const fakeGit = (repo: string) =>
    ({
      getRemotes: async (verbose?: boolean) => {
        calls.push(["git", repo, "remote", ...(verbose ? ["-v"] : [])]);
        if (gitFails) throw new Error("fatal: not a git repository");
        return remotes.map((name) => ({ name, refs: { fetch: URLS[name], push: URLS[name] } }));
      },
      raw: async (args: string[]) => {
        calls.push(["git", repo, ...args]);
        if (gitFails) throw new Error("error: could not lock config file .git/config");
        return args[1] === "get-url" ? URLS[args[2]] + "\n" : "";
      }
    }) as unknown as SimpleGit;

  const prompts: Prompts = {
    ...ports.prompts,
    pick: async (items, pickOptions) => {
      calls.push(["pick", shown(items), pickOptions]);
      const label = reply();
      return items.find((item) => item.label === label)?.value;
    },
    pickMany: async (items, pickOptions) => {
      calls.push(["pickMany", shown(items), pickOptions]);
      const labels = reply() as string[] | undefined;
      return labels && items.filter((item) => labels.includes(item.label)).map((i) => i.value);
    },
    input: async (inputOptions) => {
      calls.push(["input", inputOptions]);
      return reply() as string | undefined;
    },
    choose: async (message, { actions }) => {
      calls.push(["choose", message, actions.map(({ label }) => label)]);
      return reply() === true ? actions[0].value : undefined;
    }
  };

  const deps: RemoteCommandsDeps = {
    prompts,
    l10n: ports.l10n,
    gitClientFor: fakeGit,
    currentRepo: () => (options.repo === undefined ? REPO : options.repo),
    repoSource: {
      getRepos: () => repos,
      setRepoState: (repo, state) => {
        calls.push(["setRepoState", repo, state]);
      }
    },
    broadcastRepos: () => calls.push(["broadcastRepos"]),
    refreshGraph: () => calls.push(["refreshGraph"]),
    runRepoMutation: async (repo, work) => {
      calls.push(["runRepoMutation", repo]);
      try {
        await work();
      } finally {
        calls.push(["runRepoMutation done", repo]);
      }
    }
  };
  return {
    commands: createRemoteCommands(deps),
    deps,
    calls,
    /** Queue the user's answers, in the order the questions come. */
    answer: (...answers: Reply[]) => replies.push(...answers),
    failGit: () => {
      gitFails = true;
    },
    /** Replace the known repos, with their state, while the next question
     *  is open. */
    setReposWhileAsking: (next: Record<string, GitRepoState>) => {
      whileAsking = () => {
        repos = next;
      };
    }
  };
}

const ORIGIN: RemoteTarget = { repo: REPO, name: "origin", fetchUrl: URLS.origin };

/** The calls that ran git or the hook: none, for a flow that changed nothing. */
const effects = (calls: unknown[][]) =>
  calls.filter(([name]) => name === "git" || String(name).startsWith("runRepoMutation"));

describe("the side view's Add", () => {
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
  ])("changes nothing when %s", async (_case, answers) => {
    const h = harness();
    h.answer(...answers);
    await h.commands.add(REPO);
    expect(effects(h.calls)).toEqual([]);
  });

  it("does nothing when the view shows no repository", async () => {
    const h = harness();
    await h.commands.add(null);
    expect(h.calls).toEqual([]);
  });

  it("reports git's failure once the hook has finished", async () => {
    const h = harness();
    h.failGit();
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

describe("the side view's Edit URL", () => {
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
  ])("changes nothing when the answer is %s", async (_case, answer) => {
    const h = harness();
    h.answer(answer);
    await h.commands.editUrl(ORIGIN);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("the side view's Rename", () => {
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
  ])("changes nothing when the answer is %s", async (_case, answer) => {
    const h = harness();
    h.answer(answer);
    await h.commands.rename(ORIGIN);
    expect(effects(h.calls)).toEqual([]);
  });
});

describe("the side view's Remove", () => {
  it("asks a modal question naming the remote, and removes it inside the hook", async () => {
    const h = harness();
    h.answer(true);
    await h.commands.remove(ORIGIN);
    expect(h.calls).toEqual([
      ["choose", "remotes.removeConfirm|origin", ["remotes.removeConfirmYes"]],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "remove", "origin"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it("changes nothing when the question is dismissed", async () => {
    const h = harness();
    h.answer(false);
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
      ["git", REPO, "remote"],
      [
        "pick",
        [{ label: "origin" }, { label: "upstream" }, { label: "remotes.add" }],
        { placeholder: "remotes.pickPrompt" }
      ]
    ]);
  });

  it("adds a remote the way the side view does", async () => {
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
    expect(effects(h.calls)).toEqual([["git", REPO, "remote"]]);
  });

  it("edits a URL starting from the one git has now", async () => {
    const h = harness();
    h.answer("upstream", "remotes.editUrl", "https://example.com/moved.git");
    await h.commands.manageRemotes();
    expect(h.calls.slice(3)).toEqual([
      ["git", REPO, "remote", "get-url", "upstream"],
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
    h.answer("upstream", "remotes.remove", true);
    await h.commands.manageRemotes();
    expect(h.calls.slice(3)).toEqual([
      ["choose", "remotes.removeConfirm|upstream", ["remotes.removeConfirmYes"]],
      ["runRepoMutation", REPO],
      ["git", REPO, "remote", "remove", "upstream"],
      ["runRepoMutation done", REPO]
    ]);
  });

  it.each([
    ["the URL is left as it was", ["origin", "remotes.editUrl", URLS.origin]],
    ["the new name is blank", ["origin", "remotes.rename", "  "]],
    ["the removal is not confirmed", ["origin", "remotes.remove", false]],
    ["adding is abandoned at the URL", ["remotes.add", "fork", undefined]]
  ])("changes nothing when %s", async (_case, answers) => {
    const h = harness();
    h.answer(...answers);
    await h.commands.manageRemotes();
    expect(effects(h.calls).filter(([, , , verb]) => verb !== "get-url")).toEqual([
      ["git", REPO, "remote"]
    ]);
  });

  it("tells a remote named like the add row apart from the add row", async () => {
    const h = harness({ remotes: ["remotes.add"] });
    h.answer("remotes.add", undefined);
    await h.commands.manageRemotes();
    // The first row with that label is the remote, so its actions are offered.
    expect(h.calls[2]).toEqual([
      "pick",
      [{ label: "remotes.editUrl" }, { label: "remotes.rename" }, { label: "remotes.remove" }],
      { placeholder: "remotes.actionPrompt|remotes.add" }
    ]);
  });

  it("says so when there is no current repository", async () => {
    const h = harness({ repo: null });
    await h.commands.manageRemotes();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });

  it("reports a failure to list the remotes", async () => {
    const h = harness();
    h.failGit();
    await h.commands.manageRemotes();
    expect(h.calls).toEqual([
      ["git", REPO, "remote"],
      ["showError", "error.unableToManageRemote: not a git repository"]
    ]);
  });
});

describe("Show/Hide Remotes", () => {
  it("checks the shown remotes, and hides the ones left unchecked", async () => {
    const h = harness({ remotes: ["origin", "upstream", "fork"], hiddenRemotes: ["fork"] });
    h.answer(["origin"]);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([
      ["git", REPO, "remote"],
      [
        "pickMany",
        [
          { label: "origin", picked: true },
          { label: "upstream", picked: true },
          { label: "fork", picked: false }
        ],
        { placeholder: "remoteVisibility.prompt" }
      ],
      ["setRepoState", REPO, { columnWidths: null, hiddenRemotes: ["upstream", "fork"] }],
      ["broadcastRepos"],
      ["refreshGraph"]
    ]);
  });

  it("writes over the state as it is once answered, not as it was when asked", async () => {
    const h = harness();
    h.answer(["origin", "upstream"]);
    // The graph persists a column drag while the pick is open.
    h.setReposWhileAsking({ [REPO]: { columnWidths: [1, 2, 3], hiddenRemotes: [] } });
    await h.commands.toggleRemoteVisibility();
    expect(h.calls.find(([name]) => name === "setRepoState")).toEqual([
      "setRepoState",
      REPO,
      { columnWidths: [1, 2, 3], hiddenRemotes: [] }
    ]);
  });

  it("writes nothing when the repository left the set while the pick was open", async () => {
    const h = harness();
    h.answer(["origin"]);
    h.setReposWhileAsking({});
    await h.commands.toggleRemoteVisibility();
    expect(h.calls.map(([name]) => name)).toEqual(["git", "pickMany"]);
  });

  it("writes nothing when the pick is dismissed", async () => {
    const h = harness();
    h.answer(undefined);
    await h.commands.toggleRemoteVisibility();
    expect(h.calls.map(([name]) => name)).toEqual(["git", "pickMany"]);
  });

  it("says so when the repository has no remotes", async () => {
    const h = harness({ remotes: [] });
    await h.commands.toggleRemoteVisibility();
    expect(h.calls).toEqual([
      ["git", REPO, "remote"],
      ["showInformation", "fetch.noRemotes"]
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

describe("the side view's list", () => {
  it("lists the repo's remotes with their URLs", async () => {
    const h = harness({ remotes: ["origin"] });
    expect(await h.commands.list(REPO)).toEqual([
      { name: "origin", fetchUrl: URLS.origin, pushUrl: URLS.origin }
    ]);
    expect(h.calls).toEqual([["git", REPO, "remote", "-v"]]);
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
