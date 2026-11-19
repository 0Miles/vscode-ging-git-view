/* Who hears of a setting written (#446): every write that lands through
 * `Settings.update` — the settings page's, or one made elsewhere through
 * `HostConfig.update`, such as Manage Pull Request Providers' (#398) — is
 * shown in an open settings window and told to each graph instance, once.
 * One source for every writer, so none has to remember to tell anyone. */

import type { Settings } from "./settings/settingsFile";
import type { SettingsWindow } from "./settingsWindow";

export function tellOfSettingWrites({
  settings,
  settingsWindow,
  instances
}: {
  settings: Pick<Settings, "onDidUpdate">;
  settingsWindow: Pick<SettingsWindow, "updated">;
  /** Each open graph instance. */
  instances: () => Iterable<{ settingChanged(key: string): void }>;
}): { dispose(): void } {
  return settings.onDidUpdate((key) => {
    settingsWindow.updated(key);
    for (const instance of instances()) instance.settingChanged(key);
  });
}
