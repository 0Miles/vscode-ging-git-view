import { beforeEach, describe, expect, it, vi } from "vitest";

import { managePullRequestProviders } from "@ging/vscode/extension/pullRequestProviders";

// Characterization of the Manage Pull Request Providers command as VS Code
// shows it (#398): which prompts come up in which order, what each lists, and
// which settings scope the list is written to. It is pinned at VS Code's own
// API — `window.*`, `workspace.getConfiguration`, `commands` — so it reads the
// same whether the flow lives in the extension or in core behind the ports.

const KEY = "ging-git-view.pullRequests.providers";

type Asked = unknown[];

const vs = vi.hoisted(() => ({
  /** The list as each scope holds it; `undefined` is not set there. */
  user: undefined as unknown,
  workspace: undefined as unknown,
  workspaceOpen: true,
  /** Every prompt put in front of the user, in order. */
  asked: [] as Asked[],
  /** What the user answers each prompt with, in order: the label clicked or
   *  picked, or the text typed; `undefined` dismisses. */
  replies: [] as unknown[],
  /** Each `validateInput` an input box was given, in order. */
  validators: [] as ((value: string) => unknown)[],
  /** Each `update(key, value, target)`, the key in full. */
  updates: [] as unknown[][],
  updateRejects: undefined as string | undefined,
  commands: [] as unknown[][]
}));

/** A row as the user sees it: what it says, and whether it is a separator. */
function shownRow(item: unknown): Record<string, unknown> {
  if (typeof item === "string") return { label: item };
  const { label, description, detail, kind } = item as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries({ label, description, detail, kind }).filter(([, v]) => v !== undefined)
  );
}

/** The label a message item shows: a string, or a `MessageItem`'s title. */
const titleOf = (item: unknown) =>
  typeof item === "string" ? item : (item as { title: string }).title;

/** The message items of a `show*Message` call: everything after the message
 *  but its options. */
const messageItems = (rest: unknown[]) =>
  rest.filter(
    (x) => typeof x === "string" || (typeof x === "object" && x !== null && "title" in x)
  );

vi.mock("vscode", () => {
  return {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    l10n: { t: (key: string, ...args: unknown[]) => [key, ...args].join("|") },
    workspace: {
      get workspaceFolders() {
        return vs.workspaceOpen ? [{ uri: { fsPath: "/ws" }, name: "ws", index: 0 }] : undefined;
      },
      getConfiguration: (section?: string) => {
        /** `key` in full, as settings.json spells it. */
        const full = (key: string) => (section ? `${section}.${key}` : key);
        return {
          get: (key: string, defaultValue?: unknown) =>
            full(key) === KEY ? (vs.workspace ?? vs.user ?? defaultValue) : defaultValue,
          inspect: (key: string) =>
            full(key) === KEY
              ? { key: KEY, defaultValue: [], globalValue: vs.user, workspaceValue: vs.workspace }
              : undefined,
          update: async (key: string, value: unknown, target: number) => {
            vs.updates.push([full(key), value, target]);
            if (vs.updateRejects !== undefined) throw new Error(vs.updateRejects);
            if (target === 2) vs.workspace = value;
            else vs.user = value;
          }
        };
      }
    },
    window: {
      showQuickPick: async (items: unknown[], options: { placeHolder?: string }) => {
        vs.asked.push(["quickPick", items.map(shownRow), options?.placeHolder]);
        const reply = vs.replies.shift();
        return items.find((item) => shownRow(item).label === reply);
      },
      showInputBox: async (options: {
        prompt?: string;
        value?: string;
        ignoreFocusOut?: boolean;
        validateInput?: (value: string) => unknown;
      }) => {
        vs.asked.push([
          "input",
          { prompt: options.prompt, value: options.value, ignoreFocusOut: options.ignoreFocusOut }
        ]);
        if (options.validateInput) vs.validators.push(options.validateInput);
        return vs.replies.shift();
      },
      showWarningMessage: async (message: string, ...rest: unknown[]) => {
        const options = rest[0] as { modal?: boolean };
        const items = messageItems(rest);
        vs.asked.push(["warning", message, { modal: options?.modal }, items.map(titleOf)]);
        const reply = vs.replies.shift();
        return items.find((item) => titleOf(item) === reply);
      },
      showInformationMessage: async (message: string, ...rest: unknown[]) => {
        const items = messageItems(rest);
        vs.asked.push(["information", message, items.map(titleOf)]);
        const reply = vs.replies.shift();
        return items.find((item) => titleOf(item) === reply);
      },
      showErrorMessage: async (message: string) => {
        vs.asked.push(["error", message]);
        return undefined;
      }
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        vs.commands.push(args);
      }
    }
  };
});

/** Run the command, then let the "show setting" button's handler, which the
 *  command does not wait for, run too. */
async function manage(host?: string | null): Promise<void> {
  await managePullRequestProviders(host);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const t = (key: string, ...args: string[]) => [`pullRequest.providers.${key}`, ...args].join("|");

/** The type picker's rows for `host`, the forge `current` names marked. */
function typeRows(host: string, current?: string) {
  const mark = (type: string) => (type === current ? { description: "✓" } : {});
  return [
    {
      label: "GitHub",
      ...mark("github"),
      detail: `https://${host}/owner/repo/compare/my-branch?expand=1`
    },
    {
      label: "GitLab",
      ...mark("gitlab"),
      detail: `https://${host}/owner/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=my-branch`
    },
    {
      label: "Bitbucket",
      ...mark("bitbucket"),
      detail: `https://${host}/owner/repo/pull-requests/new?source=my-branch&t=1`
    },
    {
      label: "Gitea / Forgejo",
      ...mark("gitea"),
      detail: `https://${host}/owner/repo/compare/my-branch`
    },
    { label: t("typeCustom"), ...mark("custom") }
  ];
}

/** What `validateInput` says of `value`: `null` when it takes it, whichever
 *  of VS Code's ways of saying so the validator used. */
const valid = (check: (value: string) => unknown, value: string) => check(value) ?? null;

const SCOPE_ROWS = [{ label: t("scopeUser") }, { label: t("scopeWorkspace") }];

beforeEach(() => {
  vs.user = undefined;
  vs.workspace = undefined;
  vs.workspaceOpen = true;
  vs.asked = [];
  vs.replies = [];
  vs.validators = [];
  vs.updates = [];
  vs.updateRejects = undefined;
  vs.commands = [];
});

describe("managePullRequestProviders in VS Code", () => {
  it("lists the add row, a separator, the configured providers by scope, then the built-in hosts not overridden", async () => {
    vs.user = [
      { host: "git.example.com", type: "gitea" },
      { host: "github.com", type: "custom", urlTemplate: "https://github.com/{path}/c/{branch}" }
    ];
    vs.replies = [undefined];

    await manage();

    expect(vs.asked).toEqual([
      [
        "quickPick",
        [
          { label: t("add"), detail: t("addDetail") },
          { label: "", kind: -1 },
          { label: "git.example.com", description: `Gitea / Forgejo · ${t("scopeUser")}` },
          {
            label: "github.com",
            description: `${t("typeCustom")} · ${t("scopeUser")}`,
            detail: "https://github.com/{path}/c/{branch}"
          },
          { label: "gitlab.com", description: `GitLab · ${t("builtIn")}` },
          { label: "bitbucket.org", description: `Bitbucket · ${t("builtIn")}` },
          { label: "gitea.com", description: `Gitea / Forgejo · ${t("builtIn")}` },
          { label: "codeberg.org", description: `Gitea / Forgejo · ${t("builtIn")}` }
        ],
        t("pickPrompt")
      ]
    ]);
    expect(vs.updates).toEqual([]);
  });

  it("adds a host with no list set anywhere: asks which scope while a workspace is open, and writes there", async () => {
    vs.replies = [
      t("add"),
      " Git.Example.com ",
      "Gitea / Forgejo",
      t("scopeWorkspace"),
      t("showSetting")
    ];

    await manage();

    expect(vs.asked).toEqual([
      ["quickPick", expect.any(Array), t("pickPrompt")],
      ["input", { prompt: t("hostPrompt"), value: undefined, ignoreFocusOut: true }],
      ["quickPick", typeRows("git.example.com"), t("typePrompt", "git.example.com")],
      ["quickPick", SCOPE_ROWS, t("scopePrompt")],
      ["information", t("saved", "git.example.com", t("scopeWorkspace")), [t("showSetting")]]
    ]);
    expect(vs.updates).toEqual([[KEY, [{ host: "git.example.com", type: "gitea" }], 2]]);
    expect(vs.commands).toEqual([["workbench.action.openSettings", KEY]]);
  });

  it("with no workspace open, writes to the user settings without asking which", async () => {
    vs.workspaceOpen = false;
    vs.replies = [t("add"), "git.example.com", "GitLab", undefined];

    await manage();

    expect(vs.asked.map(([kind]) => kind)).toEqual([
      "quickPick",
      "input",
      "quickPick",
      "information"
    ]);
    expect(vs.asked[3]).toEqual([
      "information",
      t("saved", "git.example.com", t("scopeUser")),
      [t("showSetting")]
    ]);
    expect(vs.updates).toEqual([[KEY, [{ host: "git.example.com", type: "gitlab" }], 1]]);
    expect(vs.commands).toEqual([]);
  });

  it("writes an edit back to the scope already holding the list, the workspace's over the user's", async () => {
    vs.user = [{ host: "user.example.com", type: "gitea" }];
    vs.workspace = [{ host: "ws.example.com", type: "gitea" }];
    vs.replies = [t("add"), "new.example.com", "GitHub", undefined];

    await manage();

    expect(vs.asked[0][1]).toContainEqual({
      label: "ws.example.com",
      description: `Gitea / Forgejo · ${t("scopeWorkspace")}`
    });
    expect(vs.asked.map(([kind]) => kind)).not.toContain("warning");
    expect(vs.asked.filter(([, , placeholder]) => placeholder === t("scopePrompt"))).toEqual([]);
    expect(vs.updates).toEqual([
      [
        KEY,
        [
          { host: "ws.example.com", type: "gitea" },
          { host: "new.example.com", type: "github" }
        ],
        2
      ]
    ]);
  });

  it("writes an edit to the user settings when only they hold the list, even with a workspace open", async () => {
    vs.user = [{ host: "user.example.com", type: "gitea" }];
    vs.replies = [t("add"), "new.example.com", "GitHub", undefined];

    await manage();

    expect(vs.asked.filter(([, , placeholder]) => placeholder === t("scopePrompt"))).toEqual([]);
    expect(vs.updates).toEqual([
      [
        KEY,
        [
          { host: "user.example.com", type: "gitea" },
          { host: "new.example.com", type: "github" }
        ],
        1
      ]
    ]);
  });

  it("goes straight to the forge of a host handed in, lower-cased, marking what it maps to now", async () => {
    vs.replies = [undefined];

    await manage("GitHub.com");

    expect(vs.asked).toEqual([
      ["quickPick", typeRows("github.com", "github"), t("typePrompt", "github.com")]
    ]);
    expect(vs.updates).toEqual([]);
  });

  it("treats an empty host handed in as none", async () => {
    vs.replies = [undefined];

    await manage("");

    expect(vs.asked).toEqual([["quickPick", expect.any(Array), t("pickPrompt")]]);
  });

  it("takes a built-in host picked from the list straight to its forge, and writes an entry overriding it", async () => {
    vs.workspaceOpen = false;
    vs.replies = ["gitlab.com", "Gitea / Forgejo", undefined];

    await manage();

    expect(vs.asked[1]).toEqual([
      "quickPick",
      typeRows("gitlab.com", "gitlab"),
      t("typePrompt", "gitlab.com")
    ]);
    expect(vs.updates).toEqual([[KEY, [{ host: "gitlab.com", type: "gitea" }], 1]]);
  });

  it("asks a custom forge for its URL, starting from a compare URL, and keeps it trimmed", async () => {
    vs.workspaceOpen = false;
    vs.replies = [
      t("add"),
      "git.example.com",
      t("typeCustom"),
      " https://git.example.com/{path}/pulls/new/{branch} ",
      undefined
    ];

    await manage();

    expect(vs.asked[3]).toEqual([
      "input",
      {
        prompt: t("templatePrompt"),
        value: "https://git.example.com/{path}/compare/{branch}",
        ignoreFocusOut: true
      }
    ]);
    expect(vs.updates).toEqual([
      [
        KEY,
        [
          {
            host: "git.example.com",
            type: "custom",
            urlTemplate: "https://git.example.com/{path}/pulls/new/{branch}"
          }
        ],
        1
      ]
    ]);
  });

  it("starts an existing custom entry's URL from its template", async () => {
    vs.user = [{ host: "git.example.com", type: "custom", urlTemplate: "https://x/{branch}" }];
    vs.replies = [undefined, undefined];

    await manage("git.example.com");
    // The forge it maps to now is marked.
    expect(vs.asked[0][1]).toContainEqual({ label: t("typeCustom"), description: "✓" });

    vs.asked = [];
    vs.replies = [t("typeCustom"), undefined];
    await manage("git.example.com");

    expect(vs.asked[1]).toEqual([
      "input",
      { prompt: t("templatePrompt"), value: "https://x/{branch}", ignoreFocusOut: true }
    ]);
    expect(vs.updates).toEqual([]);
  });

  it("refuses a host that is not a hostname, and a URL with no {branch}", async () => {
    vs.workspaceOpen = false;
    vs.replies = [t("add"), "git.example.com", t("typeCustom"), "https://x/{branch}", undefined];

    await manage();

    const [host, template] = vs.validators;
    expect(valid(host, "git.example.com")).toBeNull();
    expect(valid(host, "  git-1.example.com  ")).toBeNull();
    expect(valid(host, "https://git.example.com")).toBe(t("hostInvalid"));
    expect(valid(host, "")).toBe(t("hostInvalid"));
    expect(valid(template, "https://x/{branch}")).toBeNull();
    expect(valid(template, "https://x/")).toBe(t("templateInvalid"));
  });

  it("edits a configured host in place, in the scope holding the list", async () => {
    vs.user = [
      { host: "a.example.com", type: "gitea" },
      { host: "b.example.com", type: "gitlab" }
    ];
    vs.replies = ["a.example.com", t("actionEdit"), "GitLab", undefined];

    await manage();

    expect(vs.asked[1]).toEqual([
      "quickPick",
      [{ label: t("actionEdit") }, { label: t("actionRemove") }],
      t("actionPrompt", "a.example.com")
    ]);
    expect(vs.asked[2]).toEqual([
      "quickPick",
      typeRows("a.example.com", "gitea"),
      t("typePrompt", "a.example.com")
    ]);
    expect(vs.updates).toEqual([
      [
        KEY,
        [
          { host: "a.example.com", type: "gitlab" },
          { host: "b.example.com", type: "gitlab" }
        ],
        1
      ]
    ]);
  });

  it("removes a configured host after a modal confirmation, from the scope holding the list", async () => {
    vs.workspace = [
      { host: "a.example.com", type: "gitea" },
      { host: "b.example.com", type: "gitlab" }
    ];
    vs.replies = ["a.example.com", t("actionRemove"), t("removeConfirmYes"), t("showSetting")];

    await manage();

    expect(vs.asked.slice(2)).toEqual([
      ["warning", t("removeConfirm", "a.example.com"), { modal: true }, [t("removeConfirmYes")]],
      ["information", t("removed", "a.example.com", t("scopeWorkspace")), [t("showSetting")]]
    ]);
    expect(vs.updates).toEqual([[KEY, [{ host: "b.example.com", type: "gitlab" }], 2]]);
    expect(vs.commands).toEqual([["workbench.action.openSettings", KEY]]);
  });

  it("writes nothing when the removal is declined", async () => {
    vs.user = [{ host: "a.example.com", type: "gitea" }];
    vs.replies = ["a.example.com", t("actionRemove"), undefined];

    await manage();

    expect(vs.asked).toHaveLength(3);
    expect(vs.updates).toEqual([]);
  });

  it.each([
    ["the list", [undefined]],
    ["the host", [t("add"), undefined]],
    ["a blank host", [t("add"), "   "]],
    ["the forge", [t("add"), "git.example.com", undefined]],
    ["the custom URL", [t("add"), "git.example.com", t("typeCustom"), undefined]],
    ["the scope", [t("add"), "git.example.com", "GitHub", undefined]],
    ["the action", ["a.example.com", undefined]]
  ])("writes nothing when %s is dismissed", async (_step, replies) => {
    vs.workspace = undefined;
    vs.user = undefined;
    if (replies[0] === "a.example.com") vs.user = [{ host: "a.example.com", type: "gitea" }];
    vs.replies = [...replies];

    await manage();

    expect(vs.updates).toEqual([]);
    expect(vs.asked.map(([kind]) => kind)).not.toContain("information");
  });

  it("reports a write that failed, and says nothing was saved", async () => {
    vs.workspaceOpen = false;
    vs.updateRejects = "disk full";
    vs.replies = [t("add"), "git.example.com", "GitHub"];

    await manage();

    expect(vs.asked.at(-1)).toEqual([
      "error",
      "error.unableToManagePullRequestProvider: disk full"
    ]);
    expect(vs.asked.map(([kind]) => kind)).not.toContain("information");
  });
});
