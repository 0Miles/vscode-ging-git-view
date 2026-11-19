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
import type { ChooseAction, Prompts } from "@ging/core/host/ports";

export interface AskpassEnvironment {
  // Index signature so this is a valid env dict (assignable to NodeJS.ProcessEnv
  // when handed to the git client as extra child-process variables).
  [key: string]: string | undefined;
  GIT_ASKPASS: string;
  /** ssh's own prompts (a new host's key, a key's passphrase) go to the same
   *  helper: ssh reads these, not GIT_ASKPASS. */
  SSH_ASKPASS?: string;
  /** `force`: git runs ssh without a tty, where ssh would otherwise not ask. */
  SSH_ASKPASS_REQUIRE?: string;
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

/** What the manager asks with: a line of text for a credential, a choice for
 *  ssh's yes-or-no questions. */
export type AskpassPrompts = Pick<Prompts, "input" | "choose">;

/** The last line of OpenSSH's host key confirmation: `(yes/no)?` in older
 *  releases, `(yes/no/[fingerprint])?` since 8.0, `(yes/no):` elsewhere. */
const HOST_KEY_CONFIRMATION = /(?:\(yes\/no(?:\/\[fingerprint\])?\)\?|\(yes\/no\):)\s*$/;

/** OpenSSH's `ask_permission` questions (mux.c, for ControlMaster `ask` and
 *  `autoask`). ssh takes an empty answer to these as a yes, and only `no` or a
 *  failed helper as a no. */
const PERMISSION_QUESTION =
  /^(?:Allow (?:shared connection|forward) to |Terminate shared connection to |Disable further multiplexing on shared connection to |Open .+ on )[^\n]*\?\s*$/;

/** What a prompt masks: a password, a key's passphrase, a security key's or
 *  a PKCS#11 token's PIN. */
function isSecret(request: string): boolean {
  return /password|passphrase/i.test(request) || /\bPIN\b/.test(request);
}

/** A yes-or-no of ssh's as the `choose` that asks it, whose only action is
 *  `yes`; undefined for a line of text. The request is git's or ssh's prompt
 *  verbatim: which kind it is shows only in its text, since ssh sends no
 *  SSH_ASKPASS_PROMPT hint for either. */
function yesOrNo(
  request: string
): [message: string, options: { detail?: string; actions: ChooseAction<"yes">[] }] | undefined {
  if (HOST_KEY_CONFIRMATION.test(request)) {
    // A yes-or-no, not a line of text: a typo would only make ssh ask again.
    // The first line names the host; the helper's `host` can't, being cut at
    // the quote in "can't".
    const [message, ...rest] = request.split(/\r?\n/);
    return [
      message,
      { detail: rest.join("\n"), actions: [{ label: "Continue connecting", value: "yes" }] }
    ];
  }
  if (PERMISSION_QUESTION.test(request)) {
    return [request.trim(), { actions: [{ label: "Yes", value: "yes" }] }];
  }
  return undefined;
}

/** Runs a small IPC server that git's GIT_ASKPASS helper, and ssh's
 *  SSH_ASKPASS (the same helper), connect to; each request is put to the user
 *  through `Prompts.input` and the entered value is returned to git, except
 *  ssh's yes-or-no questions, each a `Prompts.choose` (see `yesOrNo`). When
 *  the server can't start, getEnv falls back to a no-op helper so git's own
 *  prompting is left untouched.
 *
 *  One server serves a whole process. Git run with `getEnv()` asks the
 *  prompts the manager was built with; a Host that asks in more than one place
 *  — the desktop host, one webview instance each — gives each its own `route`,
 *  whose env carries a token the helper sends back. */
export class AskpassManager {
  private readonly ipcHandlePath: string;
  private readonly server: http.Server;
  private enabled = true;
  private readonly routes = new Map<string, AskpassPrompts>();

  constructor(
    private readonly prompts: AskpassPrompts,
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
      const prompts = data.token === undefined ? this.prompts : this.routes.get(data.token);
      if (prompts === undefined) {
        // The route that ran this git is gone; nobody is left to ask. A
        // yes-or-no is a no: ssh takes an empty answer to some as a yes.
        res.writeHead(200);
        res.end(JSON.stringify(yesOrNo(data.request) ? "no" : ""));
        return;
      }
      ask(prompts, data).then(
        (result) => {
          res.writeHead(200);
          res.end(JSON.stringify(result));
        },
        () => {
          res.writeHead(500);
          res.end();
        }
      );
    });
  }

  /** Git run with the route's env asks `prompts`, not the default. */
  public route(prompts: AskpassPrompts): AskpassRoute {
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
    const helper = path.join(this.helperDir, "askpass.sh");
    return this.enabled
      ? {
          ELECTRON_RUN_AS_NODE: "1",
          GIT_ASKPASS: helper,
          SSH_ASKPASS: helper,
          SSH_ASKPASS_REQUIRE: "force",
          NEO_GIT_GRAPH_ASKPASS_NODE: process.execPath,
          NEO_GIT_GRAPH_ASKPASS_MAIN: path.join(this.helperDir, "askpassMain.js"),
          NEO_GIT_GRAPH_ASKPASS_HANDLE: this.ipcHandlePath
        }
      : {
          // No SSH_ASKPASS here: forced onto a helper that answers nothing, ssh
          // would take every prompt it could have asked on a tty as a no.
          GIT_ASKPASS: path.join(this.helperDir, "askpass-empty.sh")
        };
  }
}

/** Puts one request to `prompts`; resolves to what goes back to the helper. */
async function ask(prompts: AskpassPrompts, data: AskpassRequest): Promise<string> {
  const question = yesOrNo(data.request);
  // Dismissed is a no, not the empty answer ssh would take to some as a yes.
  if (question) return (await prompts.choose(...question)) ?? "no";
  const answer = await prompts.input({
    placeholder: data.request,
    prompt: "GING: " + data.host,
    password: isSecret(data.request)
  });
  return answer || "";
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
