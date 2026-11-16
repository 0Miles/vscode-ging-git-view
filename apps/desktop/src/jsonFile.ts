/* The desktop app's own JSON files in the user data folder (state.json,
 * settings.json): each holds one object, and a file that is missing, broken
 * or something else reads as an empty one. */

import * as fs from "node:fs";
import * as path from "node:path";

/** Write `text` to `file` whole or not at all: a crash mid-write leaves the
 *  previous file, not half of the new one. */
export async function writeWhole(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(temp, text, "utf8");
  await fs.promises.rename(temp, file);
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object `file` holds, or `{}`. A missing file is simply empty; one that
 *  cannot be read, cannot be parsed or holds something other than an object
 *  is reported to `onError`, worded with what the caller does instead
 *  (`consequence`, e.g. "starting from empty state"). */
export function readJsonObject(
  file: string,
  { onError, consequence }: { onError: (message: string) => void; consequence: string }
): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(`Cannot read ${file}, ${consequence}: ${String(e)}`);
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) return parsed;
    onError(`${file} does not hold an object, ${consequence}`);
  } catch (e) {
    onError(`Cannot parse ${file}, ${consequence}: ${String(e)}`);
  }
  return {};
}
