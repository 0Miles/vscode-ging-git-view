import * as fs from "node:fs";
import * as path from "node:path";

import { LOCALES, type Manifest, type ManifestNls } from "@ging/desktop/settings/deriveSchema";

const VSCODE_APP = path.resolve(__dirname, "../../../vscode");

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(VSCODE_APP, file), "utf8"));

/** The extension's manifest and its package.nls strings, as the build reads
 *  them to derive the desktop app's settings. */
export function readManifest(): { manifest: Manifest; nls: ManifestNls } {
  return {
    manifest: readJson("package.json"),
    nls: Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        readJson(locale === "en" ? "package.nls.json" : `package.nls.${locale}.json`)
      ])
    ) as ManifestNls
  };
}
