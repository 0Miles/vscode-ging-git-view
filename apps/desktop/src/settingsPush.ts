/* What a graph instance is told when the desktop host writes a setting (#397).
 * `HostConfig` is read, never pushed, so after `update` the host does what VS
 * Code's `onDidChangeConfiguration` handlers do for the extension
 * (apps/vscode/src/extension.ts): re-arm the auto-fetch timer, and tell the
 * graph a Repository Setting's default moved. The settings only the page's
 * view state reads take effect the next time the page is built, as in VS Code
 * (`HostConfig`'s note). `setScmMultiRepoSelection` has no counterpart: the
 * desktop host's answer never changes (`scmMultiRepoSelection`). */

import { REPO_SETTING_DEFAULT_KEYS } from "@ging/core/extension/repoSettings";
import type { HostConfig } from "@ging/core/host/ports";
import type { RepoSettingField, ResponseMessage } from "@ging/shared/types";

/** The section whose settings arm the auto-fetch timer, as VS Code's
 *  `affectsConfiguration("ging-git-view.autoFetch")` matches it. */
const AUTO_FETCH_SECTION = "ging-git-view.autoFetch.";

/** What of a graph instance a setting change reaches. */
export type SettingChangeTarget = {
  restartAutoFetch(): void;
  post(message: ResponseMessage): void;
};

/** Tell `target` that `key` was just written, reading the new values from
 *  `config`. */
export function pushSettingChange(
  key: string,
  target: SettingChangeTarget,
  config: Pick<HostConfig, "repoSettingDefaults" | "showRemoteBranches">
): void {
  if (key.startsWith(AUTO_FETCH_SECTION)) target.restartAutoFetch();
  const changed = (Object.keys(REPO_SETTING_DEFAULT_KEYS) as RepoSettingField[]).filter(
    (field) => REPO_SETTING_DEFAULT_KEYS[field] === key
  );
  if (changed.length === 0) return;
  // The graph knows which repository it shows and whether it overrides what
  // moved, so it is told what moved and decides (ADR-0024).
  target.post({
    command: "setRepoSettingDefaults",
    defaults: config.repoSettingDefaults(),
    showRemoteBranches: config.showRemoteBranches(),
    changed
  });
}
