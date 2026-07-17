/*---------------------------------------------------------------------------------------------
 *  Based on the askpass implementation in the Microsoft Visual Studio Code Git Extension
 *  (https://github.com/microsoft/vscode/blob/main/extensions/git/src/askpass.ts), MIT licensed.
 *  Prompts the user for remote credentials when git asks for them.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { getNonce } from "@/backend/utils/nonce";

export interface AskpassEnvironment {
  // Index signature so this is a valid env dict (assignable to NodeJS.ProcessEnv
  // when handed to the git client as extra child-process variables).
  [key: string]: string | undefined;
  GIT_ASKPASS: string;
  ELECTRON_RUN_AS_NODE?: string;
  NEO_GIT_GRAPH_ASKPASS_NODE?: string;
  NEO_GIT_GRAPH_ASKPASS_MAIN?: string;
  NEO_GIT_GRAPH_ASKPASS_HANDLE?: string;
}

interface AskpassRequest {
  host: string;
  request: string;
}

/** Runs a small IPC server that git's GIT_ASKPASS helper connects to; each
 *  request is surfaced as a VS Code input box and the entered value is returned
 *  to git. When the server can't start, getEnv falls back to a no-op
 *  helper so git's own prompting is left untouched. */
export class AskpassManager implements vscode.Disposable {
  private readonly ipcHandlePath: string;
  private readonly server: http.Server;
  private enabled = true;

  constructor() {
    this.ipcHandlePath = getIPCHandlePath(getNonce());
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    try {
      this.server.listen(this.ipcHandlePath);
      this.server.on("error", () => {});
    } catch {
      this.enabled = false;
    }
    fs.chmod(path.join(__dirname, "askpass.sh"), "755", () => {});
    fs.chmod(path.join(__dirname, "askpass-empty.sh"), "755", () => {});
  }

  public dispose() {
    try {
      this.server.close();
      if (process.platform !== "win32") fs.unlinkSync(this.ipcHandlePath);
    } catch {
      // Server already closed or socket file already gone — nothing to do.
    }
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let reqData = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (reqData += d));
    req.on("end", () => {
      const data = JSON.parse(reqData) as AskpassRequest;
      vscode.window
        .showInputBox({
          placeHolder: data.request,
          prompt: "GING: " + data.host,
          password: /password/i.test(data.request),
          ignoreFocusOut: true
        })
        .then(
          (result) => {
            res.writeHead(200);
            res.end(JSON.stringify(result || ""));
          },
          () => {
            res.writeHead(500);
            res.end();
          }
        );
    });
  }

  public getEnv(): AskpassEnvironment {
    return this.enabled
      ? {
          ELECTRON_RUN_AS_NODE: "1",
          GIT_ASKPASS: path.join(__dirname, "askpass.sh"),
          NEO_GIT_GRAPH_ASKPASS_NODE: process.execPath,
          NEO_GIT_GRAPH_ASKPASS_MAIN: path.join(__dirname, "askpassMain.js"),
          NEO_GIT_GRAPH_ASKPASS_HANDLE: this.ipcHandlePath
        }
      : {
          GIT_ASKPASS: path.join(__dirname, "askpass-empty.sh")
        };
  }
}

function getIPCHandlePath(nonce: string): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\ging-git-view-askpass-" + nonce + "-sock";
  } else if (process.env["XDG_RUNTIME_DIR"]) {
    return path.join(process.env["XDG_RUNTIME_DIR"], "ging-git-view-askpass-" + nonce + ".sock");
  } else {
    return path.join(os.tmpdir(), "ging-git-view-askpass-" + nonce + ".sock");
  }
}
