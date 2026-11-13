import { describe, expect, it } from "vitest";

import type { Clipboard } from "@ging/core/host/ports";

/** What the `Clipboard` contract needs from an implementation under test. */
export type ClipboardSubject = {
  clipboard: Clipboard;
  /** What the clipboard holds now, read past the port. */
  held(): string | undefined;
  /** From now on the clipboard cannot be written, as when the system refuses. */
  breakClipboard(): void;
};

/** The `Clipboard` contract (`@ging/core/host/ports`); see storage.ts for how
 *  the contract suites are run. */
export function describeClipboardContract(name: string, make: () => ClipboardSubject): void {
  describe(`${name} honours the Clipboard contract`, () => {
    it("holds the text once the write has resolved", async () => {
      const subject = make();
      await subject.clipboard.writeText("0123456789abcdef");
      expect(subject.held()).toBe("0123456789abcdef");
    });

    it("rejects when the clipboard cannot be written", async () => {
      const subject = make();
      subject.breakClipboard();
      await expect(subject.clipboard.writeText("lost")).rejects.toBeDefined();
      expect(subject.held()).not.toBe("lost");
    });
  });
}
