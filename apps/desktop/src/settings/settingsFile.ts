/* The desktop app's settings file: userData/settings.json, keyed as VS Code's
 * settings.json is (`"ging-git-view.graph.edgeStyle": "angular"`), so a user's
 * VS Code settings can be copied over as they are. What it may hold is the
 * schema derived from the extension's (deriveSchema.ts). */

import * as fs from "node:fs";

import type { SchemaNode, SettingSchema, SettingsSchema } from "./deriveSchema";

export type Settings = {
  /** The user's value for `key`, or its default where the user set none or
   *  set one the schema does not allow. Read from the file at every call, so
   *  a change to the file reaches the next read. Throws for a key that is not
   *  a setting: that is a typo in the app, not in the user's file. */
  get(key: string): unknown;
};

const NOT_ALLOWED = Symbol("not allowed");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return NOT_ALLOWED;
      if (node.type === "integer" && !Number.isInteger(value)) return NOT_ALLOWED;
      if (node.minimum !== undefined && value < node.minimum) return NOT_ALLOWED;
      if (node.maximum !== undefined && value > node.maximum) return NOT_ALLOWED;
      break;
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
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        report(`Cannot read ${file}, using the default settings: ${String(e)}`);
      }
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (isPlainObject(parsed)) {
        lastProblem = null;
        return parsed;
      }
      report(`${file} does not hold an object, using the default settings`);
    } catch (e) {
      report(`Cannot parse ${file}, using the default settings: ${String(e)}`);
    }
    return {};
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
