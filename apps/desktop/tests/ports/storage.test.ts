import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { openDesktopStorage } from "@ging/desktop/ports/storage";

import { describeHostStorageContract } from "@ging/core/tests/contracts/storage";
import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

/** A fresh userData folder, removed when the test finishes. */
function userData(): string {
  const dir = makeTempDir("ging-desktop-storage-");
  onTestFinished(() => rmrf(dir));
  return dir;
}

describeHostStorageContract("the desktop HostStorage", () => {
  const dir = userData();
  return { open: () => openDesktopStorage(dir) };
});

describe("the desktop HostStorage's file", () => {
  it("keeps both tiers in one file, apart by prefix", async () => {
    const dir = userData();
    const storage = openDesktopStorage(dir);
    await storage.workspace.update("repoStates", { "/a": { columnWidths: null } });
    await storage.global.update("dialogMemory", { merge: { noFastForward: "true" } });

    const file = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    expect(file).toEqual({
      "workspace:repoStates": { "/a": { columnWidths: null } },
      "global:dialogMemory": { merge: { noFastForward: "true" } }
    });
  });

  it("forgets a key written as undefined, as VS Code's Memento does", async () => {
    const dir = userData();
    const storage = openDesktopStorage(dir);
    await storage.global.update("lastSeen", 1);
    await storage.global.update("lastSeen", undefined);
    expect(storage.global.get("lastSeen", "none")).toBe("none");
    expect(openDesktopStorage(dir).global.get("lastSeen", "none")).toBe("none");
  });

  it("starts empty from a file it cannot read, says so, and writes over it", async () => {
    const dir = userData();
    fs.writeFileSync(path.join(dir, "state.json"), "{ not json");
    const errors: string[] = [];
    const storage = openDesktopStorage(dir, { onError: (message) => errors.push(message) });
    expect(storage.workspace.get("repoStates", {})).toEqual({});
    expect(errors).toEqual([expect.stringContaining("state.json")]);

    await storage.workspace.update("repoStates", { "/a": { columnWidths: null } });
    expect(openDesktopStorage(dir).workspace.get("repoStates", {})).toEqual({
      "/a": { columnWidths: null }
    });
  });

  it("settles a write it could not make, and says so", async () => {
    const dir = userData();
    // A directory where the file should be: every write to it fails.
    fs.mkdirSync(path.join(dir, "state.json"));
    const errors: string[] = [];
    const storage = openDesktopStorage(dir, { onError: (message) => errors.push(message) });
    await expect(storage.global.update("key", 1)).resolves.toBeUndefined();
    expect(storage.global.get("key", 0)).toBe(1);
    expect(errors).not.toEqual([]);
  });

  it("keeps the global tier's files in a folder of their own", () => {
    const dir = userData();
    expect(openDesktopStorage(dir).globalStoragePath).toBe(path.join(dir, "globalStorage"));
  });
});
