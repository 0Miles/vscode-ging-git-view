import { describe, expect, it } from "vitest";

import { createInfoCommands, type InfoCommandsDeps } from "@ging/core/extension/infoCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";

import { fakeGit, fakePorts, type PromptReply } from "@ging/core/tests/helpers";

// Set Git User Details, Version Info and Statistics, driven the way a user
// drives them: each question answered in turn from a script, and one ordered
// log showing what was asked, which git commands ran, and what was said. None
// of them is handed the host's `runRepoMutation`: none changes what a view
// shows.

const REPO = "/repo";

function harness(options: { repo?: string | null } = {}) {
  const { ports, calls, answers } = fakePorts();
  const git = fakeGit(calls);
  const deps: InfoCommandsDeps = {
    prompts: ports.prompts,
    l10n: ports.l10n,
    clipboard: ports.clipboard,
    gitClientFor: git.clientFor,
    currentRepo: () => (options.repo === undefined ? REPO : options.repo),
    repoSource: { getRepos: () => ({ [REPO]: { columnWidths: null } }) },
    hostVersions: [
      { name: "GING", version: "1.2.3" },
      { name: "Visual Studio Code", version: "1.99.0" }
    ]
  };
  return {
    commands: createInfoCommands(deps),
    deps,
    calls,
    git: git.state,
    /** Queue the user's answers, in the order the questions come. */
    answer: (...replies: PromptReply[]) => answers.replies.push(...replies)
  };
}

const READ_NAME = ["git", REPO, "config", "--get", "user.name"];
const READ_EMAIL = ["git", REPO, "config", "--get", "user.email"];
const SCOPE_PICK = [
  "pick",
  [{ label: "userDetails.scopeLocal" }, { label: "userDetails.scopeGlobal" }],
  { placeholder: "userDetails.scopePrompt" }
];

const ranGit = ([name]: unknown[]) => name === "git";
const said = ([name]: unknown[]) => name === "showInformation";

describe("Set Git User Details", () => {
  it("asks starting from the current name and email, then where, and sets them there", async () => {
    const h = harness();
    h.git.stdout = { "config --get user.name": "Ada\n", "config --get user.email": "ada@x.io\n" };
    h.answer(" Ada Lovelace ", " ada@example.com ", "userDetails.scopeLocal");
    await h.commands.setGitUserDetails();
    expect(h.calls).toEqual([
      READ_NAME,
      READ_EMAIL,
      ["input", { prompt: "userDetails.namePrompt", value: "Ada" }],
      ["input", { prompt: "userDetails.emailPrompt", value: "ada@x.io" }],
      SCOPE_PICK,
      ["git", REPO, "config", "--local", "user.name", "Ada Lovelace"],
      ["git", REPO, "config", "--local", "user.email", "ada@example.com"],
      ["showInformation", "userDetails.updated"]
    ]);
  });

  it("writes to the global config when asked to", async () => {
    const h = harness();
    h.answer("Ada", "ada@example.com", "userDetails.scopeGlobal");
    await h.commands.setGitUserDetails();
    expect(h.calls.filter(ranGit).slice(-2)).toEqual([
      ["git", REPO, "config", "--global", "user.name", "Ada"],
      ["git", REPO, "config", "--global", "user.email", "ada@example.com"]
    ]);
  });

  it("unsets a field left blank rather than writing it blank", async () => {
    const h = harness();
    h.answer("Ada", "  ", "userDetails.scopeLocal");
    await h.commands.setGitUserDetails();
    expect(h.calls.filter(ranGit).slice(-1)).toEqual([
      ["git", REPO, "config", "--local", "--unset", "user.email"]
    ]);
  });

  it.each([
    ["the name is dismissed", [undefined]],
    ["the email is dismissed", ["Ada", undefined]],
    ["the scope is dismissed", ["Ada", "ada@example.com", undefined]]
  ])("writes nothing when %s", async (_case, replies) => {
    const h = harness();
    h.answer(...replies);
    await h.commands.setGitUserDetails();
    expect(h.calls.filter(ranGit)).toEqual([READ_NAME, READ_EMAIL]);
    expect(h.calls.some(said)).toBe(false);
  });

  it("reports git's failure to set them, and says nothing was updated", async () => {
    const h = harness();
    h.answer("Ada", "ada@example.com", "userDetails.scopeLocal");
    // The reads swallow a failure (an unset key reads as empty), so a broken
    // git is first felt by the write.
    h.git.failure = "error: could not lock config file .git/config";
    await h.commands.setGitUserDetails();
    expect(h.calls).toContainEqual(["input", { prompt: "userDetails.namePrompt", value: "" }]);
    expect(h.calls.at(-1)).toEqual([
      "showError",
      "userDetails.unableToSet: could not lock config file .git/config"
    ]);
    expect(h.calls.some(said)).toBe(false);
  });

  it.each([
    ["there is no current repository", null],
    ["the current repository is no longer known", "/gone"]
  ])("offers only the global config, on no repository, when %s", async (_case, repo) => {
    const h = harness({ repo });
    h.git.stdout = { "config --get user.name": "Ada\n" };
    h.answer("Ada", "ada@example.com", "userDetails.scopeGlobal");
    await h.commands.setGitUserDetails();
    expect(h.calls).toEqual([
      ["git", null, "config", "--get", "user.name"],
      ["git", null, "config", "--get", "user.email"],
      ["input", { prompt: "userDetails.namePrompt", value: "Ada" }],
      ["input", { prompt: "userDetails.emailPrompt", value: "" }],
      ["pick", [{ label: "userDetails.scopeGlobal" }], { placeholder: "userDetails.scopePrompt" }],
      ["git", null, "config", "--global", "user.name", "Ada"],
      ["git", null, "config", "--global", "user.email", "ada@example.com"],
      ["showInformation", "userDetails.updated"]
    ]);
  });

  it("reports a repo whose client cannot be built, before asking anything", async () => {
    const h = harness();
    const commands = createInfoCommands({
      ...h.deps,
      gitClientFor: () => {
        throw new Error("Cannot use simple-git on a directory that does not exist");
      }
    });
    await commands.setGitUserDetails();
    expect(h.calls).toEqual([
      [
        "showError",
        "userDetails.unableToSet: Cannot use simple-git on a directory that does not exist"
      ]
    ]);
  });
});

describe("Version Info", () => {
  const INFO = [
    "GING: 1.2.3",
    "Visual Studio Code: 1.99.0",
    `OS: ${process.platform} ${process.arch}`,
    "git version 2.47.1"
  ].join("\n");

  it("shows the host's versions, the OS and git's in a modal offering to copy them", async () => {
    const h = harness();
    h.git.stdout = { "--version": "git version 2.47.1\n" };
    await h.commands.versionInfo();
    expect(h.calls).toEqual([
      ["git", null, "--version"],
      ["showInformation", INFO, { modal: true, actions: ["versionInfo.copy"] }]
    ]);
  });

  it("copies exactly what it showed when asked to", async () => {
    const h = harness();
    h.git.stdout = { "--version": "git version 2.47.1\n" };
    h.answer("versionInfo.copy");
    await h.commands.versionInfo();
    expect(h.calls.at(-1)).toEqual(["writeText", INFO]);
  });

  it("asks git on no repository, so it answers with no repository at all", async () => {
    const h = harness({ repo: null });
    h.git.stdout = { "--version": "git version 2.47.1\n" };
    await h.commands.versionInfo();
    expect(h.calls[0]).toEqual(["git", null, "--version"]);
    expect(h.calls).not.toContainEqual(["showInformation", "repoName.noRepos"]);
  });

  it("runs the real git on a client bound to no repository", async () => {
    const h = harness();
    const commands = createInfoCommands({
      ...h.deps,
      gitClientFor: createRepoGitClients({ gitPath: () => "git" }).gitClientFor
    });
    await commands.versionInfo();
    const [, shown] = h.calls.at(-1) as [string, string];
    expect(shown.split("\n").at(-1)).toMatch(/^git version \d/);
  });

  it("reports what it can when git cannot be run", async () => {
    const h = harness();
    h.git.failure = "spawn git ENOENT";
    await h.commands.versionInfo();
    const [, shown] = h.calls.at(-1) as [string, string];
    expect(shown.split("\n").at(-1)).toBe("git: unknown");
    expect(h.calls.some(([name]) => name === "showError")).toBe(false);
  });
});

describe("Statistics", () => {
  const LOG = ["log", "--all", "--max-count=5001", "--format=%aN%x00%aI"];

  it("answers the current repository's statistics", async () => {
    const h = harness();
    h.git.stdout = {
      [LOG.join(" ")]: "Ada\u00002026-11-09T10:00:00+08:00\nBob\u00002026-11-10T23:30:00+00:00\n"
    };
    const stats = await h.commands.statistics();
    expect(h.calls).toEqual([["git", REPO, ...LOG]]);
    expect(stats).toMatchObject({
      total: 2,
      capped: false,
      limit: 5000,
      byAuthor: [
        { name: "Ada", count: 1 },
        { name: "Bob", count: 1 }
      ]
    });
  });

  it("answers nothing after reporting git's failure", async () => {
    const h = harness();
    h.git.failure = "fatal: your current branch 'main' does not have any commits yet";
    expect(await h.commands.statistics()).toBeUndefined();
    expect(h.calls.at(-1)).toEqual([
      "showError",
      "stats.unableTo: your current branch 'main' does not have any commits yet"
    ]);
  });

  it("answers nothing after saying there is no repository", async () => {
    const h = harness({ repo: null });
    expect(await h.commands.statistics()).toBeUndefined();
    expect(h.calls).toEqual([["showInformation", "repoName.noRepos"]]);
  });
});
