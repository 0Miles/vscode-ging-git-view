import { describe, expect, it } from "vitest";

import {
  createPullRequestProviderCommands,
  PULL_REQUEST_PROVIDERS_SETTING as KEY
} from "@ging/core/extension/pullRequestProviderCommands";
import type { HostConfig, SettingScope } from "@ging/core/host/ports";

import { fakePorts } from "@ging/core/tests/helpers";

// Manage Pull Request Providers in core (#398), through the ports alone. How
// VS Code shows it is pinned at VS Code's API in apps/vscode's
// pullRequestProviders.test.ts; this is what any host gets: the scope the list
// is written to, by what `HostConfig.inspect` says, and the prompts' rows.

const t = (key: string, ...args: string[]) => [`pullRequest.providers.${key}`, ...args].join("|");

/** A host with the two tiers VS Code has: the workspace's list, when set,
 *  replaces the user's whole. */
function twoTierConfig(workspaceOpen: boolean) {
  const tiers: Partial<Record<SettingScope, unknown>> = {};
  const inForce = () => tiers.workspace ?? tiers.global ?? [];
  const config: Pick<HostConfig, "pullRequestProviders" | "inspect" | "update"> = {
    pullRequestProviders: () => inForce() as ReturnType<HostConfig["pullRequestProviders"]>,
    inspect: () => ({
      source:
        tiers.workspace !== undefined ? "workspace" : tiers.global !== undefined ? "global" : null,
      scopes: workspaceOpen ? ["global", "workspace"] : ["global"]
    }),
    update: async (_key, value, scope = "global") => {
      tiers[scope] = value;
    }
  };
  return { config, tiers };
}

function setUp(config?: Pick<HostConfig, "pullRequestProviders" | "inspect" | "update">) {
  const { ports, calls, answers, held } = fakePorts();
  const revealed: string[] = [];
  const commands = createPullRequestProviderCommands({
    prompts: ports.prompts,
    l10n: ports.l10n,
    config: config ?? ports.config,
    revealSetting: (key) => revealed.push(key)
  });
  /** Run the command, then the "show the setting" answer it does not wait for. */
  const manage = async (host?: string | null) => {
    await commands.manage(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { manage, calls, answers, held, revealed };
}

/** The `validate` of the `index`th input asked. */
function validatorOf(calls: unknown[][], index: number) {
  const inputs = calls.filter(([name]) => name === "input");
  return (inputs[index][1] as { validate: (text: string) => string | undefined }).validate;
}

describe("Manage Pull Request Providers", () => {
  it("writes a host to the one scope a single-tier host offers, without asking which", async () => {
    const h = setUp();
    h.answers.replies = [t("add"), "Git.Example.com", "GitLab", t("showSetting")];

    await h.manage();

    expect(h.calls.filter(([name]) => name !== "pick" && name !== "input")).toEqual([
      ["config.update", KEY, [{ host: "git.example.com", type: "gitlab" }], "global"],
      [
        "showInformation",
        t("saved", "git.example.com", t("scopeUser")),
        { modal: undefined, actions: [t("showSetting")] }
      ]
    ]);
    expect(h.held.settings[KEY]).toEqual([{ host: "git.example.com", type: "gitlab" }]);
    expect(h.revealed).toEqual([KEY]);
  });

  it("asks which scope when the host offers two and neither holds the list", async () => {
    const { config, tiers } = twoTierConfig(true);
    const h = setUp(config);
    h.answers.replies = [t("add"), "git.example.com", "GitHub", t("scopeWorkspace"), undefined];

    await h.manage();

    expect(h.calls.findLast(([name]) => name === "pick")).toEqual([
      "pick",
      [{ label: t("scopeUser") }, { label: t("scopeWorkspace") }],
      { placeholder: t("scopePrompt") }
    ]);
    expect(tiers).toEqual({ workspace: [{ host: "git.example.com", type: "github" }] });
    expect(h.revealed).toEqual([]);
  });

  it("writes back to the scope in force, the workspace's over the user's", async () => {
    const { config, tiers } = twoTierConfig(true);
    tiers.global = [{ host: "user.example.com", type: "gitea" }];
    tiers.workspace = [{ host: "ws.example.com", type: "gitea" }];
    const h = setUp(config);
    h.answers.replies = ["ws.example.com", t("actionRemove"), t("removeConfirmYes"), undefined];

    await h.manage();

    expect(h.calls).toContainEqual([
      "choose",
      t("removeConfirm", "ws.example.com"),
      { detail: undefined, actions: [t("removeConfirmYes")] }
    ]);
    expect(tiers).toEqual({ global: [{ host: "user.example.com", type: "gitea" }], workspace: [] });
  });

  it("lists the add row, then every host below one rule, the configured first", async () => {
    const { config, tiers } = twoTierConfig(false);
    tiers.global = [{ host: "git.example.com", type: "custom", urlTemplate: "https://x/{branch}" }];
    const h = setUp(config);
    h.answers.replies = [undefined];

    await h.manage();

    const [[, rows, options]] = h.calls as [string, Record<string, unknown>[], unknown][];
    expect(options).toEqual({ placeholder: t("pickPrompt") });
    expect(rows.map(({ label, separatorAbove }) => [label, separatorAbove === true])).toEqual([
      [t("add"), false],
      ["git.example.com", true],
      ["github.com", false],
      ["gitlab.com", false],
      ["bitbucket.org", false],
      ["gitea.com", false],
      ["codeberg.org", false]
    ]);
    expect(rows[1]).toMatchObject({
      description: `${t("typeCustom")} · ${t("scopeUser")}`,
      detail: "https://x/{branch}"
    });
  });

  it("puts the rule above the first built-in host when none is configured", async () => {
    const h = setUp();
    h.answers.replies = [undefined];

    await h.manage();

    const [[, rows]] = h.calls as [string, Record<string, unknown>[]][];
    expect(rows.filter((row) => row.separatorAbove === true).map((row) => row.label)).toEqual([
      "github.com"
    ]);
  });

  it("shows each forge's URL for the host, and marks the one it maps to now", async () => {
    const h = setUp();
    h.answers.replies = [undefined];

    await h.manage("Codeberg.org");

    expect(h.calls).toEqual([
      [
        "pick",
        [
          {
            label: "GitHub",
            description: undefined,
            detail: "https://codeberg.org/owner/repo/compare/my-branch?expand=1"
          },
          {
            label: "GitLab",
            description: undefined,
            detail:
              "https://codeberg.org/owner/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=my-branch"
          },
          {
            label: "Bitbucket",
            description: undefined,
            detail: "https://codeberg.org/owner/repo/pull-requests/new?source=my-branch&t=1"
          },
          {
            label: "Gitea / Forgejo",
            description: "✓",
            detail: "https://codeberg.org/owner/repo/compare/my-branch"
          },
          { label: t("typeCustom"), description: undefined, detail: undefined }
        ],
        { placeholder: t("typePrompt", "codeberg.org") }
      ]
    ]);
  });

  it("has the prompts refuse a host that is not a hostname and a URL with no {branch}", async () => {
    const h = setUp();
    h.answers.replies = [t("add"), "git.example.com", t("typeCustom"), undefined];

    await h.manage();

    const host = validatorOf(h.calls, 0);
    expect(host(" git.example.com ")).toBeUndefined();
    expect(host("https://git.example.com")).toBe(t("hostInvalid"));
    const template = validatorOf(h.calls, 1);
    expect(h.calls.filter(([name]) => name === "input")[1][1]).toMatchObject({
      prompt: t("templatePrompt"),
      value: "https://git.example.com/{path}/compare/{branch}"
    });
    expect(template("https://x/{branch}")).toBeUndefined();
    expect(template("https://x/")).toBe(t("templateInvalid"));
    expect(h.held.settings).toEqual({});
  });

  it("says a write was refused, and nothing about saving", async () => {
    const h = setUp();
    h.answers.updateRejects = "The value given is not one its schema allows";
    h.answers.replies = [t("add"), "git.example.com", "GitHub"];

    await h.manage();

    expect(h.calls.at(-1)).toEqual([
      "showError",
      "error.unableToManagePullRequestProvider: The value given is not one its schema allows"
    ]);
    expect(h.calls.map(([name]) => name)).not.toContain("showInformation");
  });
});
