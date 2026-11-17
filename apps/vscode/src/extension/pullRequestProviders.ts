import * as vscode from "vscode";

import { createPullRequestProviderCommands } from "@ging/core/extension/pullRequestProviderCommands";
import { config } from "@ging/vscode/config";
import { vscodeL10n, vscodePrompts } from "@ging/vscode/hostPorts";

/**
 * The `managePullRequestProviders` command: core's flow (ADR-0021), asked
 * through VS Code's prompts and written to its settings, whose editor is
 * where "show the setting" goes. `host` goes straight to that host's forge.
 */
export const managePullRequestProviders = createPullRequestProviderCommands({
  prompts: vscodePrompts,
  l10n: vscodeL10n,
  config,
  revealSetting: (key) => void vscode.commands.executeCommand("workbench.action.openSettings", key)
}).manage;
