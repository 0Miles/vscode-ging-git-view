/* The desktop `HostLogger` (`@ging/core/host/ports`): the GING log, which VS
 * Code keeps in an Output Channel. Each line goes to the process's own stdout
 * or stderr, where a developer running the app and the Electron E2E read it,
 * and to a log file in the user data folder, which `reveal` opens. */

import * as fs from "node:fs";
import * as path from "node:path";

import type { HostLogger } from "@ging/core/host/ports";

export type DesktopLoggerOptions = {
  /** The log file; later sessions add to it. */
  file: string;
  /** Show a file to the user: Electron's `shell.openPath`. */
  open: (file: string) => unknown;
  /** Where a line goes besides the file; the process's stdout and stderr. */
  console?: { out(line: string): void; err(line: string): void };
  now?: () => Date;
};

export type DesktopLogger = HostLogger & {
  /** Finish writing what was logged and let go of the file. */
  close(): Promise<void>;
};

const processConsole = {
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) => process.stderr.write(`${line}\n`)
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The local time as the VS Code host's logger stamps its lines. */
function stamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    pad(d.getMilliseconds(), 3)
  );
}

export function createDesktopLogger({
  file,
  open,
  console = processConsole,
  now = () => new Date()
}: DesktopLoggerOptions): DesktopLogger {
  let stream: fs.WriteStream | null = null;
  // Without the file the console still has every line.
  const fileFailed = (e: unknown) =>
    console.err(`[${stamp(now())}] ERROR: cannot write the log file ${file}: ${String(e)}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", (e) => {
      fileFailed(e);
      stream?.destroy();
      stream = null;
    });
  } catch (e) {
    fileFailed(e);
  }

  const write = (line: string, toConsole: (line: string) => void) => {
    const stamped = `[${stamp(now())}] ${line}`;
    toConsole(stamped);
    stream?.write(`${stamped}\n`);
  };

  return {
    log: (message) => write(message, console.out),
    logError: (message) => write(`ERROR: ${message}`, console.err),
    reveal: () => void open(file),
    close: () =>
      new Promise((resolve) => {
        if (stream === null || stream.destroyed) {
          resolve();
          return;
        }
        // An error while flushing reports itself through the handler above.
        stream.once("close", () => resolve());
        stream.end();
      })
  };
}
