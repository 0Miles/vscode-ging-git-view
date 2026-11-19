/* The desktop app's settings file: userData/settings.json, keyed as VS Code's
 * settings.json is (`"ging-git-view.graph.edgeStyle": "angular"`), so a user's
 * GING entries can be copied over from VS Code. It is plain JSON, though, not
 * VS Code's JSONC: a comment or a trailing comma makes the file unreadable,
 * which answers the defaults and is reported. What it may hold is the schema
 * derived from the extension's (deriveSchema.ts). */

import * as fs from "node:fs";

import { isPlainObject, readJsonObject, writeWhole } from "@ging/desktop/jsonFile";

import type { SchemaNode, SettingSchema, SettingsSchema } from "./deriveSchema";

export type Settings = {
  /** The user's value for `key`, or its default where the user set none or
   *  set one the schema does not allow. The reads made in one task share one
   *  parse of the file; a read in a later task — the next request — parses it
   *  afresh, so a change made in between reaches it. Throws for a key that is
   *  not a setting: that is a typo in the app, not in the user's file. */
  get(key: string): unknown;
  /** Whether the user's file holds an entry for `key`, allowed or not: what
   *  `get` answers is then the user's, not only the default. Read as `get`
   *  reads. */
  has(key: string): boolean;
  /** Write `value` for `key` into the file, every other entry left as it was,
   *  through a temporary file renamed over it. Rejects, writing nothing, with
   *  a `SettingRefused` for a key that is not a setting or a value its schema
   *  does not allow — strictly: a number out of range or a list with one bad
   *  entry is refused, not clamped or filtered as a read does, since the user
   *  is there to be told — with a `SettingsFileNotAnObject` for a file that
   *  is not a JSON object, which is the user's, and writing over it would lose
   *  what they wrote; and with an ordinary error for one it cannot read or
   *  write. A read after it resolves sees the
   *  value. Writes go out one at a time, in the order asked. */
  update(key: string, value: unknown): Promise<void>;
  /** Call `listener` with the key of each write that lands, whoever asked
   *  for it, before that `update` resolves and after a read would see it; a
   *  refused or failed write calls nothing. A listener that throws is
   *  reported and does not fail the write. */
  onDidUpdate(listener: (key: string) => void): { dispose(): void };
};

/** Why `Settings.update` wrote nothing: the key or the value, not the file. */
export class SettingRefused extends Error {
  constructor(
    readonly key: string,
    readonly reason: "unknownKey" | "notAllowed"
  ) {
    super(
      reason === "unknownKey"
        ? `${key} is not a desktop setting`
        : `The value given for ${key} is not one its schema allows`
    );
    this.name = "SettingRefused";
  }
}

/** Why `Settings.update` wrote nothing: the file is there but is not a JSON
 *  object — not JSON, or JSON of another kind — and is the user's to fix.
 *  Any other failure is reading or writing it. */
export class SettingsFileNotAnObject extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsFileNotAnObject";
  }
}

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

/** Whether `value` is exactly what `node` allows, all the way down: what a
 *  write must be, where a read would make do (`allowed`). */
function conforms(node: SchemaNode, value: unknown, patterns: Patterns): boolean {
  if (node.enum !== undefined && !node.enum.includes(value)) return false;
  switch (node.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && patterns.get(node)?.test(value) !== false;
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (node.type === "number" || Number.isInteger(value)) &&
        value >= (node.minimum ?? -Infinity) &&
        value <= (node.maximum ?? Infinity)
      );
    case "array": {
      const items = node.items;
      return (
        Array.isArray(value) &&
        (items === undefined || value.every((entry) => conforms(items, entry, patterns)))
      );
    }
    case "object": {
      if (!isPlainObject(value)) return false;
      const properties = node.properties ?? {};
      if ((node.required ?? []).some((name) => !Object.hasOwn(value, name))) return false;
      return Object.entries(value).every(([name, entry]) => {
        if (Object.hasOwn(properties, name)) return conforms(properties[name], entry, patterns);
        const extra = node.additionalProperties;
        return extra === undefined || extra === true
          ? true
          : extra !== false && conforms(extra, entry, patterns);
      });
    }
  }
}

/** The object `file` holds, for a write to change one entry of: `{}` for no
 *  file, and a rejection for one that cannot be read or is not an object. */
async function readForWrite(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: ${String(e)}`, { cause: e });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SettingsFileNotAnObject(
      `Cannot parse ${file}, so it is left as it is: ${String(e)}`,
      {
        cause: e
      }
    );
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsFileNotAnObject(`${file} does not hold an object, so it is left as it is`);
  }
  return parsed;
}

export function openSettings(
  file: string,
  schema: SettingsSchema,
  { onError = () => {} }: { onError?: (message: string) => void } = {}
): Settings {
  const byKey = new Map<string, SettingSchema>(schema.settings.map((s) => [s.key, s]));
  const patterns = compilePatterns(schema);

  // A page build asks for some fifty settings in one go, so they share one
  // parse; the next request, a later task, parses the file afresh and so sees
  // any change made in between, however small or quick.
  let cached: Record<string, unknown> | null = null;
  // Each request finds a broken file anew; it is reported when it breaks, not
  // at every request while it stays broken.
  let lastProblem: string | null = null;
  const read = (): Record<string, unknown> => {
    if (cached === null) {
      let problem: string | null = null;
      cached = readJsonObject(file, {
        onError: (message) => {
          problem = message;
        },
        consequence: "using the default settings"
      });
      if (problem !== null && problem !== lastProblem) onError(problem);
      lastProblem = problem;
      // setImmediate, not a microtask: it outlasts the awaits inside one request.
      setImmediate(() => {
        cached = null;
      });
    }
    return cached;
  };

  // One write at a time, so two in quick succession do not both start from
  // the file as it was before either.
  let writing: Promise<void> = Promise.resolve();
  const listeners = new Set<(key: string) => void>();

  return {
    get(key) {
      const setting = byKey.get(key);
      if (setting === undefined) throw new Error(`${key} is not a desktop setting`);
      const values = read();
      if (!Object.hasOwn(values, key)) return setting.default;
      const value = allowed(setting, values[key], patterns);
      return value === NOT_ALLOWED ? setting.default : value;
    },
    has: (key) => Object.hasOwn(read(), key),
    update(key, value) {
      const setting = byKey.get(key);
      if (setting === undefined) return Promise.reject(new SettingRefused(key, "unknownKey"));
      if (!conforms(setting, value, patterns)) {
        return Promise.reject(new SettingRefused(key, "notAllowed"));
      }
      const write = writing.then(async () => {
        const values = await readForWrite(file);
        values[key] = value;
        await writeWhole(file, `${JSON.stringify(values, null, 2)}\n`);
        // Not left to the next task: whoever wrote it reads it back at once.
        cached = null;
        for (const listener of listeners) {
          try {
            listener(key);
          } catch (e) {
            onError(`Telling of ${key} written failed: ${String(e)}`);
          }
        }
      });
      writing = write.catch(() => {});
      return write;
    },
    onDidUpdate(listener) {
      // Its own entry, so one listener added twice is two listeners.
      const entry = (key: string) => listener(key);
      listeners.add(entry);
      return { dispose: () => listeners.delete(entry) };
    }
  };
}
