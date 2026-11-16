/**
 * Manage Pull Request Providers: the prompts over the `pullRequests.providers`
 * setting, which list which host maps to which forge and edit that list.
 *
 * It is a view onto the setting, never a second store — every change is written
 * back to a named settings scope and the user is told which one, so "where is
 * this kept?" always has an answer they can open (ADR-0021).
 */

import {
  BUILT_IN_PULL_REQUEST_PROVIDERS,
  BUILT_IN_TEMPLATES,
  fillPullRequestUrlTemplate,
  PULL_REQUEST_PROVIDER_TYPES,
  type PullRequestProvider,
  type PullRequestProviderType
} from "@ging/core/backend/utils/pullRequest";
import type { HostConfig, L10n, PickItem, Prompts, SettingScope } from "@ging/core/host/ports";

/** The setting, its key in full. */
export const PULL_REQUEST_PROVIDERS_SETTING = "ging-git-view.pullRequests.providers";

export type PullRequestProviderCommandsDeps = {
  prompts: Pick<Prompts, "pick" | "input" | "choose" | "showInformation" | "showError">;
  l10n: L10n;
  config: Pick<HostConfig, "pullRequestProviders" | "inspect" | "update">;
  /** Bring setting `key` into view where the user edits settings. Writing is
   *  all `update` does, so a host whose settings view shows a copy read
   *  before brings it up to date here. */
  revealSetting: (key: string) => void;
};

export type PullRequestProviderCommands = ReturnType<typeof createPullRequestProviderCommands>;

/** A Record rather than a switch with a default: adding a forge type has to
 *  fail to compile here, not silently inherit the custom label. */
const TYPE_LABELS: Record<Exclude<PullRequestProviderType, "custom">, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitea: "Gitea / Forgejo"
};

/** The URL a type opens, spelled out against a sample repo — what makes the
 *  difference between the forges concrete in the picker. */
function typeExampleUrl(type: PullRequestProviderType, host: string): string | undefined {
  if (type === "custom") return undefined;
  return fillPullRequestUrlTemplate(
    BUILT_IN_TEMPLATES[type],
    { host, path: "owner/repo" },
    "my-branch"
  );
}

/** A row of the list: the row that adds a host, or a host, configured or
 *  built in. Told apart by value, since a host can be named anything. */
type ListRow = { add: true } | { add?: false; host: string; configured: boolean };

export function createPullRequestProviderCommands(deps: PullRequestProviderCommandsDeps) {
  const { prompts, l10n, config } = deps;

  const scopeLabel = (scope: SettingScope): string =>
    scope === "workspace"
      ? l10n.t("pullRequest.providers.scopeWorkspace")
      : l10n.t("pullRequest.providers.scopeUser");

  /** Only the custom label is translated; the rest are product names. */
  const typeLabel = (type: PullRequestProviderType): string =>
    type === "custom" ? l10n.t("pullRequest.providers.typeCustom") : TYPE_LABELS[type];

  /** The scope the list is read from, or null when nothing is set anywhere.
   *  A list does not merge across scopes, so an edit has to go back to the
   *  scope already in force, or it vanishes behind it. */
  const activeScope = (): SettingScope | null =>
    config.inspect(PULL_REQUEST_PROVIDERS_SETTING).source;

  /** Where an edit should land: the scope already holding the list, else the
   *  user's choice when the host offers more than one, else the user's own.
   *  A provider is a property of a host, not of one folder in a workspace,
   *  so no host's per-folder settings are offered. */
  const targetScope = async (): Promise<SettingScope | undefined> => {
    const { source, scopes } = config.inspect(PULL_REQUEST_PROVIDERS_SETTING);
    if (source !== null) return source;
    if (scopes.length < 2) return scopes[0] ?? "global";
    return prompts.pick(
      scopes.map((scope) => ({ label: scopeLabel(scope), value: scope })),
      { placeholder: l10n.t("pullRequest.providers.scopePrompt") }
    );
  };

  const writeProviders = async (providers: PullRequestProvider[], scope: SettingScope) => {
    await config.update(PULL_REQUEST_PROVIDERS_SETTING, providers, scope);
  };

  /** Report what was written and offer the setting itself — the whole point of
   *  the command is that the store is not a secret. Not waited for. */
  const reportSaved = (message: string): void => {
    void Promise.resolve(
      prompts.showInformation(message, {
        actions: [{ label: l10n.t("pullRequest.providers.showSetting"), value: true }]
      })
    ).then((show) => {
      if (show === true) deps.revealSetting(PULL_REQUEST_PROVIDERS_SETTING);
    });
  };

  const promptForHost = async (): Promise<string | undefined> => {
    const host = await prompts.input({
      prompt: l10n.t("pullRequest.providers.hostPrompt"),
      validate: (value) =>
        /^[a-zA-Z0-9.-]+$/.test(value.trim())
          ? undefined
          : l10n.t("pullRequest.providers.hostInvalid")
    });
    return host?.trim().toLowerCase();
  };

  /** Add or replace the provider for `host`, asking which forge runs there (and,
   *  for a custom one, for the URL). Marks whatever the host maps to now, so
   *  editing an existing entry starts from it. */
  const editProvider = async (host: string): Promise<void> => {
    const providers = config.pullRequestProviders();
    const existing =
      providers.find((provider) => provider.host === host) ??
      BUILT_IN_PULL_REQUEST_PROVIDERS.find((provider) => provider.host === host);

    const type = await prompts.pick(
      PULL_REQUEST_PROVIDER_TYPES.map((value) => ({
        label: typeLabel(value),
        description: value === existing?.type ? "✓" : undefined,
        detail: typeExampleUrl(value, host),
        value
      })),
      { placeholder: l10n.t("pullRequest.providers.typePrompt", host) }
    );
    if (type === undefined) return;

    let urlTemplate: string | undefined;
    if (type === "custom") {
      urlTemplate = await prompts.input({
        prompt: l10n.t("pullRequest.providers.templatePrompt"),
        value: existing?.urlTemplate ?? `https://${host}/{path}/compare/{branch}`,
        validate: (value) =>
          value.includes("{branch}") ? undefined : l10n.t("pullRequest.providers.templateInvalid")
      });
      if (urlTemplate === undefined) return;
    }

    const scope = await targetScope();
    if (scope === undefined) return;
    const entry: PullRequestProvider = {
      host,
      type,
      ...(urlTemplate !== undefined ? { urlTemplate: urlTemplate.trim() } : {})
    };
    const next = providers.some((provider) => provider.host === host)
      ? providers.map((provider) => (provider.host === host ? entry : provider))
      : [...providers, entry];
    await writeProviders(next, scope);
    reportSaved(l10n.t("pullRequest.providers.saved", host, scopeLabel(scope)));
  };

  const removeProvider = async (host: string): Promise<void> => {
    // Unreachable in practice: this is only offered for a configured provider,
    // and a configured provider means some scope holds the list.
    const scope = activeScope();
    if (scope === null) return;
    const confirmed = await prompts.choose(l10n.t("pullRequest.providers.removeConfirm", host), {
      actions: [{ label: l10n.t("pullRequest.providers.removeConfirmYes"), value: true }]
    });
    if (confirmed !== true) return;
    await writeProviders(
      config.pullRequestProviders().filter((provider) => provider.host !== host),
      scope
    );
    reportSaved(l10n.t("pullRequest.providers.removed", host, scopeLabel(scope)));
  };

  /** The list: "add a host", then the configured providers with the scope
   *  holding them, then the built-in hosts no entry overrides. */
  const pickFromList = (): PromiseLike<ListRow | undefined> => {
    const providers = config.pullRequestProviders();
    const scope = activeScope();
    const builtIn = l10n.t("pullRequest.providers.builtIn");
    const hosts: PickItem<ListRow>[] = [
      ...providers.map((provider) => ({
        label: provider.host,
        description: `${typeLabel(provider.type)} · ${scope === null ? "" : scopeLabel(scope)}`,
        detail: provider.urlTemplate,
        value: { host: provider.host, configured: true }
      })),
      // Listed too, so the built-in mapping is visible rather than folklore —
      // picking one writes an entry that overrides it.
      ...BUILT_IN_PULL_REQUEST_PROVIDERS.filter(
        (provider) => !providers.some((configured) => configured.host === provider.host)
      ).map((provider) => ({
        label: provider.host,
        description: `${typeLabel(provider.type)} · ${builtIn}`,
        value: { host: provider.host, configured: false }
      }))
    ];
    // The hosts, below one rule.
    if (hosts[0] !== undefined) hosts[0].separatorAbove = true;
    return prompts.pick(
      [
        {
          label: l10n.t("pullRequest.providers.add"),
          detail: l10n.t("pullRequest.providers.addDetail"),
          value: { add: true }
        },
        ...hosts
      ],
      { placeholder: l10n.t("pullRequest.providers.pickPrompt") }
    );
  };

  return {
    /**
     * The command. `host` goes straight to that host's forge — the path in
     * from a failed "Create Pull Request", where the host is already known and
     * making the user retype it would be the whole friction the command exists
     * to remove. A failure, a write refused say, is told as a notice.
     */
    async manage(host?: string | null): Promise<void> {
      try {
        if (typeof host === "string" && host !== "") {
          await editProvider(host.toLowerCase());
          return;
        }
        const picked = await pickFromList();
        if (picked === undefined) return;
        if (picked.add === true) {
          const newHost = await promptForHost();
          if (newHost === undefined || newHost === "") return;
          await editProvider(newHost);
          return;
        }
        if (!picked.configured) {
          await editProvider(picked.host); // overriding a built-in: straight to the type
          return;
        }
        const edit = l10n.t("pullRequest.providers.actionEdit");
        const remove = l10n.t("pullRequest.providers.actionRemove");
        const action = await prompts.pick(
          [
            { label: edit, value: editProvider },
            { label: remove, value: removeProvider }
          ],
          { placeholder: l10n.t("pullRequest.providers.actionPrompt", picked.host) }
        );
        await action?.(picked.host);
      } catch (e: unknown) {
        void prompts.showError(
          l10n.t("error.unableToManagePullRequestProvider") +
            ": " +
            (e instanceof Error ? e.message : String(e))
        );
      }
    }
  };
}
