import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SequenceEditorManager } from "@ging/core/extension/sequenceEditor/sequenceEditorManager";

// The host half of GIT_SEQUENCE_EDITOR: where the helper is, and the staged
// todo it consumes. The helper itself is driven end to end against git in
// rebaseInteractive.test.ts; this is the contract the extension hands it.

let manager: SequenceEditorManager | undefined;
afterEach(() => manager?.dispose());

describe("SequenceEditorManager", () => {
  it("points git at the helper in the folder it was given", () => {
    const helperDir = path.join(os.tmpdir(), "ging-helpers");
    manager = new SequenceEditorManager(helperDir);
    const env = manager.getEnv();
    expect(env.GING_SEQUENCE_EDITOR_MAIN).toBe(path.join(helperDir, "sequenceEditorMain.js"));
    expect(env.GIT_SEQUENCE_EDITOR).toMatch(/sequenceEditor\.sh/);
  });

  it("reports a staged todo as applied only once the helper has consumed it", () => {
    manager = new SequenceEditorManager(os.tmpdir());
    const todoPath = manager.getEnv().GING_REBASE_TODO!;
    manager.stage("pick abc\n");
    expect(fs.readFileSync(todoPath, "utf8")).toBe("pick abc\n");
    expect(manager.wasApplied()).toBe(false);
    // What the helper does with it.
    fs.unlinkSync(todoPath);
    expect(manager.wasApplied()).toBe(true);
  });

  it("discards a todo that was never used", () => {
    manager = new SequenceEditorManager(os.tmpdir());
    manager.stage("pick abc\n");
    manager.discard();
    expect(fs.existsSync(manager.getEnv().GING_REBASE_TODO!)).toBe(false);
  });
});
