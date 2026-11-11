import type { WebviewChannel } from "@ging/core/extension/webviewBridge";
import type { HostPorts, PickItem, PickOptions } from "@ging/core/host/ports";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

// Fakes of what a host hands the core: its ports, and the channel to the
// graph's webview.

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
    confirm: false,
    /** What a `pick` answers: a value, or a list of them with `canPickMany`. */
    pick: undefined as unknown,
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
  // A declaration, not an arrow in the object: `Prompts.pick` is overloaded,
  // and an overloaded method gives its parameters no contextual type.
  async function pick(items: readonly PickItem<unknown>[], options?: PickOptions) {
    calls.push(["pick", items, options]);
    return answers.pick as never;
  }
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
      confirm: async (...args) => {
        calls.push(["confirm", ...args]);
        return answers.confirm;
      },
      pick,
      pickSaveLocation: async (options) => {
        calls.push(["pickSaveLocation", options]);
        return answers.saveLocation;
      },
      input: async (options) => {
        calls.push(["input", options]);
        return answers.input;
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
