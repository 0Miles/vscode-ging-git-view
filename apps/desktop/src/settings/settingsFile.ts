/* The desktop app's settings file: userData/settings.json, keyed as VS Code's
 * settings.json is (`"ging-git-view.graph.edgeStyle": "angular"`), so a user's
 * GING entries can be copied over from VS Code. It is plain JSON, though, not
 * VS Code's JSONC: a comment or a trailing comma makes the file unreadable,
 * which answers the defaults and is reported. What it may hold is the schema
 * derived from the extension's (deriveSchema.ts). */

import * as fs from "node:fs";

import { isPlainObject, readJsonObject } from "@ging/desktop/jsonFile";

import type { SchemaNode, SettingSchema, SettingsSchema } from "./deriveSchema";

export type Settings = {
  /** The user's value for `key`, or its default where the user set none or
   *  set one the schema does not allow. The file is looked at on every call,
   *  so a change to it reaches the next read; it is parsed again only when it
   *  has changed. Throws for a key that is not a setting: that is a typo in
   *  the app, not in the user's file. */
  get(key: string): unknown;
};

const NOT_ALLOWED = Symbol("not allowed");

/** Each schema node's `pattern`, compiled once. */
type Patterns = ReadonlyMap<SchemaNode, RegExp>;

function compilePatterns(schema: SettingsSchema): Patterns {
  const patterns = new Map<SchemaNode, RegExp>();
  const visit = (node: SchemaNode) => {
    if (node.pattern !== undefined) patterns.set(node, new RegExp(node.pattern));
    if (node.items !== undefined) visit(node.items);
    Object.values(node.properties ?? {}).forEach(visit);
    if (typeof node.additionalProperties === "object") visit(node.additionalProperties);
  };
  schema.settings.forEach(visit);
  return patterns;
}

/** `value` as the schema allows it, or `NOT_ALLOWED`. A list keeps only the
 *  entries whose type and pattern fit its items, as a list of names or colours
 *  is still worth having without the one bad entry. */
function allowed(node: SchemaNode, given: unknown, patterns: Patterns): unknown {
  let value = given;
  switch (node.type) {
    case "boolean":
      if (typeof value !== "boolean") return NOT_ALLOWED;
      break;
    case "string":
      if (typeof value !== "string") return NOT_ALLOWED;
      if (patterns.get(node)?.test(value) === false) return NOT_ALLOWED;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return NOT_ALLOWED;
      if (node.type === "integer" && !Number.isInteger(value)) return NOT_ALLOWED;
      // Clamped rather than refused: 120 for an hourly-at-most interval means
      // as long as allowed, not the default. (`HostConfig.autoFetchIntervalMinutes`
      // leaves the clamping to its timer, which this agrees with.)
      value = Math.min(node.maximum ?? Infinity, Math.max(node.minimum ?? -Infinity, value));
      break;
    case "array": {
      if (!Array.isArray(value)) return NOT_ALLOWED;
      const items = node.items;
      if (items === undefined || items.type === "object" || items.type === "array") return value;
      return value.filter((entry) => allowed(items, entry, patterns) !== NOT_ALLOWED);
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
  const patterns = compilePatterns(schema);

  // A page build asks for some fifty settings, so the file is parsed once per
  // change to it (its modification time and size, or why it cannot be
  // looked at), not once per setting. A broken file is reported once per
  // change for the same reason.
  let cached: { stamp: string; values: Record<string, unknown> } | null = null;
  const read = (): Record<string, unknown> => {
    let stamp: string;
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (e) {
      stamp = `unreadable:${String((e as NodeJS.ErrnoException).code)}`;
    }
    if (cached?.stamp !== stamp) {
      cached = {
        stamp,
        values: readJsonObject(file, { onError, consequence: "using the default settings" })
      };
    }
    return cached.values;
  };

  return {
    get(key) {
      const setting = byKey.get(key);
      if (setting === undefined) throw new Error(`${key} is not a desktop setting`);
      const values = read();
      if (!Object.prototype.hasOwnProperty.call(values, key)) return setting.default;
      const value = allowed(setting, values[key], patterns);
      return value === NOT_ALLOWED ? setting.default : value;
    }
  };
}
