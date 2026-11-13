/* The desktop `HostStorage` (`@ging/core/host/ports`): both tiers in one JSON
 * file in the user data folder, told apart by a prefix on each key. The
 * desktop app has one workspace, itself, so the workspace tier is as long-lived
 * as the global one; they stay two tiers because core decides what goes where
 * (ExtensionState), and #393's tabs may yet give the workspace tier a narrower
 * meaning. */

import * as fs from "node:fs";
import * as path from "node:path";

import type { HostStorage, StateStore } from "@ging/core/host/ports";
import { readJsonObject } from "@ging/desktop/jsonFile";

const STATE_FILE = "state.json";
const GLOBAL_STORAGE_FOLDER = "globalStorage";
const PREFIX = { workspace: "workspace:", global: "global:" } as const;

export type DesktopStorageOptions = {
  /** Told when the file cannot be read or written. Nobody awaits a write
   *  (see `StateStore`), so a failed one settles anyway and is reported here
   *  rather than rejected into the void. */
  onError?: (message: string) => void;
};

/** Write `text` to `file` whole or not at all: a crash mid-write leaves the
 *  previous file, not half of the new one. */
async function writeWhole(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(temp, text, "utf8");
  await fs.promises.rename(temp, file);
}

/** The state kept in `userDataPath`, as it is on disk now. One process opens
 *  it at a time: the app holds the single-instance lock. */
export function openDesktopStorage(
  userDataPath: string,
  { onError = () => {} }: DesktopStorageOptions = {}
): HostStorage {
  const file = path.join(userDataPath, STATE_FILE);
  const state = readJsonObject(file, { onError, consequence: "starting from empty state" });

  // Writes go out one at a time, each with everything written before it
  // started; an update made while a write is queued rides along with it.
  let queued: Promise<void> | null = null;
  let last: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    if (queued !== null) return queued;
    const next = last.then(async () => {
      queued = null;
      try {
        await writeWhole(file, JSON.stringify(state, null, 2));
      } catch (e) {
        onError(`Cannot write ${file}: ${String(e)}`);
      }
    });
    queued = next;
    last = next;
    return next;
  };

  const tier = (prefix: string): StateStore => ({
    get: <T>(key: string, defaultValue: T): T =>
      Object.hasOwn(state, prefix + key) ? (state[prefix + key] as T) : defaultValue,
    update: (key, value) => {
      // Held as it will be read back from the file, so this session and the
      // next see the same value.
      if (value === undefined) delete state[prefix + key];
      else state[prefix + key] = JSON.parse(JSON.stringify(value));
      return persist();
    }
  });

  return {
    workspace: tier(PREFIX.workspace),
    global: tier(PREFIX.global),
    globalStoragePath: path.join(userDataPath, GLOBAL_STORAGE_FOLDER)
  };
}
