/* What the desktop host and its settings page (#397) say to each other, and
 * what the page boots with. Desktop-only, so declared under desktop/ and never
 * part of `RequestMessage` / `ResponseMessage` (ADR-0031). */

import type { ResponseMessage } from "@ging/shared/types";

/** The app's theme as the user chose it: one of the two, or the system's.
 *  Spelled as Electron's `nativeTheme.themeSource` is. */
export type ThemeChoice = "system" | "dark" | "light";

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "dark", "light"];

/** One setting, as the page shows it: the schema's node in the app's
 *  language, with the user's value. The page picks the control from it. */
export type SettingsPageSetting = {
  /** In full, as in settings.json; also the row's id, which the markdown
   *  descriptions link to as `#key`. */
  key: string;
  /** As VS Code's Settings editor titles it, e.g. `Dates: Format`. */
  title: string;
  description: string;
  /** Markdown, linking to other settings by `#key`; or plain text. */
  markdown: boolean;
  type: "boolean" | "string" | "number" | "integer" | "array" | "object";
  enum?: unknown[];
  /** One per `enum` entry, where the schema describes them. */
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  default: unknown;
  /** What the app answers for it now: the user's value, or the default. */
  value: unknown;
};

/** The page's own words, in the app's language. */
export type SettingsPageStrings = {
  title: string;
  themeTitle: string;
  themeDescription: string;
  themeSystem: string;
  themeDark: string;
  themeLight: string;
  /** The line under a list or object setting, edited as JSON. */
  editAsJson: string;
  /** A JSON edit that does not parse. */
  invalidJson: string;
  /** `{0}` is why the host did not save it. */
  notSaved: string;
};

/** What a settings page boots with, as the `settingsPage` global. */
export type SettingsPageState = {
  settings: SettingsPageSetting[];
  theme: ThemeChoice;
  strings: SettingsPageStrings;
};

/** The query parameter of the settings page's URL naming the setting the page
 *  opens at, its row scrolled into view: how the host shows one setting, as
 *  VS Code's settings editor does for "show the setting". */
export const SETTING_PARAM = "setting";

/** What the settings page asks of the desktop host. */
export type SettingsRequest =
  | { command: "updateSetting"; key: string; value: unknown }
  | { command: "setTheme"; theme: ThemeChoice };

/** What the desktop host answers an `updateSetting` with: the value the app
 *  holds for `key` now, and `error` — why it was not saved — or null when it
 *  was. A refused value leaves the old one, which the page goes back to. */
export type SettingsResponse = {
  command: "settingUpdated";
  key: string;
  value: unknown;
  error: string | null;
};

/** A host message for the settings page must not be mistaken for one of the
 *  graph's: they share the page's `message` event (ADR-0031's consequences). */
type Overlap = Extract<SettingsResponse["command"], ResponseMessage["command"]>;
export const SETTINGS_COMMANDS_DO_NOT_OVERLAP: [Overlap] extends [never] ? true : never = true;
