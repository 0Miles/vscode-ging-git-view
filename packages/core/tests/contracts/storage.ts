import { describe, expect, it } from "vitest";

import type { HostStorage } from "@ging/core/host/ports";

/** What the `HostStorage` contract needs from an implementation under test. */
export type StorageSubject = {
  /** A `HostStorage` over one backing store. Each call is another session
   *  opening the same store: it reads what earlier ones wrote. */
  open(): HostStorage;
};

/**
 * The `HostStorage` contract (`@ging/core/host/ports`), run against every
 * implementation: `fakeHost`'s and each host's. `make` builds a fresh, empty
 * store for each test; it cleans up after itself with `onTestFinished`.
 */
export function describeHostStorageContract(name: string, make: () => StorageSubject): void {
  describe(`${name} honours the HostStorage contract`, () => {
    it("answers the default for a key never written", () => {
      const storage = make().open();
      expect(storage.workspace.get("repoStates", {})).toEqual({});
      expect(storage.global.get("dialogMemory", null)).toBeNull();
    });

    it("lets a read right after a write see it, before the write is awaited", () => {
      const storage = make().open();
      void storage.workspace.update("lastActiveRepo", "/a");
      expect(storage.workspace.get("lastActiveRepo", null)).toBe("/a");
      void storage.workspace.update("lastActiveRepo", "/b");
      expect(storage.workspace.get("lastActiveRepo", null)).toBe("/b");
    });

    it("keeps the workspace and the global tier apart", () => {
      const storage = make().open();
      void storage.workspace.update("key", "workspace");
      void storage.global.update("key", "global");
      expect(storage.workspace.get("key", null)).toBe("workspace");
      expect(storage.global.get("key", null)).toBe("global");
    });

    it("keeps what was written for the next session, once the write has settled", async () => {
      const subject = make();
      const first = subject.open();
      const repos = { "/a": { columnWidths: [1, 2] }, "/b": { columnWidths: null } };
      await first.workspace.update("repoStates", repos);
      await first.global.update("avatarCache", { "a@example.com": { image: "a.png" } });

      const next = subject.open();
      expect(next.workspace.get("repoStates", {})).toEqual(repos);
      expect(next.global.get("avatarCache", {})).toEqual({ "a@example.com": { image: "a.png" } });
    });

    it("keeps the last of several writes to one key", async () => {
      const subject = make();
      const first = subject.open();
      void first.global.update("pruneTagsMigrationDone", false);
      await first.global.update("pruneTagsMigrationDone", true);
      expect(subject.open().global.get("pruneTagsMigrationDone", false)).toBe(true);
    });

    it("names a folder for the global tier's files", () => {
      expect(make().open().globalStoragePath).toMatch(/\S/);
    });
  });
}
