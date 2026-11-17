import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type StallingRemote = {
  /** An HTTP remote's URL for git: a repository under this server. */
  url: string;
  /** How many requests have arrived so far. */
  requests(): number;
  /** How many connections are open to it now: one is git's for as long as
   *  anything of git's is alive to hold it. */
  connections(): number;
  close(): Promise<void>;
};

/**
 * An HTTP remote that never answers (ADR-0032: the network is local only):
 * git's first request hangs there for as long as git does, so a clone of it
 * runs until it is cancelled. Bound to 127.0.0.1, on a port the system picks.
 * Its open connections are counted: a git that was killed, and every process
 * of git's with it, holds none.
 */
export async function startStallingRemote(): Promise<StallingRemote> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = http.createServer((req) => {
    requests += 1;
    // Read what came, and answer nothing.
    req.resume();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    requests: () => requests,
    connections: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
