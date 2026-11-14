import * as http from "node:http";
import * as os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { AskpassManager } from "@ging/core/extension/askpass/askpassManager";
import type { Prompts } from "@ging/core/host/ports";

// The host half of GIT_ASKPASS: git's helper posts the prompt it was given to
// the manager's IPC handle and writes whatever comes back to git. Driven here
// the way `askpassMain` drives it, with the user's answer from a fake prompt.

type InputOptions = Parameters<Prompts["input"]>[0];

let manager: AskpassManager | undefined;
afterEach(() => manager?.dispose());

function ask(
  socketPath: string,
  body: { request: string; host: string; token?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/", method: "POST" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function start(answer: (options: InputOptions) => PromiseLike<string | undefined>) {
  const asked: InputOptions[] = [];
  manager = new AskpassManager(
    {
      input: (options) => {
        asked.push(options);
        return answer(options);
      }
    },
    os.tmpdir()
  );
  return { asked, handle: manager.getEnv().NEO_GIT_GRAPH_ASKPASS_HANDLE! };
}

describe("AskpassManager", () => {
  it("puts git's prompt to the user, masked for a password, and returns the answer", async () => {
    const { asked, handle } = start(async () => "s3cret");
    const res = await ask(handle, { request: "Password for 'https://me@host':", host: "host" });
    expect(asked).toEqual([
      { placeholder: "Password for 'https://me@host':", prompt: "GING: host", password: true }
    ]);
    expect(res).toEqual({ status: 200, body: JSON.stringify("s3cret") });
  });

  it("does not mask a username prompt", async () => {
    const { asked, handle } = start(async () => "me");
    await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(asked[0].password).toBe(false);
  });

  it("answers a cancelled prompt with an empty string", async () => {
    const { handle } = start(async () => undefined);
    const res = await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(res).toEqual({ status: 200, body: JSON.stringify("") });
  });

  it("answers a prompt that failed with an error status", async () => {
    const { handle } = start(() => Promise.reject(new Error("no UI")));
    const res = await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(res.status).toBe(500);
  });

  // One server for the whole process, each git run asking whoever started it
  // (the desktop host's webview instances, #388): the route's env carries a
  // token that the helper sends back.
  it("puts a prompt to the route whose token it carries, not to the default", async () => {
    const { asked: toDefault, handle } = start(async () => "default");
    const toRoute: InputOptions[] = [];
    const route = manager!.route({
      input: async (options) => {
        toRoute.push(options);
        return "routed";
      }
    });

    const res = await ask(handle, {
      request: "Username for 'https://host':",
      host: "host",
      token: route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });

    expect(res).toEqual({ status: 200, body: JSON.stringify("routed") });
    expect(toRoute).toHaveLength(1);
    expect(toDefault).toEqual([]);
    expect(route.env.NEO_GIT_GRAPH_ASKPASS_HANDLE).toBe(handle);
  });

  it("gives each route a token of its own", () => {
    start(async () => undefined);
    const tokens = [
      manager!.route({ input: async () => undefined }),
      manager!.route({ input: async () => undefined })
    ].map((route) => route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN);
    expect(new Set(tokens).size).toBe(2);
    expect(manager!.getEnv().NEO_GIT_GRAPH_ASKPASS_TOKEN).toBeUndefined();
  });

  it("answers a prompt for a route that is gone as cancelled, asking nobody", async () => {
    const { asked, handle } = start(async () => "default");
    const gone = manager!.route({ input: async () => "routed" });
    gone.dispose();

    const res = await ask(handle, {
      request: "Username for 'https://host':",
      host: "host",
      token: gone.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });

    expect(res).toEqual({ status: 200, body: JSON.stringify("") });
    expect(asked).toEqual([]);
  });

  it("points git at the helpers in the folder it was given", () => {
    start(async () => undefined);
    const env = manager!.getEnv();
    expect(env.GIT_ASKPASS).toMatch(/askpass\.sh$/);
    expect(env.GIT_ASKPASS!.startsWith(os.tmpdir())).toBe(true);
    expect(env.NEO_GIT_GRAPH_ASKPASS_MAIN!.startsWith(os.tmpdir())).toBe(true);
  });
});
