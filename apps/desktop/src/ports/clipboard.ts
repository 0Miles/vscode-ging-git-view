/* The desktop `Clipboard` (`@ging/core/host/ports`), over Electron's. */

import type { Clipboard as ElectronClipboard } from "electron";

import type { Clipboard } from "@ging/core/host/ports";

/** Electron's `clipboard`, as far as the port uses it. */
export type SystemClipboard = Pick<ElectronClipboard, "writeText">;

/** Since Electron 45 the clipboard is asynchronous, modelled on the W3C one:
 *  `writeText` resolves once the text is on the clipboard and rejects when it
 *  cannot be put there, which is the port's promise as it stands. Measured on
 *  Electron 45.3.1: a text with both LF and CRLF line ends reads back as
 *  written. */
export function createDesktopClipboard(system: SystemClipboard): Clipboard {
  return { writeText: (text) => system.writeText(text) };
}
