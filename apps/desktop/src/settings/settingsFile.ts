/* The desktop app's settings file: userData/settings.json, keyed as VS Code's
 * settings.json is (`"ging-git-view.graph.edgeStyle": "angular"`), so a user's
 * GING entries can be copied over from VS Code. It is plain JSON, though, not
 * VS Code's JSONC: a comment or a trailing comma makes the file unreadable,
 * which answers the defaults and is reported. What it may hold is the schema
 * derived from the extension's (deriveSchema.ts). */

import { isPlainObject, readJsonObject } from "@ging/desktop/jsonFile";

import type { SchemaNode, SettingSchema, SettingsSchema } from "./deriveSchema";

export type Settings = {
  /** The user's value for `key`, or its default where the user set none or
   *  set one the schema does not allow. Read from the file at every call, so
   *  a change to the file reaches the next read. Throws for a key that is not
   *  a setting: that is a typo in the app, not in the user's file. */
  get(key: string): unknown;
};

const NOT_ALLOWED = Symbol("not allowed");

/** `value` as the schema allows it, or `NOT_ALLOWED`. A list keeps only the
 *  entries whose type and pattern fit its items, as a list of names or colours
 *  is still worth having without the one bad entry. */
function allowed(node: SchemaNode, value: unknown): unknown {
  switch (node.type) {
    case "boolean":
      if (typeof value !== "boolean") return NOT_ALLOWED;
      break;
    case "string":
      if (typeof value !== "string") return NOT_ALLOWED;
      if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) return NOT_ALLOWED;
      break;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return NOT_ALLOWED;
      if (node.type === "integer" && !Number.isInteger(value)) return NOT_ALLOWED;
      // Clamped rather than refused: 120 for an hourly-at-most interval means
      // as long as allowed, not the default. (`HostConfig.autoFetchIntervalMinutes`
      // leaves the clamping to its timer, which this agrees with.)
      const clamped = Math.min(
        node.maximum ?? Infinity,
        Math.max(node.minimum ?? -Infinity, value)
      );
      return node.enum === undefined || node.enum.includes(clamped) ? clamped : NOT_ALLOWED;
    }
    case "array": {
      if (!Array.isArray(value)) return NOT_ALLOWED;
      const items = node.items;
      if (items === undefined || items.type === "object" || items.type === "array") return value;
      return value.filter((entry) => allowed(items, entry) !== NOT_ALLOWED);
    }
    case "object":
      if (!isPlainObject(value)) return NOT_ALLOWED;
      break;
  }
  if (node.enum !== undefined && !node.enum.includes(value)) return NOT_ALLOWED;
  return value;
}

export function openSettings(
  file: string,
  schema: SettingsSchema,
  { onError = () => {} }: { onError?: (message: string) => void } = {}
): Settings {
  const byKey = new Map<string, SettingSchema>(schema.settings.map((s) => [s.key, s]));
  // The file is read at every call, so a broken one would be reported at
  // every call; once per distinct problem is enough.
  let lastProblem: string | null = null;
  const report = (problem: string) => {
    if (problem !== lastProblem) onError(problem);
    lastProblem = problem;
  };

  const read = (): Record<string, unknown> => {
    let reported = false;
    const values = readJsonObject(file, {
      onError: (problem) => {
        reported = true;
        report(problem);
      },
      consequence: "using the default settings"
    });
    if (!reported) lastProblem = null;
    return values;
  };

  return {
    get(key) {
      const setting = byKey.get(key);
      if (setting === undefined) throw new Error(`${key} is not a desktop setting`);
      const values = read();
      if (!Object.prototype.hasOwnProperty.call(values, key)) return setting.default;
      const value = allowed(setting, values[key]);
      return value === NOT_ALLOWED ? setting.default : value;
    }
  };
}
