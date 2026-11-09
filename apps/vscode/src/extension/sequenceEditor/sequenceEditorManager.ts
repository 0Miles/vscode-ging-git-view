import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { getNonce } from "@/backend/utils/nonce";
import { shellCommandPath } from "@/backend/utils/shellPath";

/**
 * Lets the extension hand `git rebase -i` a todo of its own making.
 *
 * The environment is fixed for the whole session — simple-git sets a client's
 * environment once, not per command — so which rebase gets a prepared todo is
 * decided by a file, not by a variable. `stage` writes it, the helper consumes
 * and deletes it, and `wasApplied` reports whether that happened. A rebase
 * whose todo never reached git would otherwise keep every commit and look like
 * a success, which is the one outcome a "drop these commits" dialog must never
 * quietly produce.
 */
export interface SequenceEditorEnvironment {
  [key: string]: string | undefined;
  GIT_SEQUENCE_EDITOR: string;
  ELECTRON_RUN_AS_NODE?: string;
  GING_SEQUENCE_EDITOR_NODE?: string;
  GING_SEQUENCE_EDITOR_MAIN?: string;
  GING_REBASE_TODO?: string;
}

export class SequenceEditorManager implements vscode.Disposable {
  private readonly todoPath: string;

  constructor() {
    this.todoPath = path.join(os.tmpdir(), `ging-rebase-todo-${getNonce()}`);
    fs.chmod(path.join(__dirname, "sequenceEditor.sh"), "755", () => {});
  }

  public dispose() {
    this.discard();
  }

  public getEnv(): SequenceEditorEnvironment {
    return {
      ELECTRON_RUN_AS_NODE: "1",
      // A command string for the shell, not a path git will exec — see
      // shellCommandPath.
      GIT_SEQUENCE_EDITOR: shellCommandPath(path.join(__dirname, "sequenceEditor.sh")),
      GING_SEQUENCE_EDITOR_NODE: process.execPath,
      GING_SEQUENCE_EDITOR_MAIN: path.join(__dirname, "sequenceEditorMain.js"),
      GING_REBASE_TODO: this.todoPath
    };
  }

  /** Stage the todo the next interactive rebase should run with. */
  public stage(todo: string): void {
    fs.writeFileSync(this.todoPath, todo, "utf8");
  }

  /** Whether the staged todo reached git — the helper deletes it on use. */
  public wasApplied(): boolean {
    return !fs.existsSync(this.todoPath);
  }

  /** Drop a staged todo that was never used, so it cannot leak into the next
   *  interactive rebase the user starts from anywhere. */
  public discard(): void {
    try {
      fs.unlinkSync(this.todoPath);
    } catch {
      // Already consumed or never written — either way there is nothing staged.
    }
  }
}
