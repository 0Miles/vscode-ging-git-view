import type { SimpleGit } from "simple-git";

import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { HostPorts, PickItem, RunRepoMutation } from "@ging/core/host/ports";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

// Fakes of what a host hands the core: its ports, and the channel to the
// graph's webview.

/** The rows of a pick as the user sees them: everything but their values. */
const shown = (items: readonly PickItem<unknown>[]) =>
  items.map(({ value: _value, ...row }) => row);

/** What the user answers one question with; see `fakePorts`' `replies`. */
export type PromptReply = string | string[] | undefined;

/**
 * Git for any repo, recording each command in `calls` as
 * `["git", repo, ...argv]`. `remotes` (name to URL) is what `git remote`
 * lists; every other command succeeds silently. Once `failure` is set, every
 * command rejects with it.
 */
export function fakeGit(calls: unknown[][]) {
  const state = {
    remotes: { origin: "https://example.com/origin.git" } as Record<string, string>,
    failure: undefined as string | undefined
  };
  const run = (repo: string, argv: string[]) => {
    calls.push(["git", repo, ...argv]);
    if (state.failure !== undefined) throw new Error(state.failure);
  };
  const clientFor = (repo: string) =>
    ({
      getRemotes: async (verbose?: boolean) => {
        run(repo, ["remote", ...(verbose ? ["-v"] : [])]);
        return Object.entries(state.remotes).map(([name, url]) => ({
          name,
          refs: { fetch: url, push: url }
        }));
      },
      raw: async (argv: string[]) => {
        run(repo, argv);
        return "";
      }
    }) as unknown as SimpleGit;
  return { clientFor, state };
}

/** A `runRepoMutation` that marks in `calls` where the hook begins and where
 *  it has finished, so a log shows what ran inside it. */
export function recordingRunRepoMutation(calls: unknown[][]): RunRepoMutation {
  return async (repo, work) => {
    calls.push(["runRepoMutation", repo]);
    try {
      await work();
    } finally {
      calls.push(["runRepoMutation done", repo]);
    }
  };
}

/** A webview channel a test drives: `receive` delivers a request the way the
 *  webview sends one, and `posted` collects what was sent back. */
export function fakeWebview() {
  let listener!: (msg: RequestMessage) => void | Promise<void>;
  const posted: ResponseMessage[] = [];
  const webview: WebviewChannel = {
    onDidReceiveMessage: (l) => {
      listener = l;
    },
    postMessage: async (msg) => {
      posted.push(msg);
      return true;
    }
  };
  return {
    webview,
    posted,
    receive: async (msg: RequestMessage) => {
      await listener(msg);
    }
  };
}

/** Every port, recording what it was asked in one ordered log. Answers the
 *  prompts and the clipboard can be steered per test. */
export function fakePorts() {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const answers = {
    showError: undefined as string | undefined,
    /** Answers to the questions `choose`, `pick`, `pickMany` and `input` ask,
     *  in the order they are asked: the label clicked or picked (labels, for a
     *  `pickMany`), or the text typed; `undefined` dismisses. Once it runs out,
     *  each question takes its own answer below. */
    replies: [] as PromptReply[],
    /** The label of the action clicked. */
    choose: undefined as string | undefined,
    /** The label of the row picked. */
    pick: undefined as string | undefined,
    /** The labels of the rows checked. */
    pickMany: undefined as string[] | undefined,
    input: undefined as string | undefined,
    saveLocation: undefined as string | undefined,
    clipboard: Promise.resolve() as Promise<void>,
    reposChanged: false,
    commitDiffOpened: true,
    /** Whether opening a file or diff fails, as VS Code's open command does
     *  for a document it cannot show. */
    openRejects: false
  };
  const opened = (call: unknown[]) => {
    calls.push(call);
    if (answers.openRejects) throw new Error("cannot open");
  };
  const reply = <A extends PromptReply>(own: A): A =>
    answers.replies.length > 0 ? (answers.replies.shift() as A) : own;
  const ports: HostPorts = {
    config: {
      signTags: () => false,
      signCommits: () => false,
      squashMergeMessageFormat: () => "Default",
      commitOrder: () => "date",
      dateType: () => "Author Date",
      showUncommittedChanges: () => false,
      showSignatureStatus: () => false,
      useMailmap: () => false,
      inactiveBranchAlwaysShow: () => [],
      fetchAndPrune: () => true,
      fetchAndPruneTags: () => false,
      autoFetchEnabled: () => false,
      autoFetchIntervalMinutes: () => 10,
      pullRequestProviders: () => [],
      showRemoteBranches: () => false,
      repoSettingDefaults: () => ({
        onlyFollowFirstParent: false,
        includeReflogCommits: false,
        showStashes: false,
        showTagOnlyCommits: false,
        showRemoteHeads: false
      })
    },
    prompts: {
      showInformation: record("showInformation"),
      showWarning: record("showWarning"),
      showError: async (...args) => {
        calls.push(["showError", ...args]);
        return answers.showError;
      },
      choose: async (message, { detail, actions }) => {
        calls.push(["choose", message, { detail, actions: actions.map(({ label }) => label) }]);
        const label = reply(answers.choose);
        return actions.find((action) => action.label === label)?.value;
      },
      pick: async (items, options) => {
        calls.push(["pick", shown(items), options]);
        const label = reply(answers.pick);
        return items.find((item) => item.label === label)?.value;
      },
      pickMany: async (items, options) => {
        calls.push(["pickMany", shown(items), options]);
        const labels = reply(answers.pickMany);
        return labels && items.filter((item) => labels.includes(item.label)).map((i) => i.value);
      },
      pickSaveLocation: async (options) => {
        calls.push(["pickSaveLocation", options]);
        return answers.saveLocation;
      },
      input: async (options) => {
        calls.push(["input", options]);
        return reply(answers.input);
      }
    },
    opener: {
      openFile: async (...args) => opened(["openFile", ...args]),
      openFileAtRevision: async (...args) => opened(["openFileAtRevision", ...args]),
      diffWithWorking: async (...args) => opened(["diffWithWorking", ...args]),
      openCommitDiff: async (...args) => {
        calls.push(["openCommitDiff", ...args]);
        return answers.commitDiffOpened;
      },
      openMergeEditor: record("openMergeEditor"),
      openTerminal: record("openTerminal"),
      openExternalUrl: record("openExternalUrl")
    },
    clipboard: {
      writeText: (text) => {
        calls.push(["writeText", text]);
        return answers.clipboard;
      }
    },
    watcher: { start: record("watcher.start"), mute: record("mute"), unmute: record("unmute") },
    // Not the real bundles: the key and its arguments, so a test can see which
    // string was asked for without depending on its wording.
    l10n: { t: (key, ...args) => [key, ...args].join("|") },
    repoSource: {
      getRepos: () => ({ "/a": { columnWidths: null } }),
      getBootRepo: () => "/a",
      checkReposExist: async () => answers.reposChanged,
      dropRepo: record("dropRepo"),
      setRepoState: record("setRepoState"),
      updateRepoState: record("updateRepoState")
    },
    logger: { log: record("log"), logError: record("logError"), reveal: record("reveal") }
  };
  return { ports, calls, answers };
}
