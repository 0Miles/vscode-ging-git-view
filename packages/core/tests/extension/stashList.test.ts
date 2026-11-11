import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { commitDiffView } from "@ging/core/extension/commitDiff";
import {
  applyOrPopListedStash,
  applyOrPopActions,
  copyStashName,
  dropListedStash,
  type ListedStashHost,
  loadStashFiles,
  renameListedStash,
  sameStashList,
  stashListItems
} from "@ging/core/extension/stashList";
import type { ScmStashEntry } from "@ging/shared/backend/types";

import { fakePorts, git, makeRepo, pushTwoStashes, rev, rmrf } from "@ging/core/tests/helpers";

const entry = (hash: string, index: number, message = "On main: wip"): ScmStashEntry => ({
  hash,
  ref: `stash@{${index}}`,
  index,
  message,
  date: 1_700_000_000
});

describe("stashListItems", () => {
  it("names each item by its stash's SHA, whatever its position", () => {
    const items = stashListItems([entry("aaa", 0, "On main: a"), entry("bbb", 1, "On main: b")]);
    expect(items).toEqual([
      {
        id: "aaa",
        hash: "aaa",
        selector: "stash@{0}",
        message: "On main: a",
        date: 1_700_000_000
      },
      {
        id: "bbb",
        hash: "bbb",
        selector: "stash@{1}",
        message: "On main: b",
        date: 1_700_000_000
      }
    ]);
  });

  it("keeps ids unique when one commit is stored in the stash twice", () => {
    // `git stash store` takes any commit, so one SHA can sit at two positions;
    // a tree view refuses two items with the same id.
    const ids = stashListItems([entry("aaa", 0), entry("bbb", 1), entry("aaa", 2)]).map(
      (i) => i.id
    );
    expect(new Set(ids).size).toBe(3);
    expect(ids.slice(0, 2)).toEqual(["aaa", "bbb"]);
  });
});

describe("sameStashList", () => {
  const list = (...hashes: string[]) => stashListItems(hashes.map((h, i) => entry(h, i)));

  it("holds for the same stashes at the same places", () => {
    expect(sameStashList(list("aaa", "bbb"), list("aaa", "bbb"))).toBe(true);
  });

  it("fails once a stash was pushed, dropped or moved", () => {
    expect(sameStashList(list("aaa", "bbb"), list("ccc", "aaa", "bbb"))).toBe(false);
    expect(sameStashList(list("aaa", "bbb"), list("bbb"))).toBe(false);
    expect(sameStashList(list("aaa", "bbb"), list("bbb", "aaa"))).toBe(false);
  });
});

/** The stash list as `git stash list` has it now: each entry's SHA and subject,
 *  newest first. */
const stashList = (repo: string) =>
  cp
    .execFileSync("git", ["stash", "list", "--format=%H %s"], { cwd: repo, stdio: "pipe" })
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, ...subject] = line.split(" ");
      return { hash, subject: subject.join(" ") };
    });

/**
 * A git client that records every touch and does nothing, for proving a
 * cancelled action never reached git. Recording rather than throwing: an
 * action catching the throw would report a failure and hide the touch.
 */
function untouchableGit() {
  const touched: string[] = [];
  const client = new Proxy({} as SimpleGit, {
    get: (_target, name) => {
      touched.push(String(name));
      return () => Promise.resolve("");
    }
  });
  return { client, touched };
}

/** A listed stash's host over `fakePorts`, on `gitClient`; a refresh is
 *  logged with the prompts, in order. */
function hostOn(gitClient: SimpleGit) {
  const { ports, calls, answers } = fakePorts();
  const host: ListedStashHost = {
    git: gitClient,
    clipboard: ports.clipboard,
    prompts: ports.prompts,
    l10n: ports.l10n,
    refresh: () => void calls.push(["refresh"])
  };
  return { host, calls, answers };
}

describe("copyStashName (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  it("copies the shown selector while the stash still sits there", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    const { host, calls } = hostOn(simpleGit(repo));

    expect(await copyStashName(host, { hash: older, selector: "stash@{1}" })).toBe("copied");
    expect(calls).toEqual([["writeText", "stash@{1}"]]);
  });

  it("refuses, copying nothing, once the stash has moved", async () => {
    repo = makeRepo();
    // `older` was listed at stash@{0}, before `newer` was pushed on top of it.
    const { older } = pushTwoStashes(repo);
    const { host, calls } = hostOn(simpleGit(repo));

    expect(await copyStashName(host, { hash: older, selector: "stash@{0}" })).toBe("refused");
    expect(calls).toEqual([["showWarning", "stashView.stashMoved"], ["refresh"]]);
  });

  it("refuses, copying nothing, once the stash is gone", async () => {
    repo = makeRepo();
    const { newer } = pushTwoStashes(repo);
    git(["stash", "clear"], repo);
    const { host, calls } = hostOn(simpleGit(repo));

    expect(await copyStashName(host, { hash: newer, selector: "stash@{0}" })).toBe("refused");
    expect(calls).toEqual([["showWarning", "stashView.stashMoved"], ["refresh"]]);
  });
});

describe("dropListedStash (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  it("asks with the shown selector, and drops that stash on Drop", async () => {
    repo = makeRepo();
    const { older, newer } = pushTwoStashes(repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = "action.stashDrop";

    const outcome = await dropListedStash(host, { hash: older, selector: "stash@{1}" });

    expect(outcome).toBe("dropped");
    expect(calls).toEqual([
      ["choose", "dialog.stash.dropConfirm|stash@{1}", { actions: ["action.stashDrop"] }],
      ["refresh"]
    ]);
    expect(stashList(repo).map((s) => s.hash)).toEqual([newer]);
  });

  it("does not touch git when the question is dismissed", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    const { client: noGit, touched } = untouchableGit();
    const { host, calls } = hostOn(noGit);

    const outcome = await dropListedStash(host, { hash: older, selector: "stash@{1}" });

    expect(outcome).toBe("cancelled");
    expect(touched).toEqual([]);
    expect(calls).toEqual([
      ["choose", "dialog.stash.dropConfirm|stash@{1}", { actions: ["action.stashDrop"] }]
    ]);
  });

  it("refuses, dropping nothing, when the stash moved before the menu was opened", async () => {
    repo = makeRepo();
    // `older` was listed at stash@{0}, before `newer` was pushed on top of it:
    // stash@{0} is now `newer`, which must survive.
    const { older, newer } = pushTwoStashes(repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = "action.stashDrop";

    const outcome = await dropListedStash(host, { hash: older, selector: "stash@{0}" });

    expect(outcome).toBe("refused");
    expect(stashList(repo).map((s) => s.hash)).toEqual([newer, older]);
    expect(calls.slice(1)).toEqual([["showWarning", "stashView.stashMoved"], ["refresh"]]);
  });

  it("refuses, dropping nothing, when the stash moved while the question was open", async () => {
    repo = makeRepo();
    const { older, newer } = pushTwoStashes(repo);
    const { host, answers } = hostOn(simpleGit(repo));
    answers.choose = "action.stashDrop";
    let pushed = "";
    // Shown at stash@{1}; a push lands while the user reads the question, so
    // stash@{1} becomes `newer`. The selector the question named is the one
    // consented to — it is not looked up again, nor redirected to `older`.
    const { choose } = host.prompts;
    host.prompts = {
      ...host.prompts,
      choose: (message, options) => {
        fs.writeFileSync(path.join(repo, "f"), "newest");
        git(["stash", "push", "-m", "newest"], repo);
        pushed = rev(repo, "stash@{0}");
        return choose(message, options);
      }
    };

    const outcome = await dropListedStash(host, { hash: older, selector: "stash@{1}" });

    expect(outcome).toBe("refused");
    expect(stashList(repo).map((s) => s.hash)).toEqual([pushed, newer, older]);
  });

  it("reports git's failure and refreshes, when the drop itself fails", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    // A lock git cannot take: the reflog rewrite the drop needs fails.
    fs.writeFileSync(path.join(repo, ".git", "refs", "stash.lock"), "");
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = "action.stashDrop";

    const outcome = await dropListedStash(host, { hash: older, selector: "stash@{1}" });

    expect(outcome).toBe("failed");
    const [[kind, message], refresh] = calls.slice(1) as [string, string][];
    expect(kind).toBe("showError");
    expect(message.startsWith("error.unableToDropStash: ")).toBe(true);
    expect(refresh).toEqual(["refresh"]);
  });
});

/** How the side-view shows `pushTwoStashes`' older stash. */
const shownOlder = (older: string) => ({
  hash: older,
  selector: "stash@{1}",
  message: "On main: older"
});

describe("renameListedStash (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  it("asks with the shown selector and message, and renames that stash", async () => {
    repo = makeRepo();
    const { older, newer } = pushTwoStashes(repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.input = "  renamed  ";

    const outcome = await renameListedStash(host, shownOlder(older));

    expect(outcome).toBe("renamed");
    expect(calls).toEqual([
      ["input", { prompt: "dialog.stash.renameTitle|stash@{1}", value: "On main: older" }],
      ["refresh"]
    ]);
    // Rebuilt under a new SHA and stored on top (see `renameStash`); `newer`
    // is untouched.
    const list = stashList(repo);
    expect(list.map((s) => s.subject)).toEqual(["renamed", "On main: newer"]);
    expect(list[1].hash).toBe(newer);
    expect(list[0].hash).not.toBe(older);
  });

  it.each([
    ["dismissed", undefined],
    ["left empty", "   "],
    ["left as it was", "On main: older"]
  ])("does not touch git when the message is %s", async (_case, answer) => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    const { client: noGit, touched } = untouchableGit();
    const { host, calls, answers } = hostOn(noGit);
    answers.input = answer;

    const outcome = await renameListedStash(host, shownOlder(older));

    expect(outcome).toBe("cancelled");
    expect(touched).toEqual([]);
    expect(calls.map(([name]) => name)).toEqual(["input"]);
  });

  it("refuses, renaming nothing, once the stash has moved", async () => {
    repo = makeRepo();
    const { older, newer } = pushTwoStashes(repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.input = "renamed";

    const outcome = await renameListedStash(host, { ...shownOlder(older), selector: "stash@{0}" });

    expect(outcome).toBe("refused");
    expect(stashList(repo)).toEqual([
      { hash: newer, subject: "On main: newer" },
      { hash: older, subject: "On main: older" }
    ]);
    expect(calls.slice(1)).toEqual([["showWarning", "stashView.stashMoved"], ["refresh"]]);
  });
});

describe("applyOrPopActions", () => {
  const { l10n } = fakePorts().ports;

  // Apply first: what the graph's form sends with its checkbox unticked.
  it("offers Apply as reinstateIndex: false, then Apply & Reinstate Index as true", () => {
    expect(applyOrPopActions(l10n, "apply")).toEqual([
      { label: "dialog.stash.apply", value: false },
      { label: "dialog.stash.applyReinstateIndex", value: true }
    ]);
  });

  it("offers Pop and Pop & Reinstate Index the same way", () => {
    expect(applyOrPopActions(l10n, "pop")).toEqual([
      { label: "dialog.stash.pop", value: false },
      { label: "dialog.stash.popReinstateIndex", value: true }
    ]);
  });
});

describe.each(["apply", "pop"] as const)("applyOrPopListedStash: %s (real git)", (mode) => {
  const run = (host: ListedStashHost, shown: { hash: string; selector: string }) =>
    applyOrPopListedStash(host, shown, mode);
  const done = "done";
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  /** What `git diff --cached` names. */
  const staged = () =>
    cp.execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo }).toString().trim();

  /** One stash of a staged change to "f", listed at stash@{0}. */
  function stagedStash() {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "staged");
    git(["add", "f"], repo);
    git(["stash", "push", "-m", "staged"], repo);
    return { hash: rev(repo, "stash@{0}"), selector: "stash@{0}" };
  }

  const question = [
    "choose",
    `dialog.stash.${mode}Confirm|stash@{0}`,
    {
      detail: "dialog.stash.reinstateIndexDetail",
      actions: [`dialog.stash.${mode}`, `dialog.stash.${mode}ReinstateIndex`]
    }
  ];

  it("asks with the shown selector, a detail line and two buttons", async () => {
    const shown = stagedStash();
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    expect(await run(host, shown)).toBe(done);
    expect(calls).toEqual([question, ["refresh"]]);
  });

  it("leaves the index alone on the plain button", async () => {
    const shown = stagedStash();
    const { host, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    await run(host, shown);

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("staged");
    expect(staged()).toBe("");
  });

  it("reinstates the index on the second button", async () => {
    const shown = stagedStash();
    const { host, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}ReinstateIndex`;

    await run(host, shown);

    expect(staged()).toBe("f");
  });

  it("does not touch git when the question is cancelled", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    const { client: noGit, touched } = untouchableGit();
    const { host, calls } = hostOn(noGit);

    expect(await run(host, { hash: older, selector: "stash@{1}" })).toBe("cancelled");
    expect(touched).toEqual([]);
    expect(calls.map(([name]) => name)).toEqual(["choose"]);
  });

  it("refuses, touching nothing, once the stash has moved", async () => {
    repo = makeRepo();
    const { older, newer } = pushTwoStashes(repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    expect(await run(host, { hash: older, selector: "stash@{0}" })).toBe("refused");
    expect(stashList(repo).map((s) => s.hash)).toEqual([newer, older]);
    expect(calls.slice(1)).toEqual([["showWarning", "stashView.stashMoved"], ["refresh"]]);
  });

  // The ticket's fixture: a `-u` stash, then a merge left in conflict.
  it("refuses while conflicts are already there, not reporting them as the stash's", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "stashed");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "u");
    git(["stash", "push", "-u", "-m", "wip"], repo);
    const shown = { hash: rev(repo, "stash@{0}"), selector: "stash@{0}" };
    git(["checkout", "-b", "other"], repo);
    fs.writeFileSync(path.join(repo, "f"), "other");
    git(["commit", "-am", "other"], repo);
    git(["checkout", "main"], repo);
    fs.writeFileSync(path.join(repo, "f"), "mine");
    git(["commit", "-am", "mine"], repo);
    expect(() => git(["merge", "other"], repo)).toThrow();
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    expect(await run(host, shown)).toBe("refused");
    expect(calls.slice(1)).toEqual([["showWarning", "stashApply.unmergedBefore"], ["refresh"]]);
    expect(stashList(repo).map((s) => s.hash)).toEqual([shown.hash]);
  });

  it("says where the stash is kept when it conflicted", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "stashed");
    git(["stash", "push", "-m", "wip"], repo);
    const shown = { hash: rev(repo, "stash@{0}"), selector: "stash@{0}" };
    fs.writeFileSync(path.join(repo, "f"), "committed");
    git(["commit", "-am", "conflicts with the stash"], repo);
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    expect(await run(host, shown)).toBe("conflicted");
    expect(calls.slice(1)).toEqual([
      ["showWarning", "stashApply.conflicted|stash@{0}"],
      ["refresh"]
    ]);
  });

  it("says nothing was changed when it failed with nothing unmerged", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "stashed");
    git(["stash", "push", "-m", "wip"], repo);
    const shown = { hash: rev(repo, "stash@{0}"), selector: "stash@{0}" };
    fs.writeFileSync(path.join(repo, "f"), "dirty");
    const { host, calls, answers } = hostOn(simpleGit(repo));
    answers.choose = `dialog.stash.${mode}`;

    expect(await run(host, shown)).toBe("failed");
    const [[kind, message], refresh] = calls.slice(1) as [string, string][];
    expect(kind).toBe("showError");
    const failure = mode === "apply" ? "error.unableToApplyStash" : "error.unableToPopStash";
    expect(message.startsWith(`${failure}: stashApply.unchanged `)).toBe(true);
    expect(message).toMatch(/overwritten/);
    expect(refresh).toEqual(["refresh"]);
  });
});

describe("applyOrPopListedStash's report for a stash no longer listed", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  it("names no position when the conflicted stash was dropped meanwhile", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "stashed");
    git(["stash", "push", "-m", "wip"], repo);
    const shown = { hash: rev(repo, "stash@{0}"), selector: "stash@{0}" };
    fs.writeFileSync(path.join(repo, "f"), "committed");
    git(["commit", "-am", "conflicts with the stash"], repo);
    // Dropped from elsewhere right after the check; apply still runs on the
    // SHA (#365), and conflicts.
    const real = simpleGit(repo);
    let dropped = false;
    const racing = {
      raw: async (args: string[]) => {
        const out = await real.raw(args);
        if (args[0] === "rev-parse" && !dropped) {
          dropped = true;
          git(["stash", "drop", "stash@{0}"], repo);
        }
        return out;
      }
    } as unknown as SimpleGit;
    const { host, calls, answers } = hostOn(racing);
    answers.choose = "dialog.stash.apply";

    expect(await applyOrPopListedStash(host, shown, "apply")).toBe("conflicted");
    expect(calls.slice(1)).toEqual([["showWarning", "stashApply.conflictedUnlisted"], ["refresh"]]);
  });
});

describe("loadStashFiles (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmrf(repo);
  });

  /** What `git show <revision>:<path>` reads, or null when there's no such file. */
  const show = (revision: string, file: string): string | null => {
    try {
      return cp
        .execFileSync("git", ["show", `${revision}:${file}`], { cwd: repo, stdio: "pipe" })
        .toString();
    } catch {
      return null;
    }
  };

  it("lists tracked and untracked files, each diffing what the stash changed", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "new.txt"), "untracked");
    git(["stash", "push", "--include-untracked", "-m", "both"], repo);
    const hash = rev(repo, "stash@{0}");

    const files = await loadStashFiles(simpleGit(repo), repo, hash);

    expect(files?.map(({ name, dir, badge }) => ({ name, dir, badge }))).toEqual([
      { name: "f", dir: "", badge: "M" },
      { name: "new.txt", dir: "dir", badge: "U" }
    ]);
    const labels = { addedIn: (h: string) => `added ${h}`, deletedIn: (h: string) => `del ${h}` };
    const [tracked, untracked] = files!.map((file) => commitDiffView(file.diff, labels));
    // Tracked: the stash's base (stash^1) against the stash.
    expect(show(tracked.left.commit, tracked.left.filePath)).toBe("x");
    expect(show(tracked.right.commit, tracked.right.filePath)).toBe("changed");
    // Untracked: nothing on the left, the stash's third parent on the right.
    expect(show(untracked.left.commit, untracked.left.filePath)).toBeNull();
    expect(untracked.right.commit).toBe(hash + "^3");
    expect(show(untracked.right.commit, untracked.right.filePath)).toBe("untracked");
  });

  it("leaves out what only the index (stash^2) changed", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "staged");
    git(["add", "f"], repo);
    fs.writeFileSync(path.join(repo, "f"), "x");
    git(["stash", "push", "-m", "index only"], repo);

    const files = await loadStashFiles(simpleGit(repo), repo, rev(repo, "stash@{0}"));

    expect(files).toEqual([]);
  });

  it("is null when the stash can't be read", async () => {
    repo = makeRepo();
    expect(await loadStashFiles(simpleGit(repo), repo, "0".repeat(40))).toBeNull();
  });
});
