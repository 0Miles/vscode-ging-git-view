import { describe, expect, it } from "vitest";

import type { Watcher } from "@ging/core/host/ports";

/** What the `Watcher` contract needs from an implementation under test. */
export type WatcherSubject = {
  watcher: Watcher;
  /** A repository the watcher can be started on, one per `name`. */
  repo(name: string): string;
  /** Change a working-tree file of `repo`, the way something outside GING
   *  would. */
  change(repo: string): void | Promise<void>;
  /** Wait until every change made so far has either refreshed the graph or
   *  been ignored for good. */
  settle(): Promise<void>;
  /** How many graph refreshes the watcher has caused. */
  refreshes(): number;
};

/** The `Watcher` contract (`@ging/core/host/ports`, ADR-0013); see storage.ts
 *  for how the contract suites are run. */
export function describeWatcherContract(name: string, make: () => WatcherSubject): void {
  describe(`${name} honours the Watcher contract`, () => {
    it("turns a change to the watched repository into a refresh", async () => {
      const subject = make();
      const repo = subject.repo("a");
      subject.watcher.start(repo);
      await subject.change(repo);
      await subject.settle();
      expect(subject.refreshes()).toBeGreaterThan(0);
    });

    it("refreshes nothing for a repository it was not started on", async () => {
      const subject = make();
      const [a, b] = [subject.repo("a"), subject.repo("b")];
      subject.watcher.start(a);
      await subject.change(b);
      await subject.settle();
      expect(subject.refreshes()).toBe(0);
    });

    it("watches only the repository it was last started on", async () => {
      const subject = make();
      const [a, b] = [subject.repo("a"), subject.repo("b")];
      subject.watcher.start(a);
      subject.watcher.start(b);
      await subject.change(a);
      await subject.settle();
      expect(subject.refreshes()).toBe(0);

      await subject.change(b);
      await subject.settle();
      expect(subject.refreshes()).toBeGreaterThan(0);
    });

    it("never refreshes for a change made while muted, even once unmuted", async () => {
      const subject = make();
      const repo = subject.repo("a");
      subject.watcher.start(repo);
      subject.watcher.mute();
      await subject.change(repo);
      subject.watcher.unmute();
      await subject.settle();
      expect(subject.refreshes()).toBe(0);
    });

    it("refreshes again for changes made after it was unmuted", async () => {
      const subject = make();
      const repo = subject.repo("a");
      subject.watcher.start(repo);
      subject.watcher.mute();
      subject.watcher.unmute();
      await subject.settle();
      await subject.change(repo);
      await subject.settle();
      expect(subject.refreshes()).toBeGreaterThan(0);
    });
  });
}
