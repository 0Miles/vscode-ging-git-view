import http from "node:http";
import type { AddressInfo } from "node:net";

/** A request the remote answered, as it arrived. */
export type SeenRequest = { method: string; url: string; authorization: string | undefined };

export type UnauthorizedRemote = {
  /** An HTTP remote's URL for git: a repository under this server. */
  url: string;
  /** Every request so far, in the order they arrived. */
  requests: SeenRequest[];
  /** Answer the requests held back, and every one after (`hold`). */
  release(): void;
  close(): Promise<void>;
};

/**
 * An HTTP remote that lets nobody in (ADR-0032: the network is local only).
 * A local path or a `file://` remote never asks for credentials, so the only
 * way to make git run its askpass is a server that says 401: this one answers
 * every request so, with a `WWW-Authenticate: Basic` challenge, credentials or
 * not. Whatever else git sends besides `info/refs` (a `HEAD /`, say) gets the
 * same answer and is recorded too; a test reads the requests it is about.
 *
 * Bound to 127.0.0.1, on a port the system picks. With `hold`, no request is
 * answered until `release()`: git waits on its first one meanwhile, before it
 * has asked for anything (#461).
 */
export async function startUnauthorizedRemote({ hold = false } = {}): Promise<UnauthorizedRemote> {
  const requests: SeenRequest[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  if (!hold) release();
  const server = http.createServer(async (req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization
    });
    // Read whatever body came, so the connection is left in a state to answer.
    req.resume();
    await released;
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="GING E2E"',
      "Content-Type": "text/plain"
    });
    res.end("Unauthorized\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    requests,
    release,
    close: () =>
      new Promise<void>((resolve) => {
        // git may hold a keep-alive connection open; it must not hold the close.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
