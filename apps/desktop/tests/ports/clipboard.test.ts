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
