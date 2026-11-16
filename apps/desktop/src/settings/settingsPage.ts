/* The desktop host's half of the settings page (#397): what the page boots
 * with, built from the settings schema in the app's language, and what the
 * host does with what the page asks. The page itself is the webview's
 * (`@ging/webview/desktop/settings/settingsPage`). */

import type { HostConfig, HostLogger, L10n } from "@ging/core/host/ports";
import { bundleLocale } from "@ging/desktop/ports/l10n";
import { isThemeChoice } from "@ging/desktop/themeChoice";
import type {
  SettingsPageState,
  SettingsResponse,
  ThemeChoice
} from "@ging/webview/desktop/settings/protocol";

import type { Locale, SettingsSchema } from "./deriveSchema";
import { type Settings, SettingRefused, SettingsFileNotAnObject } from "./settingsFile";

/** The schema's language for Electron's `app.getLocale()`: the l10n bundles'
 *  choice, which the schema's locales are named after. */
export function schemaLocale(appLocale: string): Locale {
  return (bundleLocale(appLocale) as Locale | null) ?? "en";
}

/** What a settings page boots with: every setting of `schema`, in `locale`,
 *  with the value the app holds for it now, and the theme chosen. */
export function buildSettingsPageState({
  schema,
  settings,
  locale,
  l10n,
  theme
}: {
  schema: SettingsSchema;
  settings: Pick<Settings, "get">;
  locale: Locale;
  l10n: L10n;
  theme: ThemeChoice;
}): SettingsPageState {
  return {
    settings: schema.settings.map((setting) => ({
      key: setting.key,
      title: setting.title,
      description: setting.description[locale],
      markdown: setting.descriptionFormat === "markdown",
      type: setting.type,
      ...(setting.enum === undefined ? {} : { enum: setting.enum }),
      ...(setting.enumDescriptions === undefined
        ? {}
        : { enumDescriptions: setting.enumDescriptions.map((text) => text[locale]) }),
      ...(setting.minimum === undefined ? {} : { minimum: setting.minimum }),
      ...(setting.maximum === undefined ? {} : { maximum: setting.maximum }),
      default: setting.default,
      value: settings.get(setting.key)
    })),
    theme,
    strings: {
      title: l10n.t("desktop.settings.title"),
      themeTitle: l10n.t("desktop.settings.theme"),
      themeDescription: l10n.t("desktop.settings.themeDescription"),
      themeSystem: l10n.t("desktop.settings.themeSystem"),
      themeDark: l10n.t("desktop.settings.themeDark"),
      themeLight: l10n.t("desktop.settings.themeLight"),
      editAsJson: l10n.t("desktop.settings.editAsJson"),
      invalidJson: l10n.t("desktop.settings.invalidJson"),
      notSaved: l10n.t("desktop.settings.notSaved")
    }
  };
}

export type SettingsPageDeps = {
  config: Pick<HostConfig, "update">;
  settings: Pick<Settings, "get">;
  l10n: L10n;
  logger: Pick<HostLogger, "log" | "logError">;
  /** Each open graph instance, told of every setting written. */
  instances: () => Iterable<{ settingChanged(key: string): void }>;
  /** Apply and keep the theme the user chose. */
  setTheme: (choice: ThemeChoice) => void;
};

/** Why a write failed, in the user's words; the system's own words, in
 *  English, go to the log only. */
function failure(e: unknown, l10n: L10n): string {
  if (e instanceof SettingRefused) {
    return l10n.t(
      e.reason === "unknownKey" ? "desktop.settings.unknownSetting" : "desktop.settings.notAllowed"
    );
  }
  if (e instanceof SettingsFileNotAnObject) return l10n.t("desktop.settings.cannotParse");
  return l10n.t("desktop.settings.cannotWrite");
}

/** What the host does with each message its settings page posts. A setting
 *  is written through `HostConfig.update`, every graph instance is told of
 *  it, and the page is answered with the value the app holds now — the new
 *  one, or, when the write failed, the old one and why. */
export function createSettingsPageHandler(deps: SettingsPageDeps) {
  const { config, settings, l10n, logger } = deps;
  /** What the app holds for `key`; nothing, for a key it has no setting for. */
  const valueOf = (key: string): unknown => {
    try {
      return settings.get(key);
    } catch {
      return undefined;
    }
  };

  /** `reply` answers the page that posted `message`. */
  return async (message: unknown, reply: (answer: SettingsResponse) => void): Promise<void> => {
    const m = message as { command?: unknown; key?: unknown; value?: unknown; theme?: unknown };
    if (m?.command === "updateSetting" && typeof m.key === "string") {
      const key = m.key;
      try {
        await config.update(key, m.value);
      } catch (e) {
        // A refused value is the user's to fix, and they are told; a file
        // that cannot be written is the app's trouble.
        const line = `settings: ${key} not saved: ${e instanceof Error ? e.message : String(e)}`;
        if (e instanceof SettingRefused) logger.log(line);
        else logger.logError(line);
        reply({ command: "settingUpdated", key, value: valueOf(key), error: failure(e, l10n) });
        return;
      }
      logger.log(`settings: ${key} saved`);
      for (const instance of deps.instances()) instance.settingChanged(key);
      reply({ command: "settingUpdated", key, value: valueOf(key), error: null });
      return;
    }
    if (m?.command === "setTheme" && isThemeChoice(m.theme)) {
      logger.log(`settings: theme ${m.theme}`);
      deps.setTheme(m.theme);
      return;
    }
    logger.log(`settings: ignored a message the page posted: ${JSON.stringify(m?.command)}`);
  };
}
