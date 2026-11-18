import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { SeenRequest } from "./unauthorizedRemote";

export type GuardedRemote = {
  /** The guarded repository's URL for git. */
  url: string;
  /** Every request so far, in the order they arrived. */
  requests: SeenRequest[];
  close(): Promise<void>;
};

/** One CGI answer of git's, split into what HTTP needs. */
function cgiAnswer(output: Buffer): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const crlf = output.indexOf("\r\n\r\n");
  const end = crlf === -1 ? output.indexOf("\n\n") : crlf;
  const bodyStart = end + (crlf === -1 ? 2 : 4);
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, Math.max(end, 0)).toString("latin1").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, body: end === -1 ? Buffer.alloc(0) : output.subarray(bodyStart) };
}

/**
 * A git HTTP remote that asks for credentials and lets one pair in: the
 * #392 remote's 401 for any other request (ADR-0032: the network is local
 * only), and git's own smart HTTP server behind it, `git http-backend` run as
 * CGI on the repositories under `root`, so a fetch, a clone and a push let in
 * really do what they ask. A credential git sends is the one typed in the
 * app's prompt: the app's git has no credential helper (`isolatedGitEnv`).
 *
 * `env` is the backend's: the fixture's isolated git. Pushing is allowed, as
 * `http-backend` allows it to a user it is told was let in (`REMOTE_USER`).
 * Bound to 127.0.0.1, on a port the system picks.
 */
export async function startGuardedRemote(options: {
  root: string;
  repo: string;
  username: string;
  password: string;
  env: NodeJS.ProcessEnv;
}): Promise<GuardedRemote> {
  const { root, repo, username, password, env } = options;
  const letIn = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const requests: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization
    });
    if (req.headers.authorization !== letIn) {
      req.resume();
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="GING E2E"',
        "Content-Type": "text/plain"
      });
      res.end("Unauthorized\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // What a web server hands a CGI program: the request's line, its body's
    // type and length, and each header as HTTP_<NAME> — among them the
    // body's encoding and the protocol version git asks for.
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([name, value]) =>
        typeof value === "string"
          ? [[`HTTP_${name.toUpperCase().replaceAll("-", "_")}`, value]]
          : []
      )
    );
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...env,
        ...headers,
        GATEWAY_INTERFACE: "CGI/1.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        // Left out for a chunked body: http-backend then reads to its end.
        ...(req.headers["content-length"] === undefined
          ? {}
          : { CONTENT_LENGTH: req.headers["content-length"] }),
        REMOTE_ADDR: "127.0.0.1",
        REMOTE_USER: username,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1"
      },
      stdio: ["pipe", "pipe", "inherit"]
    });
    const output: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    req.pipe(backend.stdin);
    backend.on("close", () => {
      const answer = cgiAnswer(Buffer.concat(output));
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${repo}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // git may hold a keep-alive connection open; it must not hold the close.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
