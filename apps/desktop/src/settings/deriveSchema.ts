/* The desktop app's settings, derived from the extension's: the
 * `contributes.configuration` of apps/vscode/package.json and its
 * package.nls*.json strings, less what only means something inside VS Code.
 *
 * This runs at build time only, from a vitest suite that writes the result to
 * schema.generated.json (tests/settings/schema.test.ts): the app reads that
 * file, and never apps/vscode. Run the suite with `-u` after changing the
 * extension's settings or their strings, and the diff shows what desktop users
 * get. */

/** The locales the extension's settings are translated into, by VS Code's
 *  names; `en` is package.nls.json. */
export const LOCALES = ["en", "zh-cn", "zh-tw"] as const;
export type Locale = (typeof LOCALES)[number];
export type LocalizedText = Record<Locale, string>;

/** Each locale's package.nls strings, by key. */
export type ManifestNls = Record<Locale, Record<string, string>>;

/** A JSON schema node as VS Code's settings use it, with every string the user
 *  reads localized. */
export type SchemaNode = {
  type: "boolean" | "string" | "number" | "integer" | "array" | "object";
  default?: unknown;
  enum?: unknown[];
  enumDescriptions?: LocalizedText[];
  minimum?: number;
  maximum?: number;
  /** A regular expression a string must match. */
  pattern?: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  description?: LocalizedText;
};

export type SettingSchema = SchemaNode & {
  /** As in VS Code's settings.json, e.g. `ging-git-view.dates.format`. */
  key: string;
  /** As VS Code's Settings editor titles it, e.g. `Dates: Format`. */
  title: string;
  description: LocalizedText;
  /** A markdown description may link to other settings; a plain one is shown
   *  as written. */
  descriptionFormat: "markdown" | "plain";
};

export type SettingsSchema = { settings: SettingSchema[] };

/** What every GING settings key starts with, as in VS Code's settings.json. */
export const SECTION = "ging-git-view.";

/** The extension's settings the desktop app leaves out, each for what it
 *  controls that the desktop app does not have. */
export const EXCLUDED_SETTINGS: Record<string, string> = {
  "ging-git-view.keepWebviewAlive": "keeps a hidden VS Code webview panel loaded",
  "ging-git-view.blame.enabled": "VS Code's inline blame at the end of the editor's cursor line",
  "ging-git-view.scmButtonPosition": "a menu item on the Source Control view's title",
  "ging-git-view.scmRepositoryButton": "a button on the Source Control Repositories view",
  "ging-git-view.followSourceControlSelection": "follows the Source Control view's selection",
  "ging-git-view.followActiveEditorRepo": "follows the repository of VS Code's active editor",
  "ging-git-view.statusBarButton": "an item on VS Code's status bar",
  "ging-git-view.diffEditorGroup": "the VS Code editor group a diff opens in",
  "ging-git-view.tabIconTheme": "the icon on the GING panel's VS Code editor tab",
  "ging-git-view.repoSearchDepth":
    "how deep the workspace search looks for repositories; the desktop app's known repositories are the ones the user opened (GLOSSARY.md)"
};

/** The `resource`-scoped settings the desktop app keeps, as global settings:
 *  it has no folders for a setting to differ by. Any other `resource` setting
 *  is refused until it is added here or to `EXCLUDED_SETTINGS`. */
export const RESOURCE_SETTINGS_AS_GLOBAL: readonly string[] = ["ging-git-view.defaultFileEncoding"];

/** The schema keywords read but not carried: `scope`, as the desktop app has
 *  only global settings, and `markdownDescription`, which becomes the
 *  setting's `description`. */
const SKIPPED = new Set(["scope", "markdownDescription"]);
/** The schema keywords carried over; any other one is refused, so a new kind
 *  of field in the manifest is decided about rather than dropped. */
const CARRIED = new Set([
  "type",
  "default",
  "enum",
  "enumDescriptions",
  "minimum",
  "maximum",
  "pattern",
  "items",
  "properties",
  "additionalProperties",
  "required",
  "description"
]);

/** One segment of a settings key in words: `fetchAvatars` is `Fetch Avatars`. */
const words = (segment: string) =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** A GING settings key as VS Code's Settings editor titles it: after the
 *  `ging-git-view.` section, the last segment is the name, the ones before it
 *  the category. */
export function settingTitle(key: string): string {
  const segments = key.slice(SECTION.length).split(".");
  const name = words(segments.at(-1)!);
  const category = segments.slice(0, -1).map(words).join(" › ");
  return category === "" ? name : `${category}: ${name}`;
}

/** The anchor a setting has in the desktop app's settings page (#397). */
const settingAnchor = (key: string) => `#${key}`;

function localize(value: unknown, nls: ManifestNls, where: string): LocalizedText {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  const match = /^%(.+)%$/.exec(value);
  if (match === null) return { en: value, "zh-cn": value, "zh-tw": value };
  const key = match[1];
  const en = nls.en[key];
  if (en === undefined) throw new Error(`${where}: "${key}" is not in package.nls.json`);
  return { en, "zh-cn": nls["zh-cn"][key] ?? en, "zh-tw": nls["zh-tw"][key] ?? en };
}

/** VS Code's link to another setting in a markdown description, `` `#key#` ``,
 *  as a link to that setting's anchor; a setting the desktop app does not
 *  have is named, not linked. */
function linkSettings(markdown: string, included: ReadonlySet<string>): string {
  return markdown.replace(/`#([^`#\s]+)#`/g, (_, key: string) =>
    included.has(key)
      ? `[\`${settingTitle(key)}\`](${settingAnchor(key)})`
      : `\`${settingTitle(key)}\``
  );
}

function node(raw: Record<string, unknown>, nls: ManifestNls, where: string): SchemaNode {
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(raw)) {
    if (SKIPPED.has(keyword)) continue;
    if (!CARRIED.has(keyword)) {
      throw new Error(`${where}: does not know how to carry the "${keyword}" keyword`);
    }
    switch (keyword) {
      case "description":
        out.description = localize(value, nls, `${where}.description`);
        break;
      case "enumDescriptions":
        out.enumDescriptions = (value as unknown[]).map((d, i) =>
          localize(d, nls, `${where}.enumDescriptions[${i}]`)
        );
        break;
      case "items":
        out.items = node(value as Record<string, unknown>, nls, `${where}.items`);
        break;
      case "properties":
        out.properties = Object.fromEntries(
          Object.entries(value as Record<string, Record<string, unknown>>).map(([name, child]) => [
            name,
            node(child, nls, `${where}.properties.${name}`)
          ])
        );
        break;
      case "additionalProperties":
        out.additionalProperties =
          typeof value === "boolean"
            ? value
            : node(value as Record<string, unknown>, nls, `${where}.additionalProperties`);
        break;
      default:
        out[keyword] = value;
    }
  }
  return out as SchemaNode;
}

/** The desktop app's settings, in the manifest's order. Throws on what it
 *  cannot carry faithfully: an unknown keyword, a missing English string, a
 *  `resource` setting nobody has decided about. */
export function deriveSettingsSchema(manifest: unknown, nls: ManifestNls): SettingsSchema {
  const properties = (
    manifest as { contributes: { configuration: { properties: Record<string, unknown> } } }
  ).contributes.configuration.properties;
  const kept = Object.entries(properties as Record<string, Record<string, unknown>>).filter(
    ([key]) => !Object.hasOwn(EXCLUDED_SETTINGS, key)
  );
  const included = new Set(kept.map(([key]) => key));
  return { settings: kept.map(([key, raw]) => setting(key, raw, nls, included)) };
}

/** One setting the desktop app keeps; `included` is every one it keeps. */
function setting(
  key: string,
  raw: Record<string, unknown>,
  nls: ManifestNls,
  included: ReadonlySet<string>
): SettingSchema {
  const scope = raw.scope;
  if (scope !== undefined && scope !== "window" && scope !== "application") {
    if (!RESOURCE_SETTINGS_AS_GLOBAL.includes(key)) {
      throw new Error(
        `${key}: a ${String(scope)}-scoped setting; add it to RESOURCE_SETTINGS_AS_GLOBAL or EXCLUDED_SETTINGS`
      );
    }
  }
  const markdown = raw.markdownDescription !== undefined;
  const text = localize(
    markdown ? raw.markdownDescription : raw.description,
    nls,
    `${key}.${markdown ? "markdownDescription" : "description"}`
  );
  const description = markdown
    ? (Object.fromEntries(
        LOCALES.map((locale) => [locale, linkSettings(text[locale], included)])
      ) as LocalizedText)
    : text;
  return Object.assign({ key, title: settingTitle(key) }, node(raw, nls, key), {
    description,
    descriptionFormat: markdown ? ("markdown" as const) : ("plain" as const)
  });
}
