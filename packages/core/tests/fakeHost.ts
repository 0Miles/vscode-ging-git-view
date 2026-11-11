import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { HostPorts, PickItem } from "@ging/core/host/ports";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

// Fakes of what a host hands the core: its ports, and the channel to the
// graph's webview.

/** The rows of a pick as the user sees them: everything but their values. */
const shown = (items: readonly PickItem<unknown>[]) =>
  items.map(({ value: _value, ...row }) => row);

/** What the user answers one question with; see `fakePorts`' `replies`. */
export type PromptReply = string | string[] | undefined;

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
      setRepoState: record("setRepoState")
    },
    logger: { log: record("log"), logError: record("logError"), reveal: record("reveal") }
  };
  return { ports, calls, answers };
}
