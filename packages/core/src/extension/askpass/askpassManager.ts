/*---------------------------------------------------------------------------------------------
 *  Based on the askpass implementation in the Microsoft Visual Studio Code Git Extension
 *  (https://github.com/microsoft/vscode/blob/main/extensions/git/src/askpass.ts), MIT licensed.
 *  Prompts the user for remote credentials when git asks for them.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { getNonce } from "@ging/core/backend/utils/nonce";
import type { Prompts } from "@ging/core/host/ports";

export interface AskpassEnvironment {
  // Index signature so this is a valid env dict (assignable to NodeJS.ProcessEnv
  // when handed to the git client as extra child-process variables).
  [key: string]: string | undefined;
  GIT_ASKPASS: string;
  ELECTRON_RUN_AS_NODE?: string;
  NEO_GIT_GRAPH_ASKPASS_NODE?: string;
  NEO_GIT_GRAPH_ASKPASS_MAIN?: string;
  NEO_GIT_GRAPH_ASKPASS_HANDLE?: string;
  /** Which route the prompt goes to; absent for the default one. */
  NEO_GIT_GRAPH_ASKPASS_TOKEN?: string;
}

interface AskpassRequest {
  host: string;
  request: string;
  /** The `NEO_GIT_GRAPH_ASKPASS_TOKEN` git was run with, if any. */
  token?: string;
}

/** A way for git's prompts to reach one asker: run git with `env`, and what it
 *  asks goes to the prompts the route was made for. */
export interface AskpassRoute {
  env: AskpassEnvironment;
  /** Stop asking: a prompt still carrying this route's token is answered as
   *  cancelled. */
  dispose(): void;
}

/** Runs a small IPC server that git's GIT_ASKPASS helper connects to; each
 *  request is put to the user through `Prompts.input` and the entered value is
 *  returned to git. When the server can't start, getEnv falls back to a no-op
 *  helper so git's own prompting is left untouched.
 *
 *  One server serves a whole host process. Git run with `getEnv()` asks the
 *  prompts the manager was built with; a host that asks in more than one place
 *  — the desktop host, one webview instance each — gives each its own `route`,
 *  whose env carries a token the helper sends back. */
export class AskpassManager {
  private readonly ipcHandlePath: string;
  private readonly server: http.Server;
  private enabled = true;
  private readonly routes = new Map<string, Pick<Prompts, "input">>();

  constructor(
    private readonly prompts: Pick<Prompts, "input">,
    /** The folder the helper scripts and `askpassMain.js` are shipped in. */
    private readonly helperDir: string
  ) {
    this.ipcHandlePath = getIPCHandlePath(getNonce());
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    try {
      this.server.listen(this.ipcHandlePath);
      this.server.on("error", () => {});
    } catch {
      this.enabled = false;
    }
    fs.chmod(path.join(this.helperDir, "askpass.sh"), "755", () => {});
    fs.chmod(path.join(this.helperDir, "askpass-empty.sh"), "755", () => {});
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
      const prompts =
        data.token === undefined ? this.prompts : this.routes.get(data.token);
      if (prompts === undefined) {
        // The route that ran this git is gone; nobody is left to ask.
        res.writeHead(200);
        res.end(JSON.stringify(""));
        return;
      }
      prompts
        .input({
          placeholder: data.request,
          prompt: "GING: " + data.host,
          password: /password/i.test(data.request)
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

  /** Git run with the route's env asks `prompts`, not the default. */
  public route(prompts: Pick<Prompts, "input">): AskpassRoute {
    const token = getNonce();
    this.routes.set(token, prompts);
    const env = this.getEnv();
    return {
      // Without a server there is nothing to route: the no-op helper asks nobody.
      env: this.enabled ? { ...env, NEO_GIT_GRAPH_ASKPASS_TOKEN: token } : env,
      dispose: () => {
        this.routes.delete(token);
      }
    };
  }

  public getEnv(): AskpassEnvironment {
    return this.enabled
      ? {
          ELECTRON_RUN_AS_NODE: "1",
          GIT_ASKPASS: path.join(this.helperDir, "askpass.sh"),
          NEO_GIT_GRAPH_ASKPASS_NODE: process.execPath,
          NEO_GIT_GRAPH_ASKPASS_MAIN: path.join(this.helperDir, "askpassMain.js"),
          NEO_GIT_GRAPH_ASKPASS_HANDLE: this.ipcHandlePath
        }
      : {
          GIT_ASKPASS: path.join(this.helperDir, "askpass-empty.sh")
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
