import * as vscode from "vscode";

import {
  BUILT_IN_PULL_REQUEST_PROVIDERS,
  BUILT_IN_TEMPLATES,
  fillPullRequestUrlTemplate,
  normalizePullRequestProviders,
  PULL_REQUEST_PROVIDER_TYPES,
  type PullRequestProvider,
  type PullRequestProviderType
} from "@/backend/utils/pullRequest";
import * as l10n from "@/l10n";

/**
 * The UI over the `pullRequests.providers` setting: a quick-pick that lists
 * which host maps to which forge and edits that list in settings.json.
 *
 * It is a view onto the setting, never a second store — every change is written
 * back to a named settings scope and the user is told which one, so "where is
 * this kept?" always has an answer they can open (ADR-0021).
 */

const SECTION = "ging-git-view";
const KEY = "pullRequests.providers";
export const PULL_REQUEST_PROVIDERS_SETTING = `${SECTION}.${KEY}`;

/** The settings scopes this command reads and writes. A provider is a property
 *  of a host, not of one folder in a workspace, so folder scope is left out. */
type Scope = "user" | "workspace";

const SCOPE_TARGET: Record<Scope, vscode.ConfigurationTarget> = {
  user: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace
};

function scopeLabel(scope: Scope): string {
  return scope === "workspace"
    ? l10n.t("pullRequest.providers.scopeWorkspace")
    : l10n.t("pullRequest.providers.scopeUser");
}

/** A Record rather than a switch with a default: adding a forge type has to
 *  fail to compile here, not silently inherit the custom label. */
const TYPE_LABELS: Record<Exclude<PullRequestProviderType, "custom">, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitea: "Gitea / Forgejo"
};

function typeLabel(type: PullRequestProviderType): string {
  // Only the custom label is translated; the rest are product names.
  return type === "custom" ? l10n.t("pullRequest.providers.typeCustom") : TYPE_LABELS[type];
}

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

/** The providers currently in force, from whichever scope defines them. */
function configuredProviders(): PullRequestProvider[] {
  return normalizePullRequestProviders(
    vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY, [])
  );
}

/** The scope the list is being read from, or null when nothing is set anywhere.
 *  Arrays do not merge across scopes — the most specific one wins outright — so
 *  edits have to go back to the scope already in force, or they vanish. */
function activeScope(): Scope | null {
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(KEY);
  if (inspected?.workspaceValue !== undefined) return "workspace";
  return inspected?.globalValue !== undefined ? "user" : null;
}

/** Where an edit should land: the scope already holding the list, else the
 *  user's choice when a workspace could hold one, else user settings. */
async function targetScope(): Promise<Scope | undefined> {
  const active = activeScope();
  if (active !== null) return active;
  if (vscode.workspace.workspaceFolders === undefined) return "user";
  const picked = await vscode.window.showQuickPick(
    (<Scope[]>["user", "workspace"]).map((scope) => ({ label: scopeLabel(scope), scope })),
    { placeHolder: l10n.t("pullRequest.providers.scopePrompt") }
  );
  return picked?.scope;
}

async function writeProviders(providers: PullRequestProvider[], scope: Scope): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(KEY, providers, SCOPE_TARGET[scope]);
}

/** Report what was written and offer the setting itself — the whole point of
 *  the command is that the store is not a secret. */
function reportSaved(message: string): void {
  const show = l10n.t("pullRequest.providers.showSetting");
  void vscode.window.showInformationMessage(message, show).then((choice) => {
    if (choice === show) {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        PULL_REQUEST_PROVIDERS_SETTING
      );
    }
  });
}

async function promptForHost(): Promise<string | undefined> {
  const host = await vscode.window.showInputBox({
    prompt: l10n.t("pullRequest.providers.hostPrompt"),
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[a-zA-Z0-9.-]+$/.test(value.trim()) ? null : l10n.t("pullRequest.providers.hostInvalid")
  });
  return host?.trim().toLowerCase();
}

/** Add or replace the provider for `host`, asking which forge runs there (and,
 *  for a custom one, for the URL). Pre-selects whatever the host maps to now,
 *  so editing an existing entry starts from it. */
async function editProvider(host: string): Promise<void> {
  const providers = configuredProviders();
  const existing =
    providers.find((provider) => provider.host === host) ??
    BUILT_IN_PULL_REQUEST_PROVIDERS.find((provider) => provider.host === host);

  const typePick = await vscode.window.showQuickPick(
    PULL_REQUEST_PROVIDER_TYPES.map((type) => ({
      label: typeLabel(type),
      description: type === existing?.type ? "✓" : undefined,
      detail: typeExampleUrl(type, host),
      type
    })),
    { placeHolder: l10n.t("pullRequest.providers.typePrompt", host) }
  );
  if (typePick === undefined) return;

  let urlTemplate: string | undefined;
  if (typePick.type === "custom") {
    urlTemplate = await vscode.window.showInputBox({
      prompt: l10n.t("pullRequest.providers.templatePrompt"),
      value: existing?.urlTemplate ?? `https://${host}/{path}/compare/{branch}`,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.includes("{branch}") ? null : l10n.t("pullRequest.providers.templateInvalid")
    });
    if (urlTemplate === undefined) return;
  }

  const scope = await targetScope();
  if (scope === undefined) return;
  const entry: PullRequestProvider = {
    host,
    type: typePick.type,
    ...(urlTemplate !== undefined ? { urlTemplate: urlTemplate.trim() } : {})
  };
  const next = providers.some((provider) => provider.host === host)
    ? providers.map((provider) => (provider.host === host ? entry : provider))
    : [...providers, entry];
  await writeProviders(next, scope);
  reportSaved(l10n.t("pullRequest.providers.saved", host, scopeLabel(scope)));
}

async function removeProvider(host: string): Promise<void> {
  // Unreachable in practice: this is only offered for a configured provider,
  // and a configured provider means some scope holds the list.
  const scope = activeScope();
  if (scope === null) return;
  const yes = l10n.t("pullRequest.providers.removeConfirmYes");
  const confirm = await vscode.window.showWarningMessage(
    l10n.t("pullRequest.providers.removeConfirm", host),
    { modal: true },
    yes
  );
  if (confirm !== yes) return;
  await writeProviders(
    configuredProviders().filter((provider) => provider.host !== host),
    scope
  );
  reportSaved(l10n.t("pullRequest.providers.removed", host, scopeLabel(scope)));
}

/**
 * The command itself. `host` pre-selects which host to configure — the path in
 * from a failed "Create Pull Request", where the host is already known and
 * making the user retype it would be the whole friction the command exists to
 * remove.
 */
export async function managePullRequestProviders(host?: string | null): Promise<void> {
  try {
    if (typeof host === "string" && host !== "") {
      await editProvider(host.toLowerCase());
      return;
    }
    const providers = configuredProviders();
    const scope = activeScope();
    const builtIn = l10n.t("pullRequest.providers.builtIn");
    const items: (vscode.QuickPickItem & { host?: string; configured?: boolean })[] = [
      {
        label: l10n.t("pullRequest.providers.add"),
        detail: l10n.t("pullRequest.providers.addDetail")
      },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      ...providers.map((provider) => ({
        label: provider.host,
        description: `${typeLabel(provider.type)} · ${scope === null ? "" : scopeLabel(scope)}`,
        detail: provider.urlTemplate,
        host: provider.host,
        configured: true
      })),
      // Listed too, so the built-in mapping is visible rather than folklore —
      // picking one writes an entry that overrides it.
      ...BUILT_IN_PULL_REQUEST_PROVIDERS.filter(
        (provider) => !providers.some((configured) => configured.host === provider.host)
      ).map((provider) => ({
        label: provider.host,
        description: `${typeLabel(provider.type)} · ${builtIn}`,
        host: provider.host,
        configured: false
      }))
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: l10n.t("pullRequest.providers.pickPrompt")
    });
    if (picked === undefined) return;
    if (picked.host === undefined) {
      const newHost = await promptForHost();
      if (newHost === undefined || newHost === "") return;
      await editProvider(newHost);
      return;
    }
    if (picked.configured !== true) {
      await editProvider(picked.host); // overriding a built-in: straight to the type
      return;
    }
    const edit = l10n.t("pullRequest.providers.actionEdit");
    const remove = l10n.t("pullRequest.providers.actionRemove");
    const action = await vscode.window.showQuickPick([edit, remove], {
      placeHolder: l10n.t("pullRequest.providers.actionPrompt", picked.host)
    });
    if (action === edit) await editProvider(picked.host);
    else if (action === remove) await removeProvider(picked.host);
  } catch (e: unknown) {
    void vscode.window.showErrorMessage(
      l10n.t("error.unableToManagePullRequestProvider") +
        ": " +
        (e instanceof Error ? e.message : String(e))
    );
  }
}
