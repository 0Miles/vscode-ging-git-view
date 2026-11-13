import { describe, expect, it } from "vitest";

import { createDesktopClipboard, type SystemClipboard } from "@ging/desktop/ports/clipboard";

import { describeClipboardContract } from "@ging/core/tests/contracts/clipboard";

/** Electron's clipboard as far as the port uses it, over a plain string, as
 *  its asynchronous API behaves: a write that cannot be made rejects. Electron
 *  itself is only there under the Electron E2E (ADR-0032). */
function systemClipboard() {
  const system = { text: "", broken: false };
  const clipboard: SystemClipboard = {
    writeText: async (text) => {
      if (system.broken) throw new Error("clipboard unavailable");
      system.text = text;
    }
  };
  return { system, clipboard };
}

describeClipboardContract("the desktop Clipboard", () => {
  const { system, clipboard } = systemClipboard();
  return {
    clipboard: createDesktopClipboard(clipboard),
    held: () => system.text,
    breakClipboard: () => {
      system.broken = true;
    }
  };
});

describe("the desktop Clipboard", () => {
  // Not the port's promise but this host's: Electron 45.3.1 was measured to
  // read back LF and CRLF line ends as written, so nothing here rewrites them.
  it("hands a multi-line text to Electron as written", async () => {
    const { system, clipboard } = systemClipboard();
    await createDesktopClipboard(clipboard).writeText("Subject\r\n\nBody line\n");
    expect(system.text).toBe("Subject\r\n\nBody line\n");
  });
});
