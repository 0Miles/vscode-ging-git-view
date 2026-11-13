import * as path from "node:path";

import type { SettingsSchema } from "./deriveSchema";
import generated from "./schema.generated.json";
import { openSettings, type Settings } from "./settingsFile";

/** The desktop app's settings, as derived from the extension's when the app
 *  was built (deriveSchema.ts); bundled into the app, so nothing reads
 *  apps/vscode at run time. */
export const DESKTOP_SETTINGS_SCHEMA = generated as SettingsSchema;

/** The user's settings in `userDataPath`, held to `DESKTOP_SETTINGS_SCHEMA`. */
export function openDesktopSettings(userDataPath: string): Settings {
  return openSettings(path.join(userDataPath, "settings.json"), DESKTOP_SETTINGS_SCHEMA);
}
