import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createDesktopLogger } from "@ging/desktop/ports/logger";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

function subject(file?: string) {
  const dir = makeTempDir("ging-desktop-log-");
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const logFile = file ?? path.join(dir, "logs", "main.log");
  const logger = createDesktopLogger({
    file: logFile,
    open: (f) => {
      opened.push(f);
    },
    console: { out: (line) => out.push(line), err: (line) => err.push(line) },
    now: () => new Date(2026, 10, 13, 9, 5, 7, 42)
  });
  onTestFinished(async () => {
    await logger.close();
    rmrf(dir);
  });
  return { logger, logFile, out, err, opened };
}

describe("the desktop HostLogger", () => {
  it("writes each line, stamped with the local time, to the console and the log file", async () => {
    const s = subject();
    s.logger.log("launch: repository /a");
    s.logger.logError("cannot watch /a");
    await s.logger.close();

    expect(s.out).toEqual(["[2026-11-13 09:05:07.042] launch: repository /a"]);
    expect(s.err).toEqual(["[2026-11-13 09:05:07.042] ERROR: cannot watch /a"]);
    expect(fs.readFileSync(s.logFile, "utf8")).toBe(
      "[2026-11-13 09:05:07.042] launch: repository /a\n" +
        "[2026-11-13 09:05:07.042] ERROR: cannot watch /a\n"
    );
  });

  it("adds to the log a previous session left", async () => {
    const first = subject();
    first.logger.log("one");
    await first.logger.close();
    const next = subject(first.logFile);
    next.logger.log("two");
    await next.logger.close();
    expect(fs.readFileSync(first.logFile, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("brings the log into view by opening its file", () => {
    const s = subject();
    s.logger.reveal();
    expect(s.opened).toEqual([s.logFile]);
  });

  it("keeps logging to the console when the log file cannot be written", async () => {
    const dir = makeTempDir("ging-desktop-log-");
    onTestFinished(() => rmrf(dir));
    // A directory where the file should be.
    const file = path.join(dir, "main.log");
    fs.mkdirSync(file);
    const s = subject(file);
    s.logger.log("still here");
    await s.logger.close();
    expect(s.out).toContain("[2026-11-13 09:05:07.042] still here");
    expect(s.err).toEqual([expect.stringContaining(file)]);
  });
});
